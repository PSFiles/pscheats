#!/usr/bin/env node
/**
 * build-site.mjs - builds the static "PS Cheats" site from the cheat folders.
 *
 * Usage:
 *   node tools/build-site.mjs                 # builds _site/
 *   node tools/build-site.mjs --out dist      # builds into another folder
 *   node tools/build-site.mjs --serve 8080    # builds and starts a local server
 *
 * No external dependencies (Node 18+).
 *
 * Output:
 *   <out>/index.html, <out>/assets/*
 *   <out>/data/index.json        search index (games + cheat names)
 *   <out>/data/g/<id>.json       per-game detail (full codes)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ROOT = path.resolve(String(arg('root', path.join(HERE, '..'))));
const OUT = path.resolve(String(arg('out', path.join(ROOT, '_site'))));
const SERVE = arg('serve', false);

/** Every cheat folder becomes a source. */
const SOURCES = [
  { id: 'game-cheats', dir: 'PS3-game-cheats', ext: '.txt', platform: 'PS3', label: 'PS3 · game-cheats', repo: 'mohasi/game-cheats', base: 'compiled' },
  { id: 'artemis', dir: 'PS3-ArtemisDB', ext: '.ncl', platform: 'PS3', label: 'PS3 · ArtemisDB', repo: 'bucanero/ArtemisPS3', base: 'docs/codes' },
  { id: 'goldhen', dir: 'PS4-GoldHEN', ext: '.json', platform: 'PS4', label: 'PS4 · GoldHEN', repo: 'GoldHEN/GoldHEN_Cheat_Repository', base: 'json' },
  { id: 'hen5', dir: 'PS5-HEN', ext: '.json', platform: 'PS5', label: 'PS5 · HEN Collection', repo: 'TeeKay87/HEN-Cheats-Collection', base: 'cheats/json' },
  // local source: there is no upstream repository to sync from (maintained by hand)
  { id: 'vitacheats', dir: 'PSV-vitacheats', ext: '.psv', platform: 'PSV', label: 'PS Vita · VitaCheat', repo: 'PSFiles/pscheats', base: 'PSV-vitacheats', local: true },
];

/* ---------------------------------------------------------------- helpers --- */

const SERIAL_RE = /\b([A-Z]{4}\d{5})\b/;
const VERSION_RE = /\b(?:av|v)?(\d{2}\.\d{2})\b/;

function serialOf(text) {
  const m = String(text || '').toUpperCase().match(SERIAL_RE);
  return m ? m[1] : '';
}

function hex(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^0-9A-F]/g, '');
}

