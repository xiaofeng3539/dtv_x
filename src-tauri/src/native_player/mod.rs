use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

#[cfg(windows)]
pub mod runtime;

#[derive(Default)]
pub struct NativePlayerState {
    #[cfg(windows)]
    service: std::sync::Mutex<Option<std::sync::Arc<runtime::PlayerService>>>,
    #[cfg(windows)]
    initialization: tokio::sync::Mutex<()>,
    #[cfg(windows)]
    surface: std::sync::Mutex<Option<surface::Surface>>,
}

#[cfg(windows)]
mod surface {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(ex:u32,class:*const u16,name:*const u16,style:u32,x:i32,y:i32,w:i32,h:i32,parent:*mut c_void,menu:*mut c_void,instance:*mut c_void,param:*mut c_void)->*mut c_void;
        fn SetWindowPos(hwnd:*mut c_void,after:*mut c_void,x:i32,y:i32,w:i32,h:i32,flags:u32)->i32;
        fn SetLayeredWindowAttributes(hwnd:*mut c_void,color:u32,alpha:u8,flags:u32)->i32;
        fn ClientToScreen(hwnd:*mut c_void,point:*mut Point)->i32;
        fn IsWindowVisible(hwnd:*mut c_void)->i32;
        fn IsIconic(hwnd:*mut c_void)->i32;
        fn ShowWindow(hwnd:*mut c_void,command:i32)->i32;
        fn DestroyWindow(hwnd:*mut c_void)->i32;
    }
    #[repr(C)] struct Point { x:i32, y:i32 }
    fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
    pub struct Surface {
        pub hwnd:usize,
        pub generation:u64,
        pub rect:(i32,i32,i32,i32),
        pub visible:bool,
        pub pip:bool,
    }
    impl Surface {
        // All methods that touch HWNDs are called on Tauri's UI thread.
        pub fn create()->Result<Self,String>{unsafe{
            let hwnd=CreateWindowExW(0x08000000|0x80|0x80000|0x20,wide("STATIC").as_ptr(),wide("DTV native video").as_ptr(),0x80000004,0,0,1,1,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut());
            if hwnd.is_null(){return Err(format!("Native video surface: {}",std::io::Error::last_os_error()));}
            SetLayeredWindowAttributes(hwnd,0,255,2);
            Ok(Self{hwnd:hwnd as usize,generation:0,rect:(0,0,1,1),visible:false,pip:false})
        }}
        pub fn hide(&self){unsafe{ShowWindow(self.hwnd as *mut c_void,0);}}
        pub fn is_visible(&self)->bool{unsafe{IsWindowVisible(self.hwnd as *mut c_void)!=0}}
        pub fn sync(&self,parent:usize,rect:Option<(i32,i32,i32,i32)>){unsafe{
            if !self.visible || IsIconic(parent as *mut c_void)!=0 || IsWindowVisible(parent as *mut c_void)==0 {self.hide();return;}
            let (x,y,w,h)=rect.unwrap_or(self.rect);
            if w<=0||h<=0{self.hide();return;}
            let mut point=Point{x,y};ClientToScreen(parent as *mut c_void,&mut point);
            SetWindowPos(self.hwnd as *mut c_void,parent as *mut c_void,point.x,point.y,w,h,0x10|0x40);
        }}
        pub fn destroy(self){unsafe{DestroyWindow(self.hwnd as *mut c_void);}}
    }
}

#[cfg(windows)]
async fn blocking<T:Send+'static>(f:impl FnOnce()->Result<T,String>+Send+'static)->Result<T,String>{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e|e.to_string())?
}

