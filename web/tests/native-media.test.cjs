const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript-api');
const file=path.join(__dirname,'../src/components/player/nativeMedia.ts');
const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const calls=[],context={exports:{},Event,EventTarget,console};vm.runInNewContext(source,context);
 const video=new EventTarget();video.setAttribute=()=>{throw Error('browser source must never be set')};video.removeAttribute=()=>{};
 const adapter=context.exports.createNativeMedia(video,async(command,args)=>{calls.push({command,args});});
 return {adapter,video,calls};
}
const snapshot=(generation,extra={})=>({generation,loaded:true,paused:false,buffering:false,ended:false,position:1,cacheEnd:5,width:320,height:180,volume:1,muted:false,error:null,...extra});
test('native media never gives a stream URL to browser and loads each source once',async()=>{
 const {adapter,video,calls}=setup();video.src='https://stream.test/a.flv';video.load();await tick();
 assert.equal(calls.filter(c=>c.command==='native_player_open').length,1);
 assert.equal(calls[0].args.url,'https://stream.test/a.flv');assert.equal(video.currentSrc,'https://stream.test/a.flv');
 await adapter.dispose();
});
test('old native events cannot reset the new source or emit a failure',async()=>{
 const {adapter,video,calls}=setup();let errors=0;video.addEventListener('error',()=>errors++);
 video.src='https://stream.test/one';await tick();const old=calls[0].args.generation;
 video.src='https://stream.test/two';await tick();const gen=calls.filter(c=>c.command==='native_player_open')[1].args.generation;
 adapter.accept(snapshot(gen));adapter.accept(snapshot(old,{error:'old error',loaded:false}));
 assert.equal(errors,0);assert.equal(video.readyState,4);assert.equal(video.videoWidth,320);assert.equal(video.currentTime,1);await adapter.dispose();
});
test('existing controls forward pause volume mute and native PiP without browser playback',async()=>{
 const {adapter,video,calls}=setup();video.src='https://stream.test/live';await tick();const gen=calls[0].args.generation;adapter.accept(snapshot(gen));
 video.pause();await video.play();video.volume=0.3;video.muted=true;video.webkitSetPresentationMode('picture-in-picture');await tick();
 assert.ok(calls.some(c=>c.command==='native_player_pause'&&c.args.paused===true));
 assert.ok(calls.some(c=>c.command==='native_player_pause'&&c.args.paused===false));
 assert.ok(calls.some(c=>c.command==='native_player_volume'&&c.args.volume===0.3));
 assert.ok(calls.some(c=>c.command==='native_player_muted'&&c.args.muted===true));
 assert.ok(calls.some(c=>c.command==='native_player_pip'&&c.args.enabled===true));await adapter.dispose();
});
test('destroy detaches events and stops only the owned generation',async()=>{
 const {adapter,video,calls}=setup();video.src='https://stream.test/live';await tick();const gen=calls[0].args.generation;
 await adapter.dispose();adapter.accept(snapshot(gen));assert.equal(video.readyState,0);
 assert.ok(calls.some(c=>c.command==='native_player_stop'&&c.args.generation===gen));await adapter.dispose();
 assert.equal(calls.filter(c=>c.command==='native_player_stop').length,1);
});
test('errors and buffering update existing HTML controls only for the active media',async()=>{
 const {adapter,video,calls}=setup();const events=[];for(const name of ['waiting','playing','error'])video.addEventListener(name,()=>events.push(name));
 video.src='https://stream.test/live';await tick();const gen=calls[0].args.generation;
 adapter.accept(snapshot(gen,{loaded:false,buffering:true,position:null,cacheEnd:null}));assert.equal(video.buffered.length,0);
 adapter.accept(snapshot(gen));assert.equal(video.buffered.end(0),5);assert.ok(events.includes('playing'));
 adapter.accept(snapshot(gen,{loaded:false,error:'load failed'}));assert.equal(video.error.message,'load failed');assert.ok(events.includes('error'));await adapter.dispose();
});

test('clearing src during slow initialization stops after that open, not before it',async()=>{
 const context={exports:{},Event,EventTarget,console};vm.runInNewContext(source,context);
 const video=new EventTarget();video.setAttribute=()=>{};video.removeAttribute=()=>{};
 let resolve;const pending=new Promise(r=>resolve=r);let completed=false,stops=0;
 const adapter=context.exports.createNativeMedia(video,async(command)=>{if(command==='native_player_open'){await pending;completed=true;}if(command==='native_player_stop'){assert.ok(completed,'stop overtook initialization');stops++;}});
 video.src='https://stream.test/slow';video.removeAttribute('src');await tick();assert.equal(stops,0);
 resolve();await tick();assert.equal(stops,1);await adapter.dispose();
});

test('stored volume and mute set before the URL reach the native kernel on first open',async()=>{
 const {adapter,video,calls}=setup();video.volume=0.2;video.muted=true;video.src='https://stream.test/live';await tick();
 assert.ok(calls.some(c=>c.command==='native_player_volume'&&c.args.volume===0.2));assert.ok(calls.some(c=>c.command==='native_player_muted'&&c.args.muted===true));await adapter.dispose();
});

test('platform media headers match Simple Live and never leak Bilibili headers to Twitch',()=>{
 const context={exports:{},Event,EventTarget,console};vm.runInNewContext(source,context);
 assert.equal(context.exports.nativeMediaHeaders('BILIBILI').Referer,'https://live.bilibili.com');
 assert.ok(context.exports.nativeMediaHeaders('HUYA')['User-Agent'].startsWith('HYSDK('));
 assert.equal(Object.keys(context.exports.nativeMediaHeaders('TWITCH')).length,0);
 assert.equal(Object.keys(context.exports.nativeMediaHeaders('DOUYIN')).length,0);
 assert.equal(Object.keys(context.exports.nativeMediaHeaders('DOUYU')).length,0);
});
