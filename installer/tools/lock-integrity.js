// Fills "resolved"/"integrity" into a package-lock.json generated from an existing node_modules
// (npm leaves them empty then), so `npm ci` on friends' PCs verifies every tarball.
// With <tree-dir>, entries npm hoisted differently from the tested tree are moved back to where they
// live there: some native-addon loaders only find their binding from their original nested spot.
// Usage: node lock-integrity.js <package-lock.json> [tree-dir]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const file = process.argv[2];
const lock = JSON.parse(fs.readFileSync(file, 'utf8'));

function treePackages(base) {
  const out = [];
  (function walk(rel) {
    const nm = path.join(base, rel, 'node_modules');
    if (!fs.existsSync(nm)) return;
    for (const e of fs.readdirSync(nm)) {
      if (e.startsWith('.')) continue;
      const names = e.startsWith('@') ? fs.readdirSync(path.join(nm, e)).map(s => e + '/' + s) : [e];
      for (const n of names) {
        const r = (rel ? rel + '/' : '') + 'node_modules/' + n;
        if (fs.existsSync(path.join(base, r, 'package.json'))) { out.push(r); walk(r); }
      }
    }
  })('');
  return out;
}

function relocate(base) {
  const pkgs = lock.packages;
  const nameOf = k => (pkgs[k] && pkgs[k].name) || k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const tree = treePackages(base);
  for (const want of tree.filter(r => !pkgs[r])) {
    const version = JSON.parse(fs.readFileSync(path.join(base, want, 'package.json'), 'utf8')).version;
    const from = Object.keys(pkgs).find(k => k && nameOf(k) === nameOf(want) && pkgs[k].version === version &&
      !fs.existsSync(path.join(base, k, 'package.json')));
    if (!from) throw new Error('no lock entry to place at ' + want);
    pkgs[want] = pkgs[from];
    delete pkgs[from];
    console.log('moved', from, '->', want);
  }
  const extra = Object.keys(pkgs).filter(k => k && !fs.existsSync(path.join(base, k, 'package.json')) && !pkgs[k].optional);
  if (extra.length) throw new Error('lock has non-optional packages absent from the tree: ' + extra.join(', '));
}

if (process.argv[3]) relocate(process.argv[3]);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => (body += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(res.statusCode + ' ' + url))));
    }).on('error', reject);
  });
}

async function fill(key) {
  const entry = lock.packages[key];
  const name = entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2f') + '/' + entry.version;
  for (let attempt = 1; ; attempt++) {
    try {
      const m = await get(url);
      if (!m.dist || !m.dist.integrity) throw new Error('no integrity: ' + url);
      entry.resolved = m.dist.tarball;
      entry.integrity = m.dist.integrity;
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

(async () => {
  const keys = Object.keys(lock.packages).filter(k => k && !lock.packages[k].link && !lock.packages[k].integrity);
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < keys.length) await fill(keys[next++]);
  }));
  fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
  console.log('filled', keys.length);
})().catch(e => { console.error(e.message); process.exit(1); });
