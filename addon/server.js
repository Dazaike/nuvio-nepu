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
// The Cloudflare cookie belongs to the home IPv4 address. Without this, Node can reach nepu.is over IPv6 on a dual-stack network and get a 403.
// Two settings are needed: IPv4 first in DNS order, AND no happy-eyeballs race (otherwise a slow IPv4 connect lets an IPv6 attempt win).
require('dns').setDefaultResultOrder('ipv4first');
require('net').setDefaultAutoSelectFamily(false);

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
  sb.LAZY_RELAY = true;   // stream rows carry "nepu-lazy:" placeholders; /play/<token> creates the real playlist on demand
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

// "nepu-lazy:<embed id>|<page>" -> a URL on THIS server (same host the client used to reach us, so it works over LAN or Tailscale).
// The playlist is created when the player asks for it, so nothing expires while the list is on screen, and no cookie headers are
// needed on the stream: segments live on an open CDN.
function toStremio(s, origin) {
  const lazy = s.url.indexOf('nepu-lazy:') === 0;
  const o = {
    name: s.name,
    title: s.title,
    description: s.description,
    url: lazy ? origin + '/play/' + Buffer.from(decodeURIComponent(s.url.slice('nepu-lazy:'.length))).toString('base64url') + '.m3u8' : s.url,
    behaviorHints: { notWebReady: true, bingeGroup: 'nepu-' + s.quality }
  };
  if (!lazy) o.behaviorHints.proxyHeaders = { request: s.headers };
  return o;
}

// one long-lived sandbox for /play: only its relayUrl() / siteText() helpers are used
let playSb = null;
function playSandbox() {
  if (playSb) return playSb;
  const sb = { console: { log: (...a) => { if (VERBOSE) console.log('    [play] ' + a.join(' ')); } }, fetch: makeFetch([]), setTimeout, clearTimeout, SCRAPER_SETTINGS: settings };
  sb.global = sb;
  vm.createContext(sb);
  script.runInContext(sb);
  return (playSb = sb);
}

// Token = base64url("<embed id>|<page url>"): only [A-Za-z0-9_-], so nothing in the player's stack can decode or split it. (A first version
// put the percent-encoded URL in the path; something on the TV decoded it to "/play/123|https://nepu.is/..." and got a 404.)
// The decoded legacy form is still accepted.
function parseToken(token) {
  let raw = token;
  if (/^[A-Za-z0-9_-]+$/.test(token)) raw = Buffer.from(token, 'base64url').toString('utf8');
  else { try { raw = decodeURIComponent(token); } catch (e) { /* keep as is */ } }
  const i = raw.indexOf('|');
  const id = raw.slice(0, i), pageUrl = raw.slice(i + 1);
  return i > 0 && /^\d+$/.test(id) && /^https:\/\/nepu\.is\/(movie|show)\//.test(pageUrl) ? { id, pageUrl } : null;
}

