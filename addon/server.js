#!/usr/bin/env node
// Nepu as a Stremio-style addon for Nuvio, meant to run on a device on YOUR home network (nepu.is's Cloudflare cookie only works
// from the IP that solved the challenge). Zero dependencies, Node >= 18.   node addon/server.js
//
// It loads ../providers/nepu.js unchanged (same code path as the plugin) inside a vm sandbox and adds:
//   * IMDb/TMDB id handling (Nuvio sends tt... or tmdb:...)
//   * a persistent cache for the slow, stable requests (TMDB lookups 30 d, nepu search/title pages 12 h) so reopening a title only
//     needs the one request that cannot be cached: POST /ajax/embed (its relay URL is single-session, never cached)
//   * Node's keep-alive connections to nepu.is (the plugin in the app opens a fresh one per request)
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib'), crypto = require('crypto'), os = require('os');

const PROVIDER = path.join(__dirname, '..', 'providers', 'nepu.js');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { /* optional */ }
const PORT = +process.env.PORT || cfg.port || 7861;
const HOST = process.env.HOST || cfg.host || '0.0.0.0';
const VERBOSE = !!process.env.VERBOSE;
// optional overrides; otherwise the constants at the top of providers/nepu.js are used
const settings = {};
if (cfg.cf_clearance) settings.cf_clearance = cfg.cf_clearance;
if (cfg.user_agent) settings.user_agent = cfg.user_agent;

const code = fs.readFileSync(PROVIDER, 'utf8');
const script = new vm.Script(code, { filename: 'nepu.js' });
const TMDB_KEY = (/var TMDB_API_KEY = '([^']+)'/.exec(code) || [])[1];
if (!TMDB_KEY) throw new Error('TMDB_API_KEY not found in providers/nepu.js');
const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')).version) || '1.0.0';

// ---------------------------------------------------------------------------------------------------------------------------
// persistent cache (gzip files) + small in-memory layer
// ---------------------------------------------------------------------------------------------------------------------------
const CACHE_DIR = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const MEM_MAX = 40;
const mem = new Map();
const DAY = 864e5, HOUR = 36e5;

const fileOf = k => path.join(CACHE_DIR, crypto.createHash('sha1').update(k).digest('hex') + '.gz');
function ttlFor(u) {
  let x; try { x = new URL(u); } catch (e) { return 0; }
  if (x.hostname === 'api.themoviedb.org') return 30 * DAY;
  if (x.hostname === 'nepu.is' && /^\/(search|movie|show)\//.test(x.pathname)) return 12 * HOUR;
  return 0;
}
function cacheGet(k, ttl) {
  let e = mem.get(k);
  if (!e) { try { e = JSON.parse(zlib.gunzipSync(fs.readFileSync(fileOf(k)))); } catch (_) { return null; } }
  if (Date.now() - e.t > ttl) return null;
  mem.delete(k); mem.set(k, e);                       // refresh LRU position
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
  return e;
}
function cacheSet(k, body, ctype) {
  const e = { t: Date.now(), body, ctype };
  mem.delete(k); mem.set(k, e);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
  fs.writeFile(fileOf(k), zlib.gzipSync(JSON.stringify(e)), () => { });
}
function cacheDel(k) { mem.delete(k); try { fs.unlinkSync(fileOf(k)); } catch (_) { } }
function prune() {   // drop expired files at startup so the cache dir cannot grow forever
  let n = 0;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const p = path.join(CACHE_DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 30 * DAY) { fs.unlinkSync(p); n++; } } catch (_) { }
  }
  return n;
}

