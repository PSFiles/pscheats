#!/usr/bin/env node
/**
 * build-site.mjs - builds the static "PS Cheats" site from the cheat folders.
 *
 * Usage:
 *   node tools/build-site.mjs                 # builds _site/
 *   node tools/build-site.mjs --out dist      # builds into another folder
 *   node tools/build-site.mjs --serve 8080    # builds and starts a local server
 *   node tools/build-site.mjs --keep-orphans  # do not drop stale titles.json keys
 *
 * No external dependencies (Node 18+).
 *
 * Title ids (the "serial" of a game) are read from the cheat file name. Some
 * upstream files (mostly bucanero/ArtemisPS3 .ncl) carry no id at all; for those
 * the build falls back to tools/serials.json, a curated map of file name -> ids.
 * tools/resolve-serials.mjs proposes the entries, a human confirms them.
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
const TITLES_FILE = path.resolve(String(arg('titles', path.join(ROOT, 'titles.json'))));
const SERIALS_FILE = path.resolve(String(arg('serials', path.join(ROOT, 'tools', 'serials.json'))));
const KEEP_ORPHANS = !!arg('keep-orphans', false);
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

// Sony ids are 4 letters + 5 digits (BLES01234); a handful of PS3 disc ids carry
// a 6th digit (BLES001442), so the digit run is 5-6. A separator is tolerated.
const SERIAL_RE = /\b([A-Z]{4}-?\d{5,6})\b/;
const VERSION_RE = /\b(?:av|v)?(\d{2}\.\d{2})\b/;

function serialOf(text) {
  const m = String(text || '').toUpperCase().match(SERIAL_RE);
  return m ? m[1].replace(/-/g, '') : '';
}

/** Region letter used by Sony serials: BLES/NPEB = EUR, BLUS/NPUB = USA, BLJM/NPJB = JPN, BLAS/BCAS = ASIA, BLKS = KOR. */
const REGION_BY_LETTER = { U: 'USA', E: 'EUR', J: 'JPN', A: 'ASIA', K: 'KOR', H: 'ASIA', G: 'JPN', B: 'EUR', C: 'EUR', D: 'EUR', F: 'EUR' };
// Japan disc ids, where the region letter is not in the usual position.
const JPN_DISC = new Set(['SLPM', 'SLPS', 'SCPS', 'SLKA']);
// PS Vita ids use their own letters: PCSA is the Americas, not Asia.
const VITA_REGION_BY_LETTER = { A: 'USA', B: 'EUR', C: 'EUR', D: 'EUR', E: 'EUR', F: 'EUR', G: 'JPN', H: 'ASIA', K: 'KOR' };

/** Region of a serial; CUSA/PPSA title ids are region-free, so they return an empty string. */
function regionOf(serial) {
  const s = String(serial || '').toUpperCase();
  if (s.length < 4) return '';
  const prefix = s.slice(0, 4);
  if (prefix === 'CUSA' || prefix === 'PPSA') return '';
  if (JPN_DISC.has(prefix)) return 'JPN';
  if (prefix.startsWith('PCS')) return VITA_REGION_BY_LETTER[s[3]] || '';
  return REGION_BY_LETTER[s[2]] || '';
}

function hex(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^0-9A-F]/g, '');
}

function slug(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/**
 * tools/serials.json: file name (or relative path) -> id, or list of ids where the
 * first one is the primary id (it decides the game page the cheats land on).
 * A null/empty value means "not identified yet" and is ignored here.
 */
function loadSerialOverrides(file) {
  const map = new Map();
  let pending = 0;
  if (!fs.existsSync(file)) return { map, pending };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`warning     : failed to parse ${file}: ${e.message}`);
    return { map, pending };
  }
  for (const [key, value] of Object.entries(raw || {})) {
    const ids = (Array.isArray(value) ? value : [value]).map((v) => serialOf(v)).filter(Boolean);
    if (ids.length) map.set(key, [...new Set(ids)]);
    else pending++;
  }
  return { map, pending };
}

