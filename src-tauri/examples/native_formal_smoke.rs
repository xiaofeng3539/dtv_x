//! End-to-end smoke test using the production native commands and frontend bridge.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[path = "../src/native_player/mod.rs"] mod native_player;
use tauri::Manager;
#[tauri::command]
fn smoke_media()->Result<String,String>{std::env::var("DTV_TEST_MEDIA").map_err(|e|e.to_string())}
#[tauri::command]
fn smoke_report(app:tauri::AppHandle,report:serde_json::Value){
    eprintln!("SMOKE_REPORT {}",report);
    if let Ok(path)=std::env::var("DTV_SMOKE_REPORT"){
        use std::io::Write;
        if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open(path){let _=writeln!(file,"{}",report);}
    }
    if report.get("done").and_then(|v|v.as_bool())==Some(true){native_player::shutdown(&app);app.exit(if report["passed"]==true{0}else{1});}
}
#[tauri::command]
fn smoke_window(app:tauri::AppHandle,action:String)->Result<(),String>{
    let window=app.get_webview_window("main").ok_or("main missing")?;
    match action.as_str(){"minimize"=>window.minimize(),"restore"=>window.unminimize(),"hide"=>window.hide(),"show"=>window.show(),"focus"=>window.set_focus(),"full"=>window.set_fullscreen(true),"normal"=>window.set_fullscreen(false),_=>return Err("unknown window action".into())}.map_err(|e|e.to_string())?;
    let ui=app.clone();window.run_on_main_thread(move||native_player::sync_window(&ui)).map_err(|e|e.to_string())
}
fn main(){
    tauri::Builder::default().manage(native_player::NativePlayerState::default())
        .invoke_handler(tauri::generate_handler![smoke_media,smoke_report,smoke_window,
            native_player::native_player_open,native_player::native_player_stop,native_player::native_player_pause,
            native_player::native_player_volume,native_player::native_player_muted,native_player::native_player_rect,
            native_player::native_player_snapshot,native_player::native_player_pip])
        .on_window_event(native_player::window_event)
        .setup(|app|{tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("native-formal-smoke.html".into()))
            .title("DTV Native Playback Verification").inner_size(1000.0,720.0).transparent(true)
            .background_color(tauri::webview::Color(0,0,0,0)).build()?;Ok(())})
        .run(tauri::generate_context!("examples/native-probe/tauri.conf.json")).expect("native smoke test failed");
}