// fetch handed to the provider: caches the stable GETs, passes everything else (the /ajax/embed POST) straight through
function makeFetch(touched) {
  return async function (url, opts) {
    const u = String(url);
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const ttl = method === 'GET' ? ttlFor(u) : 0;
    const nepu = u.indexOf('https://nepu.is/') === 0;
    if (ttl) {
      const e = cacheGet(u, ttl);
      if (e) { touched.push({ k: u, hit: true, nepu }); return new Response(e.body, { status: 200, headers: { 'content-type': e.ctype || 'text/html' } }); }
    }
    const r = await fetch(u, opts);
    if (!ttl || r.status !== 200) return r;
    const body = await r.text();
    const ctype = r.headers.get('content-type') || 'text/html';
    if (body.length > 500) cacheSet(u, body, ctype);
    touched.push({ k: u, hit: false, nepu });
    return new Response(body, { status: 200, headers: { 'content-type': ctype } });
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Nuvio id -> TMDB id
// ---------------------------------------------------------------------------------------------------------------------------
async function resolveIds(type, rawId) {
  const parts = decodeURIComponent(rawId).split(':');
  if (parts[0] === 'tmdb' && /^\d+$/.test(parts[1] || '')) return { tmdb: parts[1], season: parts[2], episode: parts[3] };
  if (!/^tt\d+$/.test(parts[0])) return null;
  const f = makeFetch([]);
  const r = await f('https://api.themoviedb.org/3/find/' + parts[0] + '?api_key=' + TMDB_KEY + '&external_source=imdb_id');
  if (!r.ok) return null;
  const d = await r.json();
  const first = type === 'series' ? (d.tv_results || [])[0] || (d.movie_results || [])[0] : (d.movie_results || [])[0] || (d.tv_results || [])[0];
  return first ? { tmdb: String(first.id), season: parts[1], episode: parts[2] } : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// run the provider
// ---------------------------------------------------------------------------------------------------------------------------
function runProvider(tmdbId, mediaType, season, episode, touched) {
  const logs = [];
  const sb = { console: { log: (...a) => logs.push(a.join(' ')) }, fetch: makeFetch(touched), setTimeout, clearTimeout, SCRAPER_SETTINGS: settings };
  sb.global = sb;
  vm.createContext(sb);
  script.runInContext(sb);
  return sb.getStreams(String(tmdbId), mediaType, season ? +season : undefined, episode ? +episode : undefined).then(streams => ({ streams, logs }));
}

const inflight = new Map();
function streamsFor(type, id) {
  const key = type + '/' + id;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const ids = await resolveIds(type, id);
    if (!ids) return { streams: [], logs: ['unsupported or unknown id ' + id], hits: 0 };
    const mt = type === 'series' ? 'tv' : 'movie';
    let touched = [];
    let r = await runProvider(ids.tmdb, mt, ids.season, ids.episode, touched);
    let hits = touched.filter(x => x.hit).length;
    const stale = touched.filter(x => x.hit && x.nepu);
    if (!r.streams.length && stale.length) {          // a cached page may be outdated (site re-uploaded): drop it and try once live
      stale.forEach(x => cacheDel(x.k));
      touched = [];
      r = await runProvider(ids.tmdb, mt, ids.season, ids.episode, touched);
      r.logs.unshift('retried live after dropping ' + stale.length + ' cached page(s)');
    }
    return { streams: r.streams, logs: r.logs, hits };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function toStremio(s) {
  return {
    name: s.name,
    title: s.title,
    description: s.description,
    url: s.url,
    behaviorHints: { notWebReady: true, bingeGroup: 'nepu-' + s.quality, proxyHeaders: { request: s.headers } }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------------------
const MANIFEST = {
  id: 'local.nepu.addon',
  version: VERSION,
  name: 'Nepu',
  description: 'nepu.is (Full HD + 4K) via your own home network',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb:'],
  catalogs: []
};

function send(res, status, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/manifest.json') return send(res, 200, MANIFEST);
    const m = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(url.pathname);
    if (m) {
      const r = await streamsFor(m[1], m[2]);
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + m[1] + ' ' + decodeURIComponent(m[2]) + ' -> ' + r.streams.length + ' stream(s), ' + (Date.now() - t0) + ' ms, ' + r.hits + ' cache hit(s)');
      if (VERBOSE || !r.streams.length) r.logs.forEach(l => console.log('    ' + l));
      return send(res, 200, { streams: r.streams.map(toStremio) });
    }
    if (url.pathname === '/') return send(res, 200, 'Nepu addon running. Add this in Nuvio:  http://<this device IP>:' + PORT + '/manifest.json\n');
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.log('ERROR', req.url, e && e.stack || e);
    send(res, 500, { streams: [], error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const pruned = prune();
  console.log('Nepu addon v' + VERSION + ' listening on ' + HOST + ':' + PORT + (pruned ? ' (pruned ' + pruned + ' old cache files)' : ''));
  const urls = ['http://127.0.0.1:' + PORT + '/manifest.json'];
  try {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(n => ifs[n].forEach(a => { if (a.family === 'IPv4' && !a.internal) urls.push('http://' + a.address + ':' + PORT + '/manifest.json'); }));
  } catch (e) { /* some Android builds block interface listing */ }
  console.log('Add one of these in Nuvio (Addons):\n  ' + urls.join('\n  '));
});
