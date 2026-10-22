const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript-api');
const {EventEmitter}=require('node:events');
const root=path.join(__dirname,'../src/components/player');
const tick=()=>new Promise(done=>setImmediate(done));
function load(file,requireModule,globals){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:requireModule,...globals});return exports;}
const sdk=fs.readFileSync(require.resolve('xgplayer').replace(/dist[\\/]index\.min\.js$/,'es/player.js'),'utf8');
// 实际SDK switchURL，不用测试替身实现其等待canplay/继承暂停的行为。
const tree=ts.createSourceFile('sdk.js',sdk,ts.ScriptTarget.Latest,true);let switchFunction;
function find(n){if(ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(tree)==='key'&&p.initializer?.text==='switchURL'))switchFunction=n.properties.find(p=>p.name?.getText(tree)==='value')?.initializer?.getText(tree);ts.forEachChild(n,find);}find(tree);
async function setup(){
 const calls=[],events=new EventEmitter();let accepted;
 const video=new EventTarget();video.classList={add(){}};video.dataset={};video.setAttribute=()=>{};video.removeAttribute=()=>{};
 const style={getPropertyValue:()=>'',getPropertyPriority:()=>'',setProperty(){},removeProperty(){}};
 const root={isConnected:true,parentElement:null,classList:{add(){},remove(){}},style,getBoundingClientRect:()=>({x:0,y:0,left:0,right:640,top:0,bottom:360,width:640,height:360})};
 const media=load('nativeMedia.ts',()=>{throw Error('unexpected import')},{Event});
 const globals={Event,console,getComputedStyle:()=>({backgroundColor:'rgb(0, 0, 0)'}),
  MutationObserver:class{observe(){}disconnect(){}},ResizeObserver:class{observe(){}disconnect(){}},
  document:{createElement:()=>video,documentElement:{},addEventListener(){},removeEventListener(){}},
  window:{devicePixelRatio:1,setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}}};
 const playback=load('nativePlayback.ts',id=>{
  if(id==='./nativeMedia')return media;
  if(id==='@tauri-apps/api/core')return{invoke:async(command,args)=>{calls.push({command,args});}};
  if(id==='@tauri-apps/api/event')return{listen:async(name,fn)=>{if(name==='native-player-state')accepted=fn;return()=>{};}};
  throw Error(id);
 },globals);
 const bridge=await playback.createNativePlayback('BILIBILI');
 const player={root,video,config:{},isError:false,preProcessUrl:url=>({url}),_seekToStartTime(){},
  on:events.on.bind(events),off:events.off.bind(events),once:events.once.bind(events),play:()=>video.play(),pause:()=>video.pause()};
 Object.defineProperties(player,{src:{get:()=>video.src,set:url=>{video.src=url;}},paused:{get:()=>video.paused},currentTime:{get:()=>video.currentTime}});
 video.addEventListener('canplay',()=>events.emit('canplay'));
 assert(switchFunction,'SDK switchURL not located');
 player.switchURL=vm.runInNewContext('('+switchFunction+')',{Promise,util:{typeOf:v=>typeof v==='object'?'Object':'String'},sniffer:{os:{isAndroid:false}}});
 bridge.attach(player);
 function accept(extra={}){const owner=calls.filter(c=>c.command==='native_player_open').at(-1).args.generation;accepted({payload:{generation:owner,loaded:true,paused:false,buffering:false,ended:false,position:1,cacheEnd:5,width:320,height:180,volume:1,muted:false,error:null,...extra}});}
 player.src='https://old.test/live.flv';await bridge.ready;accept();calls.length=0;
 return{bridge,player,video,calls,accept};
}

test('原生切台像Simple Live open一样在提交媒体后完成，不等待浏览器canplay',async()=>{
 const run=await setup();let completed=false;
 const pending=run.player.switchURL('https://next.test/live.flv',{platform:'HUYA'}).then(()=>completed=true);
 await tick();assert.equal(completed,true,'不能把原生换流挂在浏览器canplay上');
 await pending;await run.bridge.dispose();
});

test('跨平台复用libmpv时每条流更新自己的Header，不继承上间B站Referer',async()=>{
 const run=await setup();const pending=run.player.switchURL('https://huya.test/live.flv',{platform:'HUYA'});
 await tick();const open=run.calls.find(c=>c.command==='native_player_open');
 assert.equal(open.args.headers.Referer,undefined);
 assert.match(open.args.headers['User-Agent'],/^HYSDK/);
 run.accept();await pending;await run.bridge.dispose();
});

test('上一间暂停后切房间，新直播默认播放而不继承暂停',async()=>{
 const run=await setup();run.player.pause();await tick();
 const pending=run.player.switchURL('https://next.test/live.m3u8',{platform:'DOUYIN'});await tick();run.accept();await pending;await tick();
 assert.equal(run.video.paused,false,'旧SDK canplay回调不能再次暂停新流');
 await run.bridge.dispose();
});


test('换流开始后用户主动暂停，媒体提交完成不能覆盖新暂停意图',async()=>{
 const run=await setup();
 const pending=run.player.switchURL('https://next.test/live.flv',{platform:'HUYA'});
 run.video.pause();await pending;await tick();
 assert.equal(run.video.paused,true,'ready之后不能无条件重新播放');
 assert.equal(run.calls.filter(c=>c.command==='native_player_pause').at(-1)?.args.paused,true);
 await run.bridge.dispose();
});
