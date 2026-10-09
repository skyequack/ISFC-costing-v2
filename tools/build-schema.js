// Generates prisma/schema.prisma + prisma/raw.sql from schema.md (one field per line).
const fs = require('fs');
const md = fs.readFileSync('schema.md', 'utf8');
const body = md.match(/```prisma\n([\s\S]*?)```/)[1];
const out = [];
for (let line of body.split('\n')) {
  line = line.replace(/\s*\/\/.*$/, (c) => '  ' + c.trim()); // keep trailing comments
  const cm = line.match(/(\s+\/\/.*)$/);
  const comment = cm ? cm[1].trim() : '';
  const code = cm ? line.slice(0, cm.index) : line;
  const ind = /^\s/.test(code) ? '  ' : '';
  const enumM = code.match(/^enum\s+(\w+)\s*\{\s*(.*?)\s*\}\s*$/);
  if (enumM) { out.push(`enum ${enumM[1]} {`); enumM[2].split(/\s+/).forEach((v) => out.push('  ' + v)); out.push('}'); continue; }
  const dsM = code.match(/^datasource db \{/);
  if (dsM) { out.push('datasource db {','  provider  = "postgresql"','  url       = env("DATABASE_URL")','  directUrl = env("DIRECT_URL")','}'); continue; }
  const modelOne = code.match(/^model (\w+) \{\s*(.+?)\s*\}\s*$/);
  if (modelOne) { out.push(`model ${modelOne[1]} {`); splitFields(modelOne[2]).forEach((f) => out.push('  ' + f)); out.push('}'); continue; }
  if (ind && code.trim()) {
    const parts = splitFields(code.trim());
    parts.forEach((f, i) => out.push('  ' + f + (i === parts.length - 1 && comment ? '  ' + comment : '')));
    continue;
  }
  out.push(code + (comment ? '  ' + comment : ''));
}
function splitFields(s) {
  // fields are separated by 2+ spaces, but never inside parentheses
  const res = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && c === ' ' && s[i + 1] === ' ') { if (cur.trim()) res.push(cur.trim()); cur = ''; while (s[i + 1] === ' ') i++; continue; }
    cur += c;
  }
  if (cur.trim()) res.push(cur.trim());
  return res;
}
fs.writeFileSync('prisma/schema.prisma', 'generator client {\n  provider = "prisma-client-js"\n}\n\n' + out.join('\n') + '\n');
const raw = md.match(/## Raw-SQL migration additions\n```sql\n([\s\S]*?)```/)[1];
const mig = require('child_process').execSync('npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script', {env: {...process.env, DATABASE_URL: 'postgresql://x:x@localhost/x', DIRECT_URL: 'postgresql://x:x@localhost/x'}}).toString();
fs.mkdirSync('prisma/migrations/0001_init', {recursive: true});
fs.writeFileSync('prisma/migrations/0001_init/migration.sql', mig + '\n-- ===== Raw SQL additions (schema.md) =====\n' + raw);
