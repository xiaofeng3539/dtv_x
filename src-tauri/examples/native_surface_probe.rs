// 独立验收程序；正式 DTV 尚未启用。使用正式原生 worker，避免探针与产品实现分叉。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
#[path = "../src/native_player/runtime.rs"]
mod runtime;
#[cfg(windows)]
mod probe {
    use super::runtime::{Media, Output, PlayerService};
    use std::{collections::BTreeMap, ffi::c_void, sync::{Arc, Mutex}};
    use tauri::Manager;
    #[link(name="user32")]
    extern "system" {
        fn CreateWindowExW(ex:u32,class:*const u16,name:*const u16,style:u32,x:i32,y:i32,w:i32,h:i32,parent:*mut c_void,menu:*mut c_void,instance:*mut c_void,param:*mut c_void)->*mut c_void;
        fn SetWindowPos(hwnd:*mut c_void,after:*mut c_void,x:i32,y:i32,w:i32,h:i32,flags:u32)->i32;
        fn SetLayeredWindowAttributes(hwnd:*mut c_void,color:u32,alpha:u8,flags:u32)->i32;
        fn ClientToScreen(hwnd:*mut c_void,point:*mut Point)->i32;
        fn WindowFromPoint(point:Point)->*mut c_void;
        fn GetAncestor(hwnd:*mut c_void,flags:u32)->*mut c_void;
        fn GetClassNameW(hwnd:*mut c_void,name:*mut u16,size:i32)->i32;
        fn GetWindowTextW(hwnd:*mut c_void,name:*mut u16,size:i32)->i32;
        fn GetForegroundWindow()->*mut c_void;
        fn IsWindowVisible(hwnd:*mut c_void)->i32;
        fn IsIconic(hwnd:*mut c_void)->i32;
        fn ShowWindow(hwnd:*mut c_void,command:i32)->i32;
        fn DestroyWindow(hwnd:*mut c_void)->i32;
    }
    #[repr(C)] struct Point {x:i32,y:i32}
    fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
    struct Native { service:PlayerService, generation:u64, surface:usize, parent:usize, rect:(i32,i32,i32,i32), stopped:bool }
    #[derive(Default)] pub struct State(Arc<Mutex<Option<Native>>>);
    unsafe fn place(player:&Native) {
        if player.stopped || IsIconic(player.parent as *mut c_void)!=0 || IsWindowVisible(player.parent as *mut c_void)==0 {
            ShowWindow(player.surface as *mut c_void,0); return;
        }
        let (x,y,w,h)=player.rect;
        let mut point=Point{x,y}; ClientToScreen(player.parent as *mut c_void,&mut point);
        SetWindowPos(player.surface as *mut c_void,player.parent as *mut c_void,point.x,point.y,w.max(1),h.max(1),0x10|0x40);
    }
    async fn blocking<T:Send+'static>(f:impl FnOnce()->Result<T,String>+Send+'static)->Result<T,String>{
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e|e.to_string())?
    }
    #[tauri::command]
    async fn probe_start(window:tauri::WebviewWindow,state:tauri::State<'_,State>,generation:Option<u64>,url:Option<String>,headers:Option<BTreeMap<String,String>>)->Result<String,String>{
        let shared=state.0.clone();
        let parent=window.hwnd().map_err(|e|e.to_string())?.0 as usize;
        if shared.lock().unwrap().is_none() {
            let (send,recv)=std::sync::mpsc::sync_channel(1);
            window.run_on_main_thread(move || unsafe {
                let surface=CreateWindowExW(0x08000000|0x80|0x80000|0x20,wide("STATIC").as_ptr(),wide("DTV libmpv surface").as_ptr(),0x80000000,0,0,1,1,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut());
                if !surface.is_null(){SetLayeredWindowAttributes(surface,0,255,2);}
                let _=send.send(if surface.is_null(){Err(std::io::Error::last_os_error().to_string())}else{Ok(surface as usize)});
            }).map_err(|e|e.to_string())?;
            let surface=blocking(move ||recv.recv().map_err(|e|e.to_string())?).await?;
            let init=shared.clone();
            let result=blocking(move || {
                let service=PlayerService::start(std::env::var_os("DTV_PROBE_MPV").ok_or("DTV_PROBE_MPV required")?.into(),Output::Window(surface),|_|{})?;
                *init.lock().unwrap()=Some(Native{service,generation:0,surface,parent,rect:(40,110,800,420),stopped:true}); Ok(())
            }).await;
            if let Err(error)=result { let _=window.run_on_main_thread(move||unsafe{DestroyWindow(surface as *mut c_void);}); return Err(error); }
        }
        blocking(move || {
            let mut lock=shared.lock().map_err(|e|e.to_string())?; let player=lock.as_mut().ok_or("player missing")?;
            player.generation=generation.unwrap_or(player.generation+1);
            player.service.open(player.generation,Media{url:url.unwrap_or(std::env::var("DTV_PROBE_MEDIA").map_err(|e|e.to_string())?),headers:headers.unwrap_or_default()})?;
            player.stopped=false; Ok("native libmpv worker opened".into())
        }).await
    }
    #[tauri::command]
    fn probe_rect(window:tauri::WebviewWindow,state:tauri::State<'_,State>,x:i32,y:i32,width:i32,height:i32){
        let shared=state.0.clone(); let _=window.run_on_main_thread(move||{if let Some(p)=shared.lock().unwrap().as_mut(){p.rect=(x,y,width,height);unsafe{place(p);}}});
    }
    #[tauri::command]
    async fn probe_snapshot(state:tauri::State<'_,State>)->Result<serde_json::Value,String>{
        let shared=state.0.clone(); blocking(move||{
            let lock=shared.lock().unwrap(); let Some(p)=lock.as_ref()else{return Ok(serde_json::json!({"loaded":false}));};
            let mut value=serde_json::to_value(p.service.snapshot()?).map_err(|e|e.to_string())?;
            value["surfaceVisible"]=serde_json::json!(unsafe{IsWindowVisible(p.surface as *mut c_void)!=0});Ok(value)
        }).await
    }
    #[tauri::command]
    async fn probe_stop(window:tauri::WebviewWindow,state:tauri::State<'_,State>)->Result<(),String>{
        let shared=state.0.clone(); let hidden=shared.clone();
        window.run_on_main_thread(move||{if let Some(p)=hidden.lock().unwrap().as_mut(){p.stopped=true;unsafe{place(p);}}}).map_err(|e|e.to_string())?;
        blocking(move||{if let Some(p)=shared.lock().unwrap().as_ref(){p.service.stop(p.generation)?;}Ok(())}).await
    }
    #[tauri::command]
    fn probe_media()->Result<String,String>{std::env::var("DTV_PROBE_MEDIA").map_err(|e|e.to_string())}
    #[tauri::command]
    async fn probe_control(state:tauri::State<'_,State>,generation:u64,kind:String,value:f64)->Result<(),String>{
        let shared=state.0.clone();blocking(move||{let lock=shared.lock().unwrap();let p=lock.as_ref().ok_or("player missing")?;
            match kind.as_str(){"pause"=>p.service.set_pause(generation,value!=0.0),"volume"=>p.service.set_volume(generation,value),"muted"=>p.service.set_muted(generation,value!=0.0),_=>Err("unknown control".into())}
        }).await
    }
    #[tauri::command]
    fn probe_focus(window:tauri::WebviewWindow)->Result<(),String>{window.set_focus().map_err(|e|e.to_string())}
    #[tauri::command]
    fn probe_window_action(window:tauri::WebviewWindow,action:String)->Result<(),String>{
        match action.as_str(){"minimize"=>window.minimize(),"restore"=>window.unminimize(),"hide"=>window.hide(),"show"=>window.show(),"resize"=>window.set_size(tauri::LogicalSize::new(1000.0,700.0)),_=>return Err("unknown action".into())}.map_err(|e|e.to_string())
    }
    #[tauri::command]
    fn probe_hit(window:tauri::WebviewWindow,x:i32,y:i32)->Result<serde_json::Value,String>{unsafe{
        let parent=window.hwnd().map_err(|e|e.to_string())?.0;let mut point=Point{x,y};ClientToScreen(parent,&mut point);
        let hit=WindowFromPoint(point);let mut class=[0u16;256];let len=GetClassNameW(hit,class.as_mut_ptr(),256);
        let mut title=[0u16;256];let n=GetWindowTextW(GetAncestor(hit,2),title.as_mut_ptr(),256);
        Ok(serde_json::json!({"class":String::from_utf16_lossy(&class[..len.max(0) as usize]),"belongsToUi":GetAncestor(hit,2)==parent,"hitRootTitle":String::from_utf16_lossy(&title[..n.max(0) as usize]),"foregroundUi":GetForegroundWindow()==parent}))
    }}
    #[tauri::command]
    async fn probe_report(window:tauri::WebviewWindow,state:tauri::State<'_,State>,report:serde_json::Value)->Result<(),String>{
        eprintln!("PROBE_REPORT {}",report);
        if report.get("done").and_then(|v|v.as_bool())==Some(true){
            let shared=state.0.clone();
            let surface=blocking(move||{if let Some(p)=shared.lock().unwrap().take(){let surface=p.surface;p.service.shutdown()?;Ok(Some(surface))}else{Ok(None)}}).await?;
            if let Some(surface)=surface {window.run_on_main_thread(move||unsafe{DestroyWindow(surface as *mut c_void);}).map_err(|e|e.to_string())?;}
            window.close().map_err(|e|e.to_string())?;
        }Ok(())
    }
    pub fn main(){
        tauri::Builder::default().manage(State::default())
        .invoke_handler(tauri::generate_handler![probe_start,probe_rect,probe_snapshot,probe_stop,probe_focus,probe_window_action,probe_hit,probe_report,probe_control,probe_media])
        .on_window_event(|window,event|{
            let shared=window.state::<State>().0.clone();
            if matches!(event,tauri::WindowEvent::CloseRequested{..}|tauri::WindowEvent::Destroyed){
                if let Some(p)=shared.lock().unwrap().take(){unsafe{ShowWindow(p.surface as *mut c_void,0);}
                    let app=window.app_handle().clone();std::thread::spawn(move||{let surface=p.surface;let _=p.service.shutdown();let _=app.run_on_main_thread(move||unsafe{DestroyWindow(surface as *mut c_void);});});
                }
            }else if let Some(p)=shared.lock().unwrap().as_ref(){unsafe{place(p);}}
        })
        .setup(|app|{tauri::WebviewWindowBuilder::new(app,"native-probe",tauri::WebviewUrl::App(if std::env::var_os("DTV_PROBE_CONTROLS").is_some(){"native-controls-probe.html"}else{"native-probe.html"}.into()))
            .on_page_load(|window,payload|{eprintln!("PROBE_PAGE {:?} {}",payload.event(),payload.url());let _=window.eval("window.__TAURI_INTERNALS__.invoke('probe_report',{report:{page:location.href,ready:document.readyState,text:document.body?.innerText?.slice(0,200)}})");})
            .title("DTV Native Surface Probe — libmpv + HTML").inner_size(960.0,650.0).transparent(true).background_color(tauri::webview::Color(0,0,0,0)).build()?;Ok(())})
        .run(tauri::generate_context!("examples/native-probe/tauri.conf.json")).expect("native surface probe failed");
    }
}
#[cfg(windows)]fn main(){probe::main();}
#[cfg(not(windows))]fn main(){eprintln!("Windows-only probe");}