function slug(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/** Title derived from an Artemis (.ncl) file name. */
function titleFromFile(file) {
  let base = file.replace(/\.(ncl|txt|json)$/i, '');
  base = base.replace(SERIAL_RE, ' ');
  base = base.replace(/\bav\d{2}\.\d{2}\b/gi, ' ');
  base = base.replace(/\bv\d{2}\.\d{2}\b/gi, ' ');
  base = base.replace(/\b\d{2}\.\d{2}\b/g, ' ');
  return base.replace(/\s+/g, ' ').replace(/[-_–]+$/g, '').trim();
}

/** Deduplication key: name + normalised codes. */
function codeKey(lines) {
  return lines
    .map((l) => String(l)
      .replace(/^(w8|w16|w32|aob)\s+/i, '')
      .replace(/^[0-9A-F]\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase())
    .filter((l) => l && l !== '00010000 04000000')
    .join(' | ');
}

/* ---------------------------------------------------------------- parsers --- */

/** Artemis .ncl: block = name / flags / author / codes / '#'. */
function parseNcl(text) {
  const cheats = [];
  let block = [];
  const flush = () => {
    const b = block.slice();
    block = [];
    while (b.length && !b[0].trim()) b.shift();
    while (b.length && !b[b.length - 1].trim()) b.pop();
    if (b.length < 2) return;
    const first = b.findIndex((l) => /^[0-9A-Fa-f]\s+\S/.test(l.trim()) || /^B\s+[0-9A-Fa-f]/.test(l.trim()));
    const name = (b[0] || '').trim();
    if (!name || name === '#') return;
    const codes = (first === -1 ? [] : b.slice(first)).map((l) => l.trim()).filter(Boolean);
    const author = first > 1 ? (b[first - 1] || '').trim() : '';
    cheats.push({
      n: name,
      a: author,
      d: '',
      l: codes,
    });
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '#') { flush(); continue; }
    block.push(line);
  }
  flush();
  return cheats;
}

/** VitaCheat (.psv): '# Title/# ID/# Version' headers + '_V0 name' blocks with '$XXXX' codes. */
function parseVitaPsv(text) {
  const meta = {};
  const cheats = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = line.match(/^#\s*([A-Za-z][A-Za-z0-9 ]{0,28}):\s*(.*)$/);
      if (m) meta[m[1].toLowerCase().trim()] = m[2].trim();
      continue;
    }

    const block = line.match(/^_V\d+\s+(.*)$/);
    if (block) {
      const name = block[1].replace(/\s+#.*$/, '').trim();
      if (!name || /^[-=_\s]+$/.test(name)) { cur = null; continue; }
      cur = { n: name, a: '', d: '', l: [] };
      cheats.push(cur);
      continue;
    }

    if (line.startsWith('$') && cur) {
      cur.l.push(line.replace(/\s+#.*$/, '').replace(/\s+/g, ' ').toUpperCase());
    }
  }

  const author = meta['code author'] || meta.author || meta['original author'] || '';
  for (const c of cheats) c.a = author;

  return {
    title: meta.title || '',
    // '# ID' may list several serials ("PCSB01321 \ PCSE01361 \ PCSG01256"): use the first one
    serial: serialOf(meta.id),
    version: meta.version || '',
    cheats,
  };
}

/** game-cheats (.txt): '# Title' + name:/author:/mode:/w32|aob blocks. */
function parseGameCheatsTxt(text) {
  const cheats = [];
  let title = '';
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!title) {
      const m = line.match(/^#\s+(.+)$/);
      if (m) { title = m[1].trim(); continue; }
    }
    if (/^name:\s*/i.test(line)) {
      if (cur && !cur.l.length) cur = null;
      cur = { n: line.replace(/^name:\s*/i, '').trim(), a: '', d: '', l: [] };
      cheats.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^author:\s*/i.test(line)) { cur.a = line.replace(/^author:\s*/i, '').trim(); continue; }
    if (/^(mode|score):/i.test(line)) continue;
    if (!line) continue;
    const clean = line.replace(/\s+working-val=\S+$/i, '');
    if (/^(w8|w16|w32)\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]+$/i.test(clean)
      || /^aob\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+$/i.test(clean)) {
      cur.l.push(clean.replace(/^(w8|w16|w32|aob)/i, (m) => m.toUpperCase()));
    }
  }
  return { title, cheats };
}

/** GoldHEN / HEN-Cheats-Collection (.json). */
function parseHenJson(text) {
  const o = JSON.parse(text);
  const credits = Array.isArray(o.credits) ? o.credits.join(', ') : (o.credits || '');
  const cheats = [];
  for (const mod of (Array.isArray(o.mods) ? o.mods : [])) {
    const lines = [];
    for (const m of (Array.isArray(mod.memory) ? mod.memory : [])) {
      if (m && m.offset != null) {
        if (m.on != null) lines.push(`${hex(m.offset)}  ${hex(m.on)}  ->  ${hex(m.off || '00000000')}`);
        else lines.push(`${hex(m.offset)}  ${hex(m.value)}`);
      } else if (m && (m.address != null || m.addr != null)) {
        lines.push(`${hex(m.address || m.addr)}  ${hex(m.value)}`);
      } else if (typeof m === 'string') {
        lines.push(m.trim());
      }
    }
    for (const c of (Array.isArray(mod.codes) ? mod.codes : [])) {
      if (c && c.offset != null && c.on != null) lines.push(`${hex(c.offset)}  ${hex(c.on)}  ->  ${hex(c.off || '00000000')}`);
      else if (c && c.value != null) lines.push(`${hex(c.offset)}  ${hex(c.value)}`);
      else if (typeof c === 'string') lines.push(c.trim());
    }
    if (typeof mod.code === 'string' && mod.code.trim()) {
      for (const l of mod.code.split(/\r?\n/)) if (l.trim()) lines.push(l.trim());
    }
    cheats.push({
      n: mod.name || '(sem nome)',
      a: credits,
      d: mod.description || mod.desc || '',
      t: mod.type || '',
      l: lines.filter(Boolean),
    });
  }
  return {
    title: o.name || '',
    serial: o.id || '',
    version: o.version || '',
    process: o.process || '',
    cheats,
  };
}

/* ------------------------------------------------------------------- build --- */

function readSource(src) {
  const dir = path.join(ROOT, src.dir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) { walk(path.join(current, entry.name), prefix + entry.name + '/'); continue; }
      if (!entry.name.toLowerCase().endsWith(src.ext)) continue;
      out.push({ file: entry.name, rel: prefix + entry.name, full: path.join(current, entry.name) });
    }
  };
  walk(dir, '');
  return out;
}

