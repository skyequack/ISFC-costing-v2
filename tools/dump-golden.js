// Boots the frozen legacy app in jsdom with empty storage and dumps the effective seeded state.
const fs=require('fs'),path=require('path');const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'legacy/app.html'),'utf8');
const vc=new VirtualConsole();vc.on('jsdomError',e=>console.error('jsdomError',String(e.message).slice(0,200)));
const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/',pretendToBeVisual:true,virtualConsole:vc,
 beforeParse(w){w.matchMedia=w.matchMedia||(()=>({matches:false,addListener(){},removeListener(){}}));}});
setTimeout(()=>{
  const raw=dom.window.localStorage.getItem('isfc_costing_v1');
  if(!raw){console.error('NO STATE SAVED');process.exit(1)}
  fs.mkdirSync(path.join(root,'golden'),{recursive:true});
  fs.writeFileSync(path.join(root,'golden/state.json'),JSON.stringify(JSON.parse(raw),null,1));
  const S=JSON.parse(raw);
  console.log({keys:Object.keys(S),items:S.items.length,recipes:S.recipes.length,brands:S.brands.length,users:S.users.length,conv:Object.keys(S.conv).length,audit:S.audit.length,bytes:raw.length});
  process.exit(0);
},3000);