/** Title derived from an Artemis (.ncl) file name. */
function titleFromFile(file) {
  let base = file.replace(/\.(ncl|txt|json)$/i, '');
  base = base.replace(SERIAL_RE, ' ');
  base = base.replace(/\bav\d{2}\.\d{2}\b/gi, ' ');
  base = base.replace(/\bv\d{2}\.\d{2}\b/gi, ' ');
  base = base.replace(/\b\d{2}\.\d{2}\b/g, ' ');
  base = base.replace(/\s+/g, ' ').trim();
  // "Odin Sphere BLES 01.01.ncl": the version is gone but a bare region prefix
  // is left behind, which is not part of the title.
  base = base.replace(/\s+(?:NPEB|NPUB|NPJB|NPEA|NPUA|BLES|BLUS|BLJM|BLAS|BCAS|BLKS|BCES|BCUS)$/i, '');
  return base.replace(/[-_–]+$/g, '').trim();
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
      n: mod.name || '(unnamed)',
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
  const stats = { files: 0, cheats: 0, skipped: 0, mapped: 0, errors: [] };
  const bySource = {};
  const serialMap = loadSerialOverrides(SERIALS_FILE);
  const serialOverrides = serialMap.map;
  const usedOverrides = new Set();

  const collator = new Intl.Collator('en-US', { sensitivity: 'base', numeric: true });

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

      serial = String(serial || '').toUpperCase().replace(/-/g, '').trim();
      title = String(title || '').replace(/\s+/g, ' ').trim();
      const hadId = !!serial;

      // The id this file gets on its own. Before tools/serials.json taught the
      // build the real id, titles.json keyed the game by this synthetic id, so it
      // is kept as a fallback lookup (manual titles survive the merge).
      const legacyId = `${src.platform}-x-${slug(title) || slug(file)}`
        .replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);

      // No id in the file name and none in the content: use the curated map.
      if (!serial) {
        const hit = serialOverrides.has(rel) ? rel : (serialOverrides.has(file) ? file : '');
        if (hit) {
          serial = serialOverrides.get(hit)[0];
          usedOverrides.add(hit);
          stats.mapped++;
        }
      }

      const key = serial
        ? `${src.platform}|${serial}`
        : `${src.platform}|~${slug(title) || slug(file)}`;
      const id = (serial ? `${src.platform}-${serial}` : legacyId)
        .replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);

      let game = games.get(key);
      if (!game) {
        game = {
          key, id, platform: src.platform, serial, region: regionOf(serial), title: title || serial || file,
          sources: [], files: [], cheats: [], seen: new Set(), versions: new Set(), legacy: new Set(),
        };
        games.set(key, game);
      }
      if (!hadId && legacyId !== game.id) game.legacy.add(legacyId);
      if (title && (!game.title || title.length > game.title.length)) game.title = title;
      if (!game.region) game.region = regionOf(serial);
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
          n: String(c.n || '(unnamed)').trim(),
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

  /* ---------------------------------------------------------------- titles --- */

  let customTitles = {};
  if (fs.existsSync(TITLES_FILE)) {
    try {
      customTitles = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8'));
    } catch (e) {
      console.warn(`warning     : failed to parse ${TITLES_FILE}: ${e.message}`);
    }
  }

  const nextTitles = { ...customTitles };
  let manualCount = 0;
  let rehomed = 0;

  for (const g of games.values()) {
    // Manual override by ID ("PS4-CUSA00123"), Serial ("CUSA00123"), Key
    // ("PS4|CUSA00123") or by the synthetic id the game had before the serial
    // was known ("PS3-x-bayonetta").
    const candidates = [
      g.id,
      g.serial, g.serial && g.serial.toUpperCase(), g.serial && g.serial.toLowerCase(),
      g.key,
      ...g.legacy,
    ];
    let custom = '';
    let sourceKey = '';
    for (const c of candidates) {
      if (!c) continue;
      const v = customTitles[c];
      if (typeof v !== 'string') continue;
      const value = v.trim();
      // titles.json also stores the generated title of every game, so a value
      // equal to the generated one is not an override: keep looking for a real
      // edit (it may live under an older key, e.g. the synthetic "PS3-x-...").
      if (!value || value === g.title) continue;
      custom = value;
      sourceKey = c;
      break;
    }
    if (custom) {
      if (g.title !== custom) manualCount++;
      if (sourceKey !== g.id) rehomed++;
      g.title = custom;
    }
    // Always stored under the canonical id, so a title that used to live under a
    // synthetic key is re-homed here and the stale key is dropped just below.
    nextTitles[g.id] = g.title;
  }

  // Drop keys that match no game any more (upstream file renamed, or the file
  // merged into a game that now has a real id). Without this they pile up
  // forever, since the file is only ever merged with - never rebuilt.
  const validKeys = new Set();
  for (const g of games.values()) {
    validKeys.add(g.id);
    validKeys.add(g.key);
    if (g.serial) {
      validKeys.add(g.serial);
      validKeys.add(g.serial.toUpperCase());
      validKeys.add(g.serial.toLowerCase());
    }
  }
  const orphans = [];
  if (!KEEP_ORPHANS) {
    for (const k of Object.keys(nextTitles)) {
      if (validKeys.has(k)) continue;
      orphans.push(k);
      delete nextTitles[k];
    }
  }

  // Save/sync titles.json alphabetically so it is easy to browse, search, and edit
  const sortedTitles = {};
  for (const k of Object.keys(nextTitles).sort((a, b) => collator.compare(a, b))) {
    sortedTitles[k] = nextTitles[k];
  }
  fs.writeFileSync(TITLES_FILE, JSON.stringify(sortedTitles, null, 2) + '\n', 'utf8');

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
      r: g.region,
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
      region: g.region,
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
  if (fs.existsSync(TITLES_FILE)) fs.copyFileSync(TITLES_FILE, path.join(OUT, 'titles.json'));

  const indexBytes = fs.statSync(path.join(OUT, 'data', 'index.json')).size;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const staleOverrides = [...serialOverrides.keys()].filter((k) => !usedOverrides.has(k));
  console.log(`sources     : ${SOURCES.map((s) => `${s.id}=${bySource[s.id].files}`).join('  ')}`);
  console.log(`files       : ${stats.files} read, ${stats.skipped} without cheats`);
  console.log(`games       : ${list.length}`);
  console.log(`titles      : ${Object.keys(sortedTitles).length} in ${path.basename(TITLES_FILE)} (${manualCount} manual, ${rehomed} re-homed, ${orphans.length} orphan keys dropped)`);
  console.log(`serial map  : ${serialOverrides.size} entries, ${stats.mapped} applied, ${serialMap.pending} pending, ${staleOverrides.length} unused`);
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
  if (orphans.length) {
    console.log(`\norphan titles dropped (${orphans.length}) - no file matches them any more:`);
    for (const k of orphans.slice(0, 10)) console.log('  - ' + k);
    if (orphans.length > 10) console.log(`  ... and ${orphans.length - 10} more`);
  }
  if (staleOverrides.length) {
    console.log(`\nunused tools/serials.json entries (${staleOverrides.length}) - file name changed upstream?`);
    for (const k of staleOverrides.slice(0, 10)) console.log('  - ' + k);
    if (staleOverrides.length > 10) console.log(`  ... and ${staleOverrides.length - 10} more`);
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
