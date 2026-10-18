#![cfg(windows)]
#[path = "../src/native_player/runtime.rs"]
mod runtime;
use runtime::{Media, Output, PlayerService};
use std::{collections::BTreeMap, path::PathBuf, time::{Duration, Instant}};
fn dll() -> PathBuf { std::env::var_os("DTV_TEST_MPV").expect("DTV_TEST_MPV must point to the tested libmpv DLL").into() }
fn media() -> Media { Media { url: std::env::var("DTV_TEST_MEDIA").expect("DTV_TEST_MEDIA must point to local test media"), headers: BTreeMap::new() } }
fn wait(player: &PlayerService, f: impl Fn(&runtime::Snapshot)->bool) -> runtime::Snapshot {
 let deadline=Instant::now()+Duration::from_secs(8);
 loop { let state=player.snapshot().unwrap(); if f(&state) { return state; } assert!(Instant::now()<deadline,"state timeout: {state:?}"); std::thread::sleep(Duration::from_millis(30)); }
}
#[test]
fn missing_dll_is_explicit_not_a_silent_fallback() {
 let error=PlayerService::start(PathBuf::from("Z:/dtv-nonexistent/libmpv-2.dll"),Output::Headless, |_|{}).err().expect("missing DLL must fail");
 assert!(error.contains("libmpv"),"{error}");
}
#[test]
fn wrong_library_must_not_call_unknown_exports() {
 let dll=PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32/version.dll");
 let error=PlayerService::start(dll,Output::Headless, |_|{}).err().expect("non-mpv library must fail");
 assert!(error.contains("mpv_client_api_version"),"{error}");
}
#[test]
#[ignore = "requires local libmpv and deterministic media; run with DTV_TEST_MPV/DTV_TEST_MEDIA"]
fn real_decode_stop_reopen_and_stale_operations_are_isolated() {
 let player=PlayerService::start(dll(),Output::Headless, |_|{}).unwrap();
 player.open(1,media()).unwrap();
 let decoded=wait(&player,|s|s.generation==1 && s.position.unwrap_or(0.0)>0.1);
 assert!(decoded.loaded); assert_eq!(decoded.width,Some(320)); assert_eq!(decoded.height,Some(180));
 player.open(2,media()).unwrap();
 player.stop(1).unwrap(); player.set_pause(1,true).unwrap();
 let active=wait(&player,|s|s.generation==2 && s.position.unwrap_or(0.0)>0.1);
 assert!(!active.paused); assert!(active.error.is_none());
 player.set_pause(2,true).unwrap(); assert!(wait(&player,|s|s.paused).paused);
 player.set_volume(2,0.32).unwrap(); player.set_muted(2,true).unwrap();
 let volume=wait(&player,|s|s.muted && (s.volume-0.32).abs()<0.001); assert!(volume.muted);
 player.stop(2).unwrap(); let stopped=player.snapshot().unwrap(); assert!(!stopped.loaded); assert!(stopped.position.is_none());
 player.open(3,media()).unwrap(); wait(&player,|s|s.generation==3 && s.position.unwrap_or(0.0)>0.1);
 player.shutdown().unwrap();
}
#[test]
#[ignore = "requires local libmpv; run with DTV_TEST_MPV"]
fn invalid_headers_do_not_replace_the_current_generation() {
 let player=PlayerService::start(dll(),Output::Headless, |_|{}).unwrap();
 let mut bad=media(); bad.headers.insert("Referer".into(),"https://example.test/\r\nInjected: yes".into());
 assert!(player.open(9,bad).unwrap_err().contains("header"));
 assert_eq!(player.snapshot().unwrap().generation,0);
 assert!(player.set_volume(0,f64::NAN).is_err()); player.shutdown().unwrap();
}
#[test]
#[ignore = "requires local libmpv; run with DTV_TEST_MPV"]
fn initialization_failure_allows_a_fresh_retry() {
 assert!(PlayerService::start(PathBuf::from("Z:/missing-dtv-mpv.dll"),Output::Headless, |_|{}).is_err());
 let player=PlayerService::start(dll(),Output::Headless, |_|{}).unwrap();
 assert_eq!(player.snapshot().unwrap().generation,0); player.shutdown().unwrap();
}

