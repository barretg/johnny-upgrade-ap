// Which map the solver is solving.
//
// Everything downstream (fastsim, physics, locations, the atlas) used to hardcode
// `require('./data/maps.js')[1]`, so the solver could only ever answer questions about the
// vanilla level. This module is the single place that decision is made:
//
//   JU_MAP unset            -> data/maps.js[1], byte-identically to before
//   JU_MAP=<path to json>   -> that map, in either the editor's object format or the game's
//
// Editor-format files are translated with mapkit/mapformat.js's `toGame`. That translator is
// deliberately the only one in the repo -- a second implementation here would drift from the
// one the editor and the runtime share, and a drifting translator means logic derived for a
// map that is not the map the player loads.
//
// `id()` is the map's identity everywhere downstream: it goes into solver/settings.js (so
// atlas.js refuses to mix results across maps) and into the atlas directory name.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

let cachedMap = null;
let cachedId;

/** Resolve JU_MAP against the cwd first, then the repo root, so both are convenient. */
function resolveMapPath(raw) {
  const candidates = [path.resolve(process.cwd(), raw), path.resolve(ROOT, raw)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    `JU_MAP=${raw} not found (looked in ${candidates.join(' and ')})`
  );
}

/** The path JU_MAP names, or null when the solver is running on the vanilla map. */
function sourcePath() {
  const raw = process.env.JU_MAP;
  return raw ? resolveMapPath(raw) : null;
}

const isCustom = () => sourcePath() !== null;

/** The game-format map to solve. Cached: every consumer must see the same object. */
function load() {
  if (cachedMap) return cachedMap;
  const p = sourcePath();
  if (!p) {
    cachedMap = require('./data/maps.js')[1];
    return cachedMap;
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Editor format is recognised by its flat object list; anything else is already game format.
  cachedMap = Array.isArray(raw.objects) ? require('../mapkit/mapformat').toGame(raw) : raw;
  return cachedMap;
}

// Key-sorted stringify, so a map's identity does not depend on the key order a tool happened
// to write, only on what the map actually contains.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * Short hash of the map being solved, or null for vanilla.
 *
 * Null rather than a hash for vanilla on purpose: settings.js only adds `mapId` when there is
 * one, so an existing vanilla atlas keeps matching its own settings.json and does not have to
 * be rebuilt for this change.
 *
 * `meta` is excluded -- it is editor/generator provenance (module names, positions) that
 * iniLevel never reads and that cannot change what the simulation does.
 */
function id() {
  if (cachedId !== undefined) return cachedId;
  if (!isCustom()) {
    cachedId = null;
    return cachedId;
  }
  const m = load();
  const forHash = Object.assign({}, m);
  delete forHash.meta;
  delete forHash.art; // decoration only; the game never collides with it
  cachedId = crypto.createHash('sha1').update(canonical(forHash)).digest('hex').slice(0, 12);
  return cachedId;
}

module.exports = { load, id, isCustom, sourcePath };
