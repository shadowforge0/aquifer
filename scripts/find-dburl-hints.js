const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const exts = new Set(['.md', '.js', '.json', '.yaml', '.yml', '.sh', '.sql', '.txt']);
const needles = [/DATABASE_URL/g, /AQUIFER_DB_URL/g, /postgresql:\/\//g, /postgres:\/\//g];

function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

for (const f of walk(root)) {
  if (!exts.has(path.extname(f))) continue;
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!needles.some(re => re.test(txt))) continue;
  const lines = txt.split('\n');
  lines.forEach((line, i) => {
    if (needles.some(re => re.test(line))) {
      console.log(`${path.relative(root, f)}:${i+1}: ${line}`);
    }
  });
}
