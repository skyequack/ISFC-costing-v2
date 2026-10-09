// Extracts base64 logos from the frozen legacy file into public/assets and writes seed constants as JSON.
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');const src=fs.readFileSync(path.join(root,'legacy/app.html'),'utf8');
fs.mkdirSync(path.join(root,'public/assets'),{recursive:true});
const rep=[];
for(const m of src.matchAll(/const ([A-Z_]+)=(['"])data:image\/(png|jpe?g|gif|svg\+xml|webp);base64,([A-Za-z0-9+\/=]+)\2/g)){
  const ext=m[3].replace('jpeg','jpg').replace('svg+xml','svg');const f=`${m[1].toLowerCase().replace(/_/g,'-')}.${ext}`;
  const buf=Buffer.from(m[4],'base64');fs.writeFileSync(path.join(root,'public/assets',f),buf);rep.push({const:m[1],file:f,bytes:buf.length});
}
console.table(rep);