// One tap makes the player ask several times within a second or two (size probe, ranged reads, the real read). Each used to create its own
// playlist (~1.5 s each); now they share one. Segment links stay valid far longer than this window (measured: still fine after 5 minutes).
const PLAY_TTL = 60 * 1000;
const playCache = new Map();
function playlistFor(token) {
  const t = parseToken(token);
  if (!t) return Promise.resolve(null);
  const hit = playCache.get(token);
  if (hit && Date.now() - hit.t < PLAY_TTL) return hit.p;
  const p = (async () => {
    const sb = playSandbox();
    sb.applyAppSettings();
    const relay = await sb.relayUrl(t.id, t.pageUrl);
    const text = relay ? await sb.siteText(relay, { headers: { Referer: t.pageUrl } }, 'playlist') : '';
    if (text.indexOf('#EXTM3U') !== 0) { cacheDel(t.pageUrl); return { error: relay ? 'playlist request failed' : 'no relay url (page may be outdated)' }; }
    return { text };
  })();
  playCache.set(token, { t: Date.now(), p });
  p.then(r => { if (!r.text) playCache.delete(token); }, () => playCache.delete(token));
  for (const [k, v] of playCache) if (Date.now() - v.t > PLAY_TTL) playCache.delete(k);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Segment proxy. The CDN ties each segment link to the IP that created the playlist (measured on the TV box: same link gives 206 over IPv4
// and 403 over IPv6, and the Nuvio TV app's player connects over IPv6 when it can). So the playlist handed to the player points at THIS
// server, which fetches the segment from the CDN over IPv4 only and streams it through, Range requests included.
// ---------------------------------------------------------------------------------------------------------------------------
const https = require('https');
const segAgent = new https.Agent({ keepAlive: true, family: 4, maxSockets: 32 });
const SEG_RE = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.maho-cdn\.com)\/cdn-m3u8\?payload=([A-Za-z0-9._~-]+)$/;
function rewriteSegments(text, origin) {
  let direct = 0;
  const out = text.split('\n').map(l => {
    const t = l.trim();
    if (!t || t[0] === '#') return l;
    const m = SEG_RE.exec(t);
    if (m) return origin + '/s/' + m[1] + '/' + m[2];
    direct++;
    return l;
  }).join('\n');
  if (direct) console.log('    warning: ' + direct + ' playlist line(s) did not match the CDN pattern and were left pointing at the CDN');
  return out;
}
// The CDN answers 429 when one IP opens many segment requests at once (12 parallel reads: 5 got 429), so at most SEG_MAX upstream requests run
// at a time; the rest queue. A 429/503 is retried with a short backoff; a stalled attempt (10 s of silence) or a reset connection is retried
// on a fresh connection. All of this only while nothing has been sent to the player yet.
const SEG_MAX = 3;
let segActive = 0;
const segQueue = [];
function segAcquire() {
  return new Promise(resolve => {
    const go = () => {
      segActive++;
      let released = false;
      resolve(() => { if (released) return; released = true; segActive--; const next = segQueue.shift(); if (next) next(); });
    };
    if (segActive < SEG_MAX) go(); else segQueue.push(go);
  });
}
async function proxySegment(req, res, host, payload) {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.maho-cdn\.com$/.test(host) || !/^[A-Za-z0-9._~-]+$/.test(payload)) return send(res, 400, 'bad segment');
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const release = await segAcquire();
  if (res.destroyed) return release();
  let cur = null, finished = false;
  const done = () => { if (!finished) { finished = true; release(); } };
  res.on('close', () => { if (!res.writableFinished && cur) cur.destroy(); done(); });
  (function attempt(n) {
    let gotResponse = false;
    const up = cur = https.request({ host, path: '/cdn-m3u8?payload=' + payload, method: req.method === 'HEAD' ? 'HEAD' : 'GET', agent: segAgent, family: 4, headers }, ur => {
      gotResponse = true;
      if ((ur.statusCode === 429 || ur.statusCode === 503) && n < 3 && !res.headersSent) {
        ur.resume();
        const wait = Math.min(2000, (+ur.headers['retry-after'] || 0) * 1000 || 300 * (n + 1));
        console.log('    segment upstream ' + ur.statusCode + ' on ' + host + ', retry ' + (n + 1) + ' in ' + wait + ' ms');
        return setTimeout(() => { if (!res.destroyed) attempt(n + 1); }, wait);
      }
      up.setTimeout(20000);
      const h = { 'Cache-Control': 'no-store' };
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (ur.headers[k]) h[k] = ur.headers[k];
      res.writeHead(ur.statusCode, h);
      ur.pipe(res);
      ur.on('error', () => res.destroy());
    });
    up.setTimeout(10000, () => up.destroy(new Error('timeout')));
    up.on('error', e => {
      if (res.headersSent || res.destroyed) return res.destroy();
      if (!gotResponse && n < 3) { console.log('    segment upstream ' + (e.code || e.message) + ' on ' + host + ', retry ' + (n + 1)); return attempt(n + 1); }
      send(res, 502, 'upstream ' + (e.code || e.message));
    });
    up.end();
  })(0);
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
  // access log: one line per request, so a failing player can be diagnosed from the log alone
  res.on('finish', () => { if (/^\/s\//.test(req.url) && res.statusCode < 400) return; console.log('  req ' + req.method + ' ' + String(req.url).slice(0, 70) + ' -> ' + res.statusCode + ' (' + (Date.now() - t0) + ' ms) ua=' + String(req.headers['user-agent'] || '-').slice(0, 40) + (req.headers.range ? ' range=' + req.headers.range : '') + (req.headers['accept-encoding'] ? ' ae=' + req.headers['accept-encoding'] : '') + ' bytes=' + (res.getHeader('content-length') || '?')); });
  res.on('close', () => { if (!res.writableFinished) console.log('  req ' + req.method + ' ' + String(req.url).slice(0, 70) + ' ABORTED by client after ' + (Date.now() - t0) + ' ms'); });
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/manifest.json') return send(res, 200, MANIFEST);
    const pm = /^\/play\/(.+?)\.m3u8$/.exec(url.pathname);
    if (pm) {
      const r = await playlistFor(pm[1]);
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] play -> ' + (r && r.text ? 'playlist ' + (r.text.length >> 10) + ' KB' : (r && r.error) || 'bad token') + ', ' + (Date.now() - t0) + ' ms');
      if (!r || !r.text) return send(res, r ? 502 : 400, r ? r.error : 'bad token');
      // Sent as-is, never compressed: some players ask for gzip themselves and then do not decompress (ExoPlayer: "Input does not start with the #EXTM3U header").
      const body = Buffer.from(rewriteSegments(r.text, 'http://' + (req.headers.host || ('127.0.0.1:' + PORT))), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(body);
    }
    const sm = /^\/s\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (sm) return proxySegment(req, res, sm[1], sm[2]);
    const m = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(url.pathname);
    if (m) {
      const r = await streamsFor(m[1], m[2]);
      console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + m[1] + ' ' + decodeURIComponent(m[2]) + ' -> ' + r.streams.length + ' stream(s), ' + (Date.now() - t0) + ' ms, ' + r.hits + ' cache hit(s)');
      if (VERBOSE || !r.streams.length) r.logs.forEach(l => console.log('    ' + l));
      return send(res, 200, { streams: r.streams.map(s => toStremio(s, 'http://' + (req.headers.host || ('127.0.0.1:' + PORT)))) });
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
