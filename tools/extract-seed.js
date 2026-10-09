// Splits golden/state.json and legacy static constants into db/seed-data/*.json (no transformation).
const fs=require('fs'),path=require('path');const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..');const out=path.join(root,'db/seed-data');fs.mkdirSync(out,{recursive:true});
const S=JSON.parse(fs.readFileSync(path.join(root,'golden/state.json'),'utf8'));
const w=(n,v)=>fs.writeFileSync(path.join(out,n),JSON.stringify(v,null,1));
// logos are referenced by file in public/assets (see extract-assets.js), not embedded
const logoFile={bnc:'nc-mark.png',b1:'gourmet-logo.png',b2:'salus-logo.png',b4:'dietworld-logo.png',b5:'golyv-logo.png',b7:'smc-logo.png',b10:'madhghout-logo.png',b11:'solite-logo.png',b12:'sugarbatch-logo.png'};
w('brands.json',S.brands.map(b=>{const {logo,...r}=b;return {...r,logoFile:logoFile[b.id]||null,hadLogo:!!logo}}));
w('items.json',S.items);w('conv.json',S.conv);w('recipes.json',S.recipes);w('settings.json',S.settings);
w('users-legacy-NOT-MIGRATED.json',S.users.map(u=>({id:u.id,name:u.name,role:u.role})));
const html=fs.readFileSync(path.join(root,'legacy/app.html'),'utf8');
const vc=new VirtualConsole();const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/',virtualConsole:vc,beforeParse(x){x.matchMedia=()=>({matches:false,addListener(){},removeListener(){}})}});
setTimeout(()=>{
 const g=n=>JSON.parse(dom.window.eval(`JSON.stringify(typeof ${n}==='undefined'?null:${n})`));
 for(const [n,f] of [['YIELD_REF','yield-ref.json'],['MENU_PLAN','menu-plan.json'],['SEED_ISSUES','seed-issues.json'],['SECTIONS','sections.json'],['PLAN_ALIAS','plan-alias.json'],['DEF_LOCS','locs.json'],['MENU_DAYS','menu-days.json']]){const v=g(n);if(v==null)console.log('MISSING',n);else{w(f,v);console.log(f,Array.isArray(v)?v.length:Object.keys(v).length)}}
 // brand logos check
 console.log('brands with logo in golden:',S.brands.filter(b=>b.logo).map(b=>b.id).join(','));
 process.exit(0)},2500);