#[cfg(windows)]
async fn ensure_service(app:&AppHandle,window:&WebviewWindow)->Result<std::sync::Arc<runtime::PlayerService>,String>{
    let state=app.state::<NativePlayerState>();
    let _initialization=state.initialization.lock().await;
    if let Some(service)=state.service.lock().map_err(|e|e.to_string())?.clone(){return Ok(service);}
    let owner=app.clone();
    let (send,recv)=tokio::sync::oneshot::channel();
    window.run_on_main_thread(move||{
        let result: Result<usize,String>=(||{
            let state=owner.state::<NativePlayerState>();
            let mut slot=state.surface.lock().map_err(|e|e.to_string())?;
            if slot.is_none(){*slot=Some(surface::Surface::create()?);}
            Ok(slot.as_ref().unwrap().hwnd)
        })();let _=send.send(result);
    }).map_err(|e|e.to_string())?;
    let hwnd=recv.await.map_err(|e|e.to_string())??;
    let mut dll=app.path().resource_dir().map_err(|e|e.to_string())?.join("libmpv/libmpv-2.dll");
    #[cfg(debug_assertions)]
    if !dll.is_file(){dll=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/libmpv/libmpv-2.dll");}
    let events=app.clone();
    let service=blocking(move||runtime::PlayerService::start(dll,runtime::Output::Window(hwnd),move|snapshot|{
        let _=events.emit("native-player-state",snapshot);
    }).map(std::sync::Arc::new)).await?;
    *state.service.lock().map_err(|e|e.to_string())?=Some(service.clone());
    Ok(service)
}

/// Call after host move/resize/focus/show/hide. No decoder work is done on the UI thread.
pub fn sync_window(app:&AppHandle){
    #[cfg(windows)] {
        let state=app.state::<NativePlayerState>();
        if let Ok(slot)=state.surface.lock(){if let Some(surface)=slot.as_ref(){
            let label=if surface.pip{"native-pip"}else{"main"};
            if let Some(host)=app.get_webview_window(label){
                if let Ok(hwnd)=host.hwnd(){
                    let rect=if surface.pip{host.inner_size().ok().map(|s|(0,0,s.width as i32,s.height as i32))}else{None};
                    surface.sync(hwnd.0 as usize,rect);
                }
            }else{surface.hide();}
        }};
    }
}

pub fn window_event(window:&tauri::Window,event:&WindowEvent){
    if window.label()=="native-pip" && matches!(event,WindowEvent::CloseRequested{..}|WindowEvent::Destroyed){
        #[cfg(windows)] {
            let state=window.state::<NativePlayerState>();
            if let Ok(mut slot)=state.surface.lock(){if let Some(surface)=slot.as_mut(){
                if surface.pip {
                    surface.pip=false;
                    let _=window.emit("native-player-pip",serde_json::json!({"generation":surface.generation,"enabled":false}));
                    let _=window.app_handle().emit("native-player-pip",serde_json::json!({"generation":surface.generation,"enabled":false}));
                }
            }};
        }
    }
    sync_window(window.app_handle());
}

pub fn shutdown(app:&AppHandle){
    #[cfg(windows)] {
        let state=app.state::<NativePlayerState>();
        if let Ok(mut slot)=state.surface.lock(){if let Some(surface)=slot.take(){surface.hide();surface.destroy();}}
        if let Ok(mut service)=state.service.lock(){service.take();};
    }
}

#[tauri::command]
pub async fn native_player_open(app:AppHandle,window:WebviewWindow,generation:u64,url:String,headers:BTreeMap<String,String>)->Result<(),String>{
    #[cfg(windows)] {
        let service=ensure_service(&app,&window).await?;
        blocking(move||service.open(generation,runtime::Media{url,headers})).await?;
        let ui=app.clone();window.run_on_main_thread(move||{
            let state=ui.state::<NativePlayerState>();
            if let Ok(mut slot)=state.surface.lock(){if let Some(s)=slot.as_mut(){if generation>=s.generation{s.generation=generation;s.visible=true;}}};
            sync_window(&ui);
        }).map_err(|e|e.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))] Err("Native libmpv playback is currently available on Windows".into())
}

