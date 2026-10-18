//! libmpv owns network, demux and decode. All handle access stays on one worker.
//! The window owner is responsible for creating/destroying the supplied HWND.
use std::{
    collections::BTreeMap,
    ffi::{c_char, c_void, CStr, CString, OsStr},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct Media {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}
impl Media {
    fn validate(&self) -> Result<(), String> {
        if self.url.trim().is_empty() || self.url.contains('\0') {
            return Err("Invalid media URL".into());
        }
        for (name, value) in &self.headers {
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                || value.contains(['\r', '\n', '\0']) {
                return Err("Invalid media header".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub enum Output { Window(usize), Headless }

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub generation: u64,
    pub loaded: bool,
    pub paused: bool,
    pub buffering: bool,
    pub ended: bool,
    pub position: Option<f64>,
    pub cache_end: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub volume: f64,
    pub muted: bool,
    pub error: Option<String>,
}

enum Action { Open(Media), Stop, Pause(bool), Volume(f64), Muted(bool), Snapshot, Shutdown }
struct Request { generation: u64, action: Action, reply: mpsc::SyncSender<Result<Snapshot, String>> }

pub struct PlayerService {
    sender: mpsc::Sender<Request>,
    latest: Arc<AtomicU64>,
    worker: Option<JoinHandle<()>>,
}
impl PlayerService {
    pub fn start(dll: PathBuf, output: Output, notify: impl Fn(Snapshot) + Send + 'static) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel::<Request>();
        let (ready, initialized) = mpsc::sync_channel(1);
        let latest = Arc::new(AtomicU64::new(0));
        let worker_latest = latest.clone();
        let worker = thread::Builder::new().name("dtv-libmpv".into()).spawn(move || {
            let mut core = match Core::new(dll, output) {
                Ok(core) => { let _ = ready.send(Ok(())); core }
                Err(error) => { let _ = ready.send(Err(error)); return; }
            };
            let mut emitted = Instant::now();
            loop {
                match receiver.recv_timeout(Duration::from_millis(25)) {
                    Ok(request) => {
                        if matches!(request.action, Action::Shutdown) {
                            let result = core.stop().map(|_| core.snapshot());
                            let _ = request.reply.send(result);
                            break;
                        }
                        let result = if matches!(request.action, Action::Snapshot) {
                            Ok(core.snapshot())
                        } else if request.generation != worker_latest.load(Ordering::SeqCst)
                            || (!matches!(request.action, Action::Open(_)) && request.generation != core.state.generation) {
                            // A delayed close/pause/open from the old room cannot affect the new one.
                            Ok(core.snapshot())
                        } else {
                            core.execute(request.generation, request.action).map(|_| core.snapshot())
                        };
                        let _ = request.reply.send(result);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                core.events();
                if emitted.elapsed() >= Duration::from_millis(200) {
                    let state = core.snapshot();
                    // A failed UI subscriber must not kill decoding or the command queue.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| notify(state)));
                    emitted = Instant::now();
                }
            }
        }).map_err(|e| e.to_string())?;
        match initialized.recv_timeout(Duration::from_secs(15)).map_err(|e| format!("libmpv initialization: {e}"))? {
            Ok(()) => Ok(Self { sender, latest, worker: Some(worker) }),
            Err(error) => { let _ = worker.join(); Err(error) }
        }
    }
    fn request(&self, generation: u64, action: Action) -> Result<Snapshot, String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender.send(Request { generation, action, reply }).map_err(|_| "libmpv worker stopped".to_string())?;
        response.recv_timeout(Duration::from_secs(15)).map_err(|e| format!("libmpv operation: {e}"))?
    }
    pub fn open(&self, generation: u64, media: Media) -> Result<(), String> {
        media.validate()?;
        if generation == 0 { return Err("Media generation must be positive".into()); }
        let previous = self.latest.fetch_max(generation, Ordering::SeqCst);
        if generation < previous { return Ok(()); }
        self.request(generation, Action::Open(media)).map(|_| ())
    }
    pub fn stop(&self, generation: u64) -> Result<(), String> { self.request(generation, Action::Stop).map(|_| ()) }
    pub fn set_pause(&self, generation: u64, pause: bool) -> Result<(), String> { self.request(generation, Action::Pause(pause)).map(|_| ()) }
    pub fn set_volume(&self, generation: u64, volume: f64) -> Result<(), String> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) { return Err("Invalid volume".into()); }
        self.request(generation, Action::Volume(volume)).map(|_| ())
    }
    pub fn set_muted(&self, generation: u64, muted: bool) -> Result<(), String> { self.request(generation, Action::Muted(muted)).map(|_| ()) }
    pub fn snapshot(&self) -> Result<Snapshot, String> { self.request(0, Action::Snapshot) }
    pub fn shutdown(mut self) -> Result<(), String> {
        let result = self.request(0, Action::Shutdown).map(|_| ());
        if let Some(worker) = self.worker.take() { worker.join().map_err(|_| "libmpv worker panicked".to_string())?; }
        result
    }
}
impl Drop for PlayerService {
    fn drop(&mut self) {
        // Dropping application state never waits for decoder shutdown on the UI thread.
        if self.worker.is_some() {
            let (reply, _) = mpsc::sync_channel(1);
            let _ = self.sender.send(Request { generation: 0, action: Action::Shutdown, reply });
        }
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn GetModuleHandleExW(flags: u32, address: *const u16, module: *mut *mut c_void) -> i32;
}
struct Library(*mut c_void);
impl Drop for Library { fn drop(&mut self) { unsafe { FreeLibrary(self.0); } } }
impl Library {
    unsafe fn symbol<T: Copy>(&self, name: &str) -> Result<T, String> {
        let key = CString::new(name).map_err(|e| e.to_string())?;
        let address = GetProcAddress(self.0, key.as_ptr());
        if address.is_null() { return Err(format!("libmpv missing export: {name}")); }
        Ok(std::mem::transmute_copy(&address))
    }
}
#[repr(C)]
struct Event { id: i32, error: i32, userdata: u64, data: *mut c_void }
#[repr(C)]
struct EndFile { reason: i32, error: i32, entry: i64, insert_id: i64, insert_count: i32 }
#[repr(C)]
union NodeValue { string: *mut c_char, list: *mut NodeList, int64: i64 }
#[repr(C)]
struct Node { value: NodeValue, format: i32 }
#[repr(C)]
struct NodeList { count: i32, values: *mut Node, keys: *mut *mut c_char }
type Create = unsafe extern "C" fn() -> *mut c_void;
type Initialize = unsafe extern "C" fn(*mut c_void) -> i32;
type SetString = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type SetProperty = unsafe extern "C" fn(*mut c_void, *const c_char, i32, *mut c_void) -> i32;
type GetString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type Command = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> i32;
type Wait = unsafe extern "C" fn(*mut c_void, f64) -> *const Event;
type Free = unsafe extern "C" fn(*mut c_void);
type Destroy = unsafe extern "C" fn(*mut c_void);
type ErrorString = unsafe extern "C" fn(i32) -> *const c_char;
struct Api {
    library: Library, create: Create, initialize: Initialize, option: SetString,
    set: SetString, set_property: SetProperty, get: GetString, command: Command,
    wait: Wait, free: Free, destroy: Destroy, error: ErrorString,
}
impl Api {
    fn load(path: PathBuf) -> Result<Self, String> {
        let path = path.canonicalize().map_err(|e| format!("libmpv DLL {}: {e}", path.display()))?;
        let wide: Vec<u16> = OsStr::new(&path).encode_wide().chain(Some(0)).collect();
        unsafe {
            // Absolute path and restricted dependency search; never search the current directory.
            let library = Library(LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x100 | 0x1000));
            if library.0.is_null() { return Err(format!("libmpv DLL load: {}", std::io::Error::last_os_error())); }
            let version: unsafe extern "C" fn() -> u32 = library.symbol("mpv_client_api_version")?;
            let version = version();
            if version >> 16 != 2 || version & 0xffff < 1 { return Err(format!("Unsupported libmpv client API: {version:#x}")); }
            Ok(Self {
                create: library.symbol("mpv_create")?, initialize: library.symbol("mpv_initialize")?,
                option: library.symbol("mpv_set_option_string")?, set: library.symbol("mpv_set_property_string")?,
                set_property: library.symbol("mpv_set_property")?, get: library.symbol("mpv_get_property_string")?,
                command: library.symbol("mpv_command")?, wait: library.symbol("mpv_wait_event")?,
                free: library.symbol("mpv_free")?, destroy: library.symbol("mpv_terminate_destroy")?,
                error: library.symbol("mpv_error_string")?, library,
            })
        }
    }
    fn check(&self, code: i32, operation: &str) -> Result<(), String> {
        if code >= 0 { return Ok(()); }
        let error = unsafe { CStr::from_ptr((self.error)(code)) }.to_string_lossy();
        Err(format!("libmpv {operation}: {error} ({code})"))
    }
}
struct Core { api: Api, handle: *mut c_void, state: Snapshot, entry: Option<i64>, active: bool }
impl Drop for Core { fn drop(&mut self) { unsafe { (self.api.destroy)(self.handle); } } }
impl Core {
    fn new(dll: PathBuf, output: Output) -> Result<Self, String> {
        let api = Api::load(dll)?;
        let handle = unsafe { (api.create)() };
        if handle.is_null() { return Err("libmpv mpv_create returned null".into()); }
        let core = Self { api, handle, state: Snapshot { volume: 1.0, ..Snapshot::default() }, entry: None, active: false };
        for (name, value) in [
            ("config", "no"), ("terminal", "no"), ("idle", "yes"), ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"), ("cache-on-disk", "no"), ("cache-secs", "8"),
            ("cache-pause", "yes"), ("cache-pause-wait", "2"), ("demuxer-max-back-bytes", "4194304"),
            ("network-timeout", "10"), ("hwdec", "auto-safe"),
        ] { core.option(name, value)?; }
        match output {
            Output::Window(hwnd) => {
                if hwnd == 0 { return Err("Invalid libmpv video HWND".into()); }
                core.option("wid", &hwnd.to_string())?;
                core.option("vo", "gpu")?; core.option("gpu-api", "d3d11")?;
            }
            Output::Headless => { core.option("vo", "null")?; core.option("ao", "null")?; }
        }
        unsafe {
            core.api.check((core.api.initialize)(core.handle), "initialize")?;
            // mpv registers window classes whose callbacks live in this module. Keep it
            // mapped until process exit, including across failed/retried player sessions.
            let mut pinned = std::ptr::null_mut();
            if GetModuleHandleExW(0x1 | 0x4, core.api.library.0.cast(), &mut pinned) == 0 {
                return Err(format!("libmpv module pin: {}", std::io::Error::last_os_error()));
            }
        }
        Ok(core)
    }
    fn option(&self, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|e|e.to_string())?;
        let value = CString::new(value).map_err(|e|e.to_string())?;
        self.api.check(unsafe { (self.api.option)(self.handle, name.as_ptr(), value.as_ptr()) }, "option")
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|e|e.to_string())?;
        let value = CString::new(value).map_err(|e|e.to_string())?;
        self.api.check(unsafe { (self.api.set)(self.handle, name.as_ptr(), value.as_ptr()) }, "property")
    }
    fn get(&self, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        unsafe {
            let ptr = (self.api.get)(self.handle, name.as_ptr());
            if ptr.is_null() { return None; }
            let value = CStr::from_ptr(ptr).to_string_lossy().into_owned();
            (self.api.free)(ptr.cast()); Some(value)
        }
    }
    fn number(&self, name: &str) -> Option<f64> { self.get(name)?.parse::<f64>().ok().filter(|v|v.is_finite()) }
    fn command(&self, args: &[&str]) -> Result<(), String> {
        let values = args.iter().map(|v|CString::new(*v).map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?;
        let mut args = values.iter().map(|v|v.as_ptr()).collect::<Vec<_>>(); args.push(std::ptr::null());
        self.api.check(unsafe { (self.api.command)(self.handle, args.as_ptr()) }, "command")
    }
    fn headers(&self, headers: &BTreeMap<String, String>) -> Result<(), String> {
        // A node array avoids comma/list-option parsing and preserves cookies verbatim.
        let strings = headers.iter().map(|(k,v)|CString::new(format!("{k}: {v}")).map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?;
        let mut values = strings.iter().map(|s|Node { value: NodeValue { string: s.as_ptr().cast_mut() }, format: 1 }).collect::<Vec<_>>();
        let mut list = NodeList { count: values.len() as i32, values: values.as_mut_ptr(), keys: std::ptr::null_mut() };
        let mut node = Node { value: NodeValue { list: &mut list }, format: 7 };
        let name = CString::new("http-header-fields").unwrap();
        self.api.check(unsafe { (self.api.set_property)(self.handle, name.as_ptr(), 6, (&mut node as *mut Node).cast()) }, "media headers")
    }
    fn stop(&mut self) -> Result<(), String> {
        self.command(&["stop"])?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.get("idle-active").as_deref() != Some("yes") {
            self.events();
            if Instant::now() >= deadline { return Err("libmpv stop did not reach idle".into()); }
            thread::sleep(Duration::from_millis(5));
        }
        self.command(&["playlist-clear"])?;
        self.events();
        self.active = false; self.entry = None;
        self.state = Snapshot { generation: self.state.generation, volume: self.state.volume, muted: self.state.muted, ..Snapshot::default() };
        Ok(())
    }
    fn execute(&mut self, generation: u64, action: Action) -> Result<(), String> {
        match action {
            Action::Open(media) => {
                self.stop()?;
                self.state.generation = generation;
                self.headers(&media.headers)?;
                self.set("pause", "no")?;
                self.command(&["loadfile", &media.url, "replace"])?;
                self.active = true; self.state.buffering = true;
            }
            Action::Stop => self.stop()?,
            Action::Pause(value) => self.set("pause", if value {"yes"} else {"no"})?,
            Action::Volume(value) => self.set("volume", &(value * 100.0).to_string())?,
            Action::Muted(value) => self.set("mute", if value {"yes"} else {"no"})?,
            Action::Snapshot | Action::Shutdown => {}
        }
        Ok(())
    }
    fn events(&mut self) {
        loop {
            let event = unsafe { (self.api.wait)(self.handle, 0.0) };
            if event.is_null() { break; }
            let event = unsafe { &*event };
            match event.id {
                0 => break,
                6 if self.active && !event.data.is_null() => self.entry = Some(unsafe { *event.data.cast::<i64>() }),
                8 if self.active => { self.state.loaded = true; self.state.buffering = false; }
                7 if self.active && !event.data.is_null() => {
                    let end = unsafe { &*event.data.cast::<EndFile>() };
                    if self.entry == Some(end.entry) && end.reason != 5 {
                        self.state.loaded = false; self.state.buffering = false;
                        self.state.ended = end.reason == 0;
                        if end.reason == 4 { self.state.error = self.api.check(end.error, "playback").err().or(Some("libmpv playback failed".into())); }
                        self.active = false;
                    }
                }
                _ => {}
            }
        }
    }
    fn snapshot(&mut self) -> Snapshot {
        self.events();
        self.state.paused = self.get("pause").as_deref() == Some("yes");
        self.state.volume = self.number("volume").unwrap_or(self.state.volume * 100.0) / 100.0;
        self.state.muted = self.get("mute").as_deref() == Some("yes");
        if self.active {
            self.state.position = self.number("time-pos");
            self.state.cache_end = self.number("demuxer-cache-time");
            self.state.width = self.number("dwidth").map(|v|v as u32);
            self.state.height = self.number("dheight").map(|v|v as u32);
            self.state.buffering = !self.state.loaded || self.get("paused-for-cache").as_deref() == Some("yes");
        }
        self.state.clone()
    }
}
