const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript-api');
const src=path.join(__dirname,'../src');
const plain=x=>JSON.parse(JSON.stringify(x));
function load(file,imports,globals={}){
 const code=ts.transpileModule(fs.readFileSync(path.join(src,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 const exports={};vm.runInNewContext(code,{exports,require:id=>{if(id in imports)return imports[id];throw Error('Unexpected dependency '+id)},...globals});return exports;
}
function mount({hydrated=true,interval=10,query=()=>({is_live:false}),items}={}){
 const calls=[],timers=new Map(),state=[],refs=[],effects=[];let now=0,seq=0,si=0,ri=0,ei=0,pending=[],dirty=false,value,consumed=false,child={sidebar:true};
 const grouping=load('state/follow/followGrouping.ts',{});
 const follow={hydrated,followedStreamers:items??[{platform:'HUYA',id:'a',nickname:'a',liveStatus:'UNKNOWN',categoryName:'英雄联盟'}],
  consumeInitialAutoRefresh(){if(consumed)return false;consumed=true;return true;},
  updateStreamers(patches){follow.followedStreamers=follow.followedStreamers.map(s=>{const patch=patches.find(p=>p.id===s.id&&p.platform===s.platform)?.patch;return patch?grouping.mergeFollowMetadata(s,patch):s});dirty=true;}};
 const settings={hydrated,settings:{followPollIntervalMin:interval,followRefreshConcurrency:0}};
 const react={createContext:()=>({Provider:{}}),createElement:(_type,props)=>{value=props.value;return null;},
  useState(initial){const i=si++;if(!(i in state))state[i]=initial;return[state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;dirty=true;}];},
  useRef(initial){const i=ri++;if(!(i in refs))refs[i]={current:initial};return refs[i];},
  useMemo:fn=>fn(),useCallback:fn=>fn,
  useEffect(fn,deps){const i=ei++,old=effects[i];if(!old||deps.some((d,j)=>d!==old.deps[j])){pending.push(()=>{old?.cleanup?.();const cleanup=fn();effects[i]={deps,cleanup};});}}};
 const window={setTimeout(fn,ms){timers.set(++seq,{fn,at:now+ms});return seq;},clearTimeout(id){timers.delete(id);}};
 const provider=load('state/follow/FollowRefreshProvider.tsx',{
  react,'@tauri-apps/api/core':{invoke:async(command,args)=>{calls.push({command,args});return query(command,args);}},
  '@/platforms/common/types':{Platform:{BILIBILI:'BILIBILI',DOUYIN:'DOUYIN'}},
  './FollowProvider':{useFollow:()=>follow},'@/state/settings/SettingsProvider':{useAppSettings:()=>settings}
 },{window,navigator:{hardwareConcurrency:2}});
 function render(nextChild=child){child=nextChild;let turn=0;do{assert(++turn<30,'render loop');dirty=false;si=ri=ei=0;pending=[];provider.FollowRefreshProvider({children:child});pending.forEach(fn=>fn());}while(dirty);}
 async function settle(){for(let i=0;i<3;i++){await new Promise(done=>setImmediate(done));if(dirty)render();}}
 async function advance(ms){const until=now+ms;let turn=0;while(true){const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert(++turn<100,'timer loop');now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}now=until;}
 const close=()=>effects.forEach(effect=>effect?.cleanup?.());
 render();return{calls,follow,settings,render,settle,advance,close,get value(){return value;}};
}

test('全局刷新服务首次立即查询，移除侧栏及全屏期间仍按同一计时器刷新，重建侧栏不重复初始化',async()=>{
 let live=true;const app=mount({interval:1,query:()=>({is_live:live})});await app.settle();
 assert.equal(app.calls.length,1);assert.equal(app.follow.followedStreamers[0].liveStatus,'LIVE');
 app.render(null);live=false;await app.advance(60_000);
 assert.equal(app.calls.length,2);assert.equal(app.follow.followedStreamers[0].liveStatus,'OFFLINE');
 app.render({sidebar:true});await app.settle();assert.equal(app.calls.length,2);app.close();
});

test('等待关注与设置均加载才启动，保留关闭轮询的选择，手动刷新仍可用',async()=>{
 const app=mount({hydrated:false,interval:0});await app.settle();assert.equal(app.calls.length,0);
 app.follow.hydrated=true;app.render();await app.settle();assert.equal(app.calls.length,0);
 app.settings.hydrated=true;app.render();await app.settle();assert.equal(app.calls.length,1);
 await app.advance(600_000);assert.equal(app.calls.length,1);
 await app.value.refreshList();await app.settle();assert.equal(app.calls.length,2);app.close();
});

test('修改轮询间隔会取消旧计时器，不因关注数量改变而推迟整轮刷新',async()=>{
 const app=mount({interval:1});await app.settle();await app.advance(30_000);
 app.follow.followedStreamers.push({platform:'HUYA',id:'b',nickname:'b',liveStatus:'UNKNOWN'});app.render();
 await app.advance(30_000);assert.equal(app.calls.length,3);
 app.settings.settings.followPollIntervalMin=2;app.render();await app.advance(60_000);assert.equal(app.calls.length,3);
 await app.advance(60_000);assert.equal(app.calls.length,5);app.close();
});

test('默认设置与Simple Live一致，旧用户的间隔与手动并发设置不被覆盖',()=>{
 const react={createContext:()=>({Provider:{}})};
 const settings=load('state/settings/SettingsProvider.tsx',{react,'@tauri-apps/api/core':{invoke:async()=>{}}});
 assert.equal(settings.DEFAULT_SETTINGS.followPollIntervalMin,10);
 assert.equal(settings.DEFAULT_SETTINGS.followRefreshConcurrency,0);
 // 实际加载函数保留用户字段，不用默认值覆盖用户显式选择。
 const source=fs.readFileSync(path.join(src,'state/settings/SettingsProvider.tsx'),'utf8');
 const tree=ts.createSourceFile('settings.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let fn;
 tree.forEachChild(n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='loadJson')fn=n.getText(tree)});assert.ok(fn);
 const exports={};vm.runInNewContext(ts.transpileModule(fn+'\nexport {loadJson};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
  {exports,window:{localStorage:{getItem:()=>JSON.stringify({followPollIntervalMin:2,followRefreshConcurrency:8})}}});
 const loaded=exports.loadJson('dtv_app_settings_v1',settings.DEFAULT_SETTINGS);
 assert.equal(loaded.followPollIntervalMin,2);assert.equal(loaded.followRefreshConcurrency,8);
});

test('服务关闭后晚到的网络结果不再修改关注数据或留下自动轮询',async()=>{
 let resolve;const app=mount({query:()=>new Promise(done=>resolve=done)});assert.equal(app.calls.length,1);
 const before=plain(app.follow.followedStreamers);app.close();resolve({is_live:true});await app.settle();
 assert.deepEqual(plain(app.follow.followedStreamers),before);await app.advance(600_000);assert.equal(app.calls.length,1);
});
