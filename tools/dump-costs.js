// Runs the legacy cost() over every golden recipe inside the legacy app itself (the oracle).
const fs=require('fs'),path=require('path');const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'legacy/app.html'),'utf8');
const state=fs.readFileSync(path.join(root,'golden/state.json'),'utf8');
const vc=new VirtualConsole();
const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/',pretendToBeVisual:true,virtualConsole:vc,
 beforeParse(w){w.localStorage.setItem('isfc_costing_v1',state);w.matchMedia=w.matchMedia||(()=>({matches:false,addListener(){},removeListener(){}}));}});
setTimeout(()=>{
  const out=dom.window.eval(`(function(){reindex();const o={};S.recipes.forEach(r=>{let v;try{v=cost(r);}catch(e){v={THROW:String(e)}}o[r.code+'|'+r.id]=v;});return JSON.stringify(o);})()`);
  fs.writeFileSync(path.join(root,'golden/costs.json'),JSON.stringify(JSON.parse(out),null,1));
  const o=JSON.parse(out);console.log('recipes costed',Object.keys(o).length,'throws',Object.values(o).filter(x=>x.THROW).length,'withErr',Object.values(o).filter(x=>x.err).length);
  process.exit(0);
},3000);
