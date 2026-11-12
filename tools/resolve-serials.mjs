#!/usr/bin/env node
/**
 * resolve-serials.mjs - builds/refreshes tools/serials.json.
 *
 * Some upstream cheat files carry no title id in the name (mostly
 * bucanero/ArtemisPS3 .ncl files: "Bayonetta.ncl" instead of
 * "Bayonetta BLES00599 01.00.ncl"). Without an id the site cannot group those
 * cheats with the game they belong to, so build-site.mjs reads a curated map:
 *
 *   tools/serials.json
 *   {
 *     "Bayonetta.ncl": ["BLES00599", "BLUS30367"],   <- first id is the primary
 *     "Daytona USA 01.00.ncl": null                  <- still unknown, fill by hand
 *   }
 *
 * This script proposes the entries by looking for another file in the same
 * source folder with the same game title and a real id. Proposals are never
 * written over an existing non-empty value: manual work is preserved.
 *
 * Usage:
 *   node tools/resolve-serials.mjs              # writes tools/serials.json
 *   node tools/resolve-serials.mjs --dry-run    # only prints the report
 *   node tools/resolve-serials.mjs --suggest    # shows near matches for the gaps
 *
 * No external dependencies (Node 18+).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ROOT = path.resolve(String(arg('root', path.join(HERE, '..'))));
const OUT_FILE = path.resolve(String(arg('out', path.join(ROOT, 'tools', 'serials.json'))));
const DRY = !!arg('dry-run', false);
const SUGGEST = !!arg('suggest', false);
const DIRS = String(arg('sources', 'PS3-ArtemisDB,PS3-game-cheats')).split(',').map((s) => s.trim()).filter(Boolean);

const SERIAL_RE = /\b([A-Z]{4}-?\d{5,6})\b/;
const EXT_RE = /\.(ncl|txt|json)$/i;

function serialOf(text) {
  const m = String(text || '').toUpperCase().match(SERIAL_RE);
  return m ? m[1].replace(/-/g, '') : '';
}

/** Same title extraction used by build-site.mjs, so the keys line up. */
function titleFromFile(file) {
  let base = file.replace(EXT_RE, '');
  base = base.replace(SERIAL_RE, ' ');
  base = base.replace(/\bav\d{2}\.\d{2}\b/gi, ' ');
  base = base.replace(/\bv\d{2}\.\d{2}\b/gi, ' ');
  base = base.replace(/\b\d{2}\.\d{2}\b/g, ' ');
  base = base.replace(/\s+/g, ' ').trim();
  base = base.replace(/\s+(?:NPEB|NPUB|NPJB|NPEA|NPUA|BLES|BLUS|BLJM|BLAS|BCAS|BLKS|BCES|BCUS)$/i, '');
  return base.replace(/[-_–]+$/g, '').trim();
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const STOPWORDS = new Set(['the', 'and', 'of', 'for', 'to', 'in', 'de', 'la', 'le', 'les', 'el', 'los', 'las']);

function tokens(text) {
  const out = new Set();
  for (const t of norm(text).split(' ')) {
    if (!t || STOPWORDS.has(t)) continue;
    // keep numbers ("shift 2" is not "shift") and drop plural noise ("marvels")
    if (t.length === 1 && !/^\d$/.test(t)) continue;
    out.add(t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
  }
  return out;
}

/** Order-independent title key: "Mirror's Edge" and "Mirror Edge" match. */
function titleKey(text) {
  return [...tokens(text)].sort().join(' ');
}

/**
 * Which id should own the game page when a file maps to several releases.
 * Europe/America first (biggest catalogues), then the rest, digital last.
 */
const PREFERRED = ['BLES', 'BLUS', 'BLJM', 'BCES', 'BCUS', 'BLJS', 'BLAS', 'BCAS', 'BLKS', 'SLES', 'SLUS'];
function rank(id) {
  const i = PREFERRED.indexOf(String(id).slice(0, 4));
  return i === -1 ? PREFERRED.length : i;
}
function byPreference(a, b) {
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Jaccard similarity between two titles, 0..1. */
function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / (ta.size + tb.size - hit);
}

function walk(dir, prefix, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) { walk(path.join(dir, entry.name), prefix + entry.name + '/', out); continue; }
    if (!EXT_RE.test(entry.name)) continue;
    out.push({ file: entry.name, rel: prefix + entry.name });
  }
}