#[tauri::command]
pub fn native_player_rect(app:AppHandle,window:WebviewWindow,generation:u64,x:i32,y:i32,width:i32,height:i32)->Result<(),String>{
    #[cfg(windows)] {
        window.run_on_main_thread(move||{
            let state=app.state::<NativePlayerState>();
            if let Ok(mut slot)=state.surface.lock(){if let Some(s)=slot.as_mut(){if s.generation==generation{s.rect=(x,y,width,height);}}};
            sync_window(&app);
        }).map_err(|e|e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
async fn control(app:AppHandle,generation:u64,kind:&'static str,value:f64)->Result<(),String>{
    let service=app.state::<NativePlayerState>().service.lock().map_err(|e|e.to_string())?.clone();
    if let Some(service)=service{blocking(move||match kind{
        "pause"=>service.set_pause(generation,value!=0.0),"volume"=>service.set_volume(generation,value),
        "muted"=>service.set_muted(generation,value!=0.0),"stop"=>service.stop(generation),_=>Err("Unknown native operation".into()),
    }).await?;}Ok(())
}

#[tauri::command]
pub async fn native_player_pause(app:AppHandle,generation:u64,paused:bool)->Result<(),String>{
    #[cfg(windows)] control(app,generation,"pause",if paused{1.0}else{0.0}).await?;Ok(())
}
#[tauri::command]
pub async fn native_player_volume(app:AppHandle,generation:u64,volume:f64)->Result<(),String>{
    #[cfg(windows)] control(app,generation,"volume",volume).await?;Ok(())
}
#[tauri::command]
pub async fn native_player_muted(app:AppHandle,generation:u64,muted:bool)->Result<(),String>{
    #[cfg(windows)] control(app,generation,"muted",if muted{1.0}else{0.0}).await?;Ok(())
}

#[tauri::command]
pub async fn native_player_snapshot(app:AppHandle)->Result<serde_json::Value,String>{
    #[cfg(windows)] {
        let state=app.state::<NativePlayerState>();
        let service=state.service.lock().map_err(|e|e.to_string())?.clone();
        let (pip,visible)=state.surface.lock().map_err(|e|e.to_string())?.as_ref().map(|s|(s.pip,s.is_visible())).unwrap_or((false,false));
        if let Some(service)=service{
            return blocking(move||{let mut snapshot=serde_json::to_value(service.snapshot()?).map_err(|e|e.to_string())?;snapshot["pip"]=serde_json::json!(pip);snapshot["surfaceVisible"]=serde_json::json!(visible);Ok(snapshot)}).await;
        }
    }
    Ok(serde_json::json!({"generation":0,"loaded":false,"pip":false}))
}

#[tauri::command]
pub async fn native_player_pip(app:AppHandle,window:WebviewWindow,generation:u64,enabled:bool)->Result<(),String>{
    #[cfg(windows)] {
        let (send,recv)=tokio::sync::oneshot::channel();
        window.run_on_main_thread(move||{
            let result=(||{
                let state=app.state::<NativePlayerState>();
                let active=state.surface.lock().map_err(|e|e.to_string())?.as_ref().map(|s|s.generation==generation).unwrap_or(false);
                if !active{return Ok(());}
                if enabled && app.get_webview_window("native-pip").is_none(){
                    tauri::WebviewWindowBuilder::new(&app,"native-pip",tauri::WebviewUrl::App("native-pip.html".into()))
                        .title("DTV 画中画").inner_size(480.0,270.0).min_inner_size(280.0,160.0)
                        .transparent(true).background_color(tauri::webview::Color(0,0,0,0)).decorations(false)
                        .always_on_top(true).skip_taskbar(true).build().map_err(|e|e.to_string())?;
                }
                if let Some(s)=state.surface.lock().map_err(|e|e.to_string())?.as_mut(){s.pip=enabled;}
                sync_window(&app);
                if !enabled {if let Some(pip)=app.get_webview_window("native-pip"){let _=pip.close();}}
                let _=app.emit("native-player-pip",serde_json::json!({"generation":generation,"enabled":enabled}));
                Ok(())
            })();let _=send.send(result);
        }).map_err(|e|e.to_string())?;
        return recv.await.map_err(|e|e.to_string())?;
    }
    #[cfg(not(windows))] Err("Native PiP requires Windows".into())
}

#[tauri::command]
pub async fn native_player_stop(app:AppHandle,window:WebviewWindow,generation:u64)->Result<(),String>{
    #[cfg(windows)] {
        let ui=app.clone();window.run_on_main_thread(move||{
            let state=ui.state::<NativePlayerState>();let mut close_pip=false;
            if let Ok(mut slot)=state.surface.lock(){if let Some(s)=slot.as_mut(){if s.generation==generation{s.visible=false;s.hide();close_pip=s.pip;s.pip=false;}}};
            if close_pip{if let Some(pip)=ui.get_webview_window("native-pip"){let _=pip.close();}}
        }).map_err(|e|e.to_string())?;
        control(app,generation,"stop",0.0).await?;
    }
    Ok(())
}