#[test]
#[ignore = "requires local libmpv and deterministic media"]
fn media_error_is_reported_for_its_generation_and_next_open_recovers() {
 let player=PlayerService::start(dll(),Output::Headless, |_|{}).unwrap();
 player.open(1,Media{url:"Z:/dtv-no-such-video.avi".into(),headers:BTreeMap::new()}).unwrap();
 let failed=wait(&player,|s|s.error.is_some()); assert_eq!(failed.generation,1); assert!(!failed.loaded);
 player.open(2,media()).unwrap(); let good=wait(&player,|s|s.position.unwrap_or(0.0)>0.1);
 assert!(good.error.is_none()); assert_eq!(good.generation,2); player.shutdown().unwrap();
}
#[test]
#[ignore = "requires local libmpv and deterministic media"]
fn media_headers_are_exact_and_cleared_on_the_next_open() {
 use std::{io::{Read,Write},net::TcpListener};
 let bytes=std::sync::Arc::new(std::fs::read(media().url).unwrap());
 let listener=TcpListener::bind("127.0.0.1:0").unwrap(); let addr=listener.local_addr().unwrap();
 listener.set_nonblocking(true).unwrap();
 let (send,requests)=std::sync::mpsc::channel();
 let quit=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)); let server_quit=quit.clone();
 let server=std::thread::spawn(move || {
  let mut handlers=Vec::new();
  while !server_quit.load(std::sync::atomic::Ordering::SeqCst) {
   match listener.accept() {
    Ok((mut stream,_))=>{
     let bytes=bytes.clone(); let send=send.clone(); handlers.push(std::thread::spawn(move || {
     stream.set_nonblocking(false).unwrap();
     stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
     stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
     let mut request=Vec::new(); let mut byte=[0];
     while stream.read(&mut byte).unwrap_or(0)>0 { request.push(byte[0]); if request.ends_with(b"\r\n\r\n") { break; } }
     let request=String::from_utf8_lossy(&request).into_owned();
     let offset=request.lines().find_map(|line|line.strip_prefix("Range: bytes=").and_then(|s|s.split('-').next()).and_then(|s|s.parse::<usize>().ok())).unwrap_or(0).min(bytes.len()-1);
     let ranged=request.contains("Range: bytes=");
     let _=send.send(request);
     let header=if ranged { format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Type: video/x-msvideo\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",offset,bytes.len()-1,bytes.len(),bytes.len()-offset) } else { format!("HTTP/1.1 200 OK\r\nContent-Type: video/x-msvideo\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()) };
     if stream.write_all(header.as_bytes()).is_ok() { let _=stream.write_all(&bytes[offset..]); }
    })); }
    Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(5)),
    Err(_)=>break,
   }
  }
  for handler in handlers { handler.join().unwrap(); }
 });
 let player=PlayerService::start(dll(),Output::Headless, |_|{}).unwrap();
 let mut headers=BTreeMap::new(); headers.insert("X-DTV-Media".into(),"a,b; c=d".into()); headers.insert("Referer".into(),"https://live.example.test/".into());
 player.open(1,Media{url:format!("http://{addr}/first.avi"),headers}).unwrap();
 wait(&player,|s|s.position.unwrap_or(0.0)>0.1);
 let mut found=false; while let Ok(request)=requests.try_recv() { if request.starts_with("GET /first.avi ") { assert!(request.contains("X-DTV-Media: a,b; c=d\r\n"),"{request}");assert!(request.contains("Referer: https://live.example.test/\r\n"));found=true;} } assert!(found);
 player.open(2,Media{url:format!("http://{addr}/second.avi"),headers:BTreeMap::new()}).unwrap();
 wait(&player,|s|s.generation==2 && s.position.unwrap_or(0.0)>0.1);
 let mut found=false; while let Ok(request)=requests.try_recv() { if request.starts_with("GET /second.avi ") { assert!(!request.contains("X-DTV-Media"));assert!(!request.contains("live.example.test"));found=true;} } assert!(found);
 player.shutdown().unwrap(); quit.store(true,std::sync::atomic::Ordering::SeqCst); server.join().unwrap();
}