function main() {
  let existing = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) || {};
    } catch (e) {
      console.error(`error: cannot parse ${OUT_FILE}: ${e.message}`);
      process.exit(1);
    }
  }

  const known = new Map();      // rel path -> ids already curated
  for (const [k, v] of Object.entries(existing)) {
    const ids = (Array.isArray(v) ? v : [v]).map((x) => serialOf(x)).filter(Boolean);
    if (ids.length) known.set(k, [...new Set(ids)]);
  }

  const stats = { files: 0, withId: 0, missing: 0, proposed: 0, multi: 0, fuzzy: 0, pending: 0, kept: 0 };
  const proposals = new Map();
  const unresolved = [];
  const fuzzy = [];
  const seenFiles = new Set();

  for (const dirName of DIRS) {
    const dir = path.join(ROOT, dirName);
    if (!fs.existsSync(dir)) {
      console.warn(`warning: ${dirName} does not exist, skipped`);
      continue;
    }
    const files = [];
    walk(dir, '', files);
    stats.files += files.length;

    const byTitle = new Map();  // normalised title -> ids
    const byKey = new Map();    // order-independent token key -> ids
    for (const { file, rel } of files) {
      seenFiles.add(rel);
      seenFiles.add(file);
      const id = serialOf(file);
      if (!id) continue;
      stats.withId++;
      const title = titleFromFile(file);
      const t = norm(title);
      const k = titleKey(title);
      if (t) {
        if (!byTitle.has(t)) byTitle.set(t, new Set());
        byTitle.get(t).add(id);
      }
      if (k) {
        if (!byKey.has(k)) byKey.set(k, new Set());
        byKey.get(k).add(id);
      }
    }

    for (const { file, rel } of files) {
      if (serialOf(file)) continue;
      stats.missing++;
      if (known.has(rel) || known.has(file)) { stats.kept++; continue; }
      const title = titleFromFile(file);
      const exact = byTitle.get(norm(title));
      const loose = exact ? null : byKey.get(titleKey(title));
      const ids = [...(exact || loose || [])].sort(byPreference);
      if (ids.length) {
        proposals.set(rel, ids);
        stats.proposed++;
        if (ids.length > 1) stats.multi++;
        if (!exact) { stats.fuzzy++; fuzzy.push({ file, ids }); }
      } else {
        proposals.set(rel, null);
        stats.pending++;
        unresolved.push({ dir: dirName, file, rel, title });
      }
    }
  }

  // keep manual entries, add the new proposals, drop entries whose file vanished
  const merged = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!seenFiles.has(k)) continue;   // stale: file no longer exists
    merged[k] = v;
  }
  let added = 0;
  let filled = 0;
  for (const [k, v] of proposals) {
    if (merged[k] != null) continue;   // a curated value always wins
    if (k in merged) filled++; else added++;
    merged[k] = v;
  }
  const sorted = {};
  for (const k of Object.keys(merged).sort((a, b) => a.localeCompare(b))) sorted[k] = merged[k];

  const pendingTotal = Object.values(sorted).filter((v) => v == null).length;

  console.log(`sources     : ${DIRS.join(', ')}`);
  console.log(`files       : ${stats.files} read, ${stats.withId} with an id, ${stats.missing} without`);
  console.log(`curated     : ${stats.kept} already in the map (kept as is)`);
  console.log(`proposed    : ${stats.proposed} resolved by title (${stats.multi} with several ids)`);
  console.log(`pending     : ${stats.pending} to fill by hand`);
  console.log(`map         : ${Object.keys(sorted).length} entries -> ${path.relative(ROOT, OUT_FILE)}`);

  if (fuzzy.length) {
    console.log(`\nreview these ${fuzzy.length} loose match(es) - punctuation/word order differ:`);
    for (const f of fuzzy) console.log(`  ${f.file}  ->  ${f.ids.slice(0, 4).join(', ')}${f.ids.length > 4 ? ' ...' : ''}`);
  }

  if (DRY) {
    console.log('\n(dry run: file not written)');
  } else {
    fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    console.log(`written     : ${added} new, ${filled} filled`);
  }

  if (SUGGEST && unresolved.length) {
    console.log(`\nnear matches for the ${unresolved.length} pending file(s):`);
    const serialedTitles = [];
    for (const dirName of DIRS) {
      const dir = path.join(ROOT, dirName);
      if (!fs.existsSync(dir)) continue;
      const files = [];
      walk(dir, '', files);
      for (const { file } of files) {
        const id = serialOf(file);
        if (id) serialedTitles.push({ title: titleFromFile(file), id });
      }
    }
    for (const item of unresolved.slice(0, 40)) {
      const seen = new Set();
      const ranked = serialedTitles
        .map((c) => ({ ...c, score: similarity(item.title, c.title) }))
        .filter((c) => c.score >= 0.7)
        .sort((a, b) => b.score - a.score)
        .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
        .slice(0, 2);
      const hint = ranked.length
        ? ranked.map((c) => `${c.id} (${Math.round(c.score * 100)}%)`).join('  ')
        : 'no close match';
      console.log(`  ${item.file}  ->  ${hint}`);
    }
    if (unresolved.length > 40) console.log(`  ... and ${unresolved.length - 40} more`);
  }

  if (pendingTotal) {
    console.log(`\nnote: ${pendingTotal} entr${pendingTotal === 1 ? 'y is' : 'ies are'} null in the map. ` +
      'Fill them by hand (or run with --suggest) so those games get an id.');
  }
}

main();