function main() {
  const started = Date.now();
  const games = new Map();
  const stats = { files: 0, cheats: 0, skipped: 0, errors: [] };
  const bySource = {};

  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

  for (const src of SOURCES) {
    const files = readSource(src);
    const sStat = { files: files.length, cheats: 0 };
    bySource[src.id] = sStat;

    for (const { file, rel, full } of files) {
      let parsed;
      let title = '';
      let serial = '';
      let version = '';
      try {
        const text = fs.readFileSync(full, 'utf8');
        if (src.ext === '.json') {
          parsed = parseHenJson(text);
          title = parsed.title;
          serial = parsed.serial;
          version = parsed.version;
        } else if (src.ext === '.psv') {
          parsed = parseVitaPsv(text);
          title = parsed.title;
          serial = parsed.serial;
          version = parsed.version;
        } else if (src.ext === '.ncl') {
          parsed = { cheats: parseNcl(text) };
          title = titleFromFile(file);
          const m = title.match(SERIAL_RE);
          serial = m ? m[1] : serialOf(file);
          const v = file.match(VERSION_RE);
          version = v ? v[1] : '';
        } else {
          parsed = parseGameCheatsTxt(text);
          title = parsed.title;
          serial = serialOf(file);
        }
      } catch (e) {
        stats.errors.push(`${src.id}/${file}: ${e.message}`);
        continue;
      }

      if (!Array.isArray(parsed.cheats)) parsed.cheats = [];
      if (!parsed.cheats.length) { stats.skipped++; continue; }

      if (!serial) serial = serialOf(file);
      if (!title) title = titleFromFile(file) || String(serial || '');

      serial = String(serial || '').toUpperCase().trim();
      title = String(title || '').replace(/\s+/g, ' ').trim();

      const key = serial
        ? `${src.platform}|${serial}`
        : `${src.platform}|~${slug(title) || slug(file)}`;
      const id = (serial ? `${src.platform}-${serial}` : `${src.platform}-x-${slug(title) || slug(file)}`)
        .replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);

      let game = games.get(key);
      if (!game) {
        game = {
          key, id, platform: src.platform, serial, title: title || serial || file,
          sources: [], files: [], cheats: [], seen: new Set(), versions: new Set(),
        };
        games.set(key, game);
      }
      if (title && (!game.title || title.length > game.title.length)) game.title = title;
      if (!game.sources.includes(src.id)) game.sources.push(src.id);
      if (version) game.versions.add(version);

      game.files.push({
        s: src.id,
        f: rel,
        v: version,
        url: `https://github.com/${src.repo}/blob/HEAD/${src.base ? src.base + '/' : ''}${rel.split('/').map(encodeURIComponent).join('/')}`,
      });

      for (const c of parsed.cheats) {
        const lines = (Array.isArray(c.l) ? c.l : []).map((l) => String(l).trim()).filter(Boolean);
        if (!lines.length && !c.n) continue;
        const ck = `${String(c.n).toLowerCase()}|${codeKey(lines)}`;
        if (game.seen.has(ck)) continue;
        game.seen.add(ck);
        game.cheats.push({
          n: String(c.n || '(sem nome)').trim(),
          a: String(c.a || '').trim(),
          d: String(c.d || '').trim(),
          t: String(c.t || '').trim(),
          v: version || '',
          l: lines,
        });
        sStat.cheats++;
        stats.cheats++;
      }
      stats.files++;
    }
  }

  /* ---------------------------------------------------------------- output --- */

  const gDir = path.join(OUT, 'data', 'g');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(gDir, { recursive: true });

  const list = [...games.values()].sort((a, b) => collator.compare(a.title, b.title));
  const index = { v: 1, generated: new Date().toISOString(), totals: { games: list.length, cheats: stats.cheats }, platforms: {}, games: [] };

  for (const g of list) {
    const p = (index.platforms[g.platform] = index.platforms[g.platform] || { games: 0, cheats: 0 });
    p.games++;
    p.cheats += g.cheats.length;

    const names = [];
    for (const c of g.cheats) if (!names.includes(c.n)) names.push(c.n);

    index.games.push({
      i: g.id,
      t: g.title,
      s: g.serial,
      p: g.platform,
      c: g.cheats.length,
      f: g.sources,
      v: [...g.versions].sort(),
      n: names.slice(0, 120),
    });

    const detail = {
      id: g.id,
      title: g.title,
      serial: g.serial,
      platform: g.platform,
      files: g.files,
      cheats: g.cheats,
    };
    fs.writeFileSync(path.join(gDir, `${g.id}.json`), JSON.stringify(detail));
  }

  fs.writeFileSync(path.join(OUT, 'data', 'index.json'), JSON.stringify(index));

  for (const name of ['index.html']) {
    const from = path.join(ROOT, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, name));
  }
  const assets = path.join(ROOT, 'assets');
  if (fs.existsSync(assets)) fs.cpSync(assets, path.join(OUT, 'assets'), { recursive: true });

  const indexBytes = fs.statSync(path.join(OUT, 'data', 'index.json')).size;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`sources     : ${SOURCES.map((s) => `${s.id}=${bySource[s.id].files}`).join('  ')}`);
  console.log(`files       : ${stats.files} read, ${stats.skipped} without cheats`);
  console.log(`games       : ${list.length}`);
  console.log(`cheats      : ${stats.cheats}`);
  for (const [p, v] of Object.entries(index.platforms)) {
    console.log(`  ${p}        : ${v.games} games, ${v.cheats} cheats`);
  }
  console.log(`index       : ${(indexBytes / 1048576).toFixed(2)} MiB`);
  console.log(`output      : ${OUT}`);
  console.log(`time        : ${secs}s`);
  if (stats.errors.length) {
    console.log(`\nwarnings (${stats.errors.length}):`);
    for (const e of stats.errors.slice(0, 15)) console.log('  - ' + e);
  }

  if (SERVE) serve(OUT, Number(SERVE) || 8080);
}

/* ------------------------------------------------------------------- serve --- */

function serve(dir, port) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0]).replace(/\/+$/, '') || '/';
    let file = path.join(dir, clean);
    if (!file.startsWith(dir)) { res.writeHead(403).end('403'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, {
      'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nserving ${dir} at http://127.0.0.1:${port}/  (pid ${process.pid})`);
  });
}

main();
