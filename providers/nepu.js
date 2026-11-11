// Nepu (nepu.is) provider for Nuvio. Promise-based on purpose (no async/await), plain ES5.
//
// nepu.is sits behind a Cloudflare managed challenge. Passing it once in a normal browser sets an HttpOnly `cf_clearance` cookie
// (valid about a year, bound to your public IP and to the browser's User-Agent). This provider replays that cookie + UA, exactly
// like the Vivarium provider does with its `vg` cookie.
//
// ============================================================================================================================
//  USER CONFIG  --  enter these in the app (Plugins > Nepu > Settings) or edit the two constants below
//
//  CF_CLEARANCE : value of the `cf_clearance` cookie of https://nepu.is
//                 DevTools -> Application -> Cookies -> https://nepu.is -> cf_clearance   (HttpOnly: not visible from the console)
//  USER_AGENT   : the EXACT User-Agent of the browser the cookie came from (console: navigator.userAgent)
//  WARNING      : if the repository is public, anyone can read the cookie; it only works from your IP + that User-Agent.
// ============================================================================================================================
var CF_CLEARANCE = 'CugeXaB8ZTZDbj_SGYrPzqhAMrKc3ZNFYCet9Ir8Kl8J62-zQc1_iZwzJ0_wqKCjt6b9K_oJi05EK_KRTgbzr3ZhbZRzOtFvFH6QKVIXXK5FzaKi5ivG4FVQoBsNyjJ7k4qir4fWwMMyLGd64g8WlTp5Qdj1R8fhknL13f-sPRgWZqKPoWYiIx3veh1sO-K_ABZRwKILo03xJS6HRAwq7_fs0UlRN9rOhtI6UkoTPBNMClGSAXTQVoufbPX_OKlq5xCIYn1bvQM63jqnQvFXrsQihLk4AEwQ3vgQbFHHd1tQqOE54gdSWal_yi4lHfBS5880vdIb9rk7dTf_mcY8Y68dMiXnsd2mjv0y2S3q-84aqTDzrT7-GP3xYE6U';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
// ============================================================================================================================

var SITE = 'https://nepu.is';
var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';   // same public key the other providers of this ecosystem use
var REQUEST_TIMEOUT_MS = 15000;
var YEAR_TOLERANCE = 1;
var DEBUG = true;
var T0 = Date.now();
function log() { if (DEBUG) console.log.apply(console, ['[Nepu +' + (Date.now() - T0) + 'ms]'].concat([].slice.call(arguments))); }

// ---------------------------------------------------------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------------------------------------------------------
function withTimeout(p, ms, what) {
  if (typeof setTimeout !== 'function') return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout ' + what)); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

// When nothing can be returned, hand back visible "Nepu ERROR: ..." rows so the app shows WHY (Nuvio only displays returned streams, not
// console logs). Set DIAGNOSTICS = false once everything works.
var DIAGNOSTICS = true;
// Addon mode (set by addon/server.js, never in the app): do not create the playlist URL now. The row carries "nepu-lazy:<embed id>|<page>"
// and the addon creates the playlist only when the player asks for it.
var LAZY_RELAY = false;
var problems = [];
function problem(msg) { problems.push(msg); log('PROBLEM', msg); }

function siteHeaders(extra) {
  var h = { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Cookie': 'cf_clearance=' + CF_CLEARANCE };
  for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k];
  return h;
}

function siteFetch(url, opts, what) {
  opts = opts || {};
  var o = { method: opts.method || 'GET', headers: siteHeaders(opts.headers) };
  if (opts.body != null) o.body = opts.body;
  return withTimeout(fetch(url, o), REQUEST_TIMEOUT_MS, what || url).then(function (r) {
    log('HTTP', r.status, what || url);
    if (r.status === 403) problem('403 Cloudflare rejected the cookie (' + (what || url) + ')');
    else if (!r.ok) problem('HTTP ' + r.status + ' on ' + (what || url));
    return r;
  }, function (e) {
    problem('network error on ' + (what || url) + ': ' + String(e && e.message || e));
    throw e;
  });
}

function siteText(url, opts, what) {
  return siteFetch(url, opts, what).then(function (r) { return r.ok ? r.text() : ''; });
}

// ---------------------------------------------------------------------------------------------------------------------------
// TMDB id -> title/year -> nepu page
// ---------------------------------------------------------------------------------------------------------------------------
function tmdbInfo(tmdbId, mediaType) {
  var isTv = mediaType === 'tv';
  var url = 'https://api.themoviedb.org/3/' + (isTv ? 'tv' : 'movie') + '/' + encodeURIComponent(tmdbId) + '?api_key=' + TMDB_API_KEY;
  return withTimeout(fetch(url, { headers: { 'Accept': 'application/json' } }), REQUEST_TIMEOUT_MS, 'tmdb').then(function (r) {
    return r.ok ? r.json() : null;
  }).then(function (d) {
    if (!d) return null;
    var titles = [];
    [isTv ? d.name : d.title, isTv ? d.original_name : d.original_title].forEach(function (t) { if (t && titles.indexOf(t) < 0) titles.push(t); });
    var date = (isTv ? d.first_air_date : d.release_date) || '';
    return { titles: titles, year: date ? parseInt(date.slice(0, 4), 10) : null };
  });
}

function decodeEntities(s) {
  return String(s || '').replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function norm(s) {
  s = String(s || '').toLowerCase();
  if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

// "[4K] The Matrix (1999) (1999)", "The Matrix [4K] (1999)", "Fight Club (1999)" -> { title, year, tag }
function parseCaption(text) {
  var t = decodeEntities(text).replace(/\s+/g, ' ').trim(), tag = '';
  t = t.replace(/\[([^\]]+)\]/g, function (m, g) { if (!tag) tag = g.toUpperCase(); return ' '; });
  var year = null, m;
  while ((m = /\s*\((\d{4})\)\s*$/.exec(t))) { if (year == null) year = parseInt(m[1], 10); t = t.slice(0, m.index); }
  return { title: t.replace(/\s+/g, ' ').trim(), year: year, tag: tag };
}

// poster anchor (/movie|show/<slug>) + caption anchor (class list-title; shows link it as /serie/..., so the poster href is used)
var RESULT_RE = /<a\s+href="(https?:\/\/nepu\.is\/(movie|show)\/[^"]+)"\s+class="list-media">[\s\S]*?<a\s+href="[^"]*"\s+class="list-title">\s*([\s\S]*?)\s*<\/a>/g;

function parseResults(html) {
  var out = [], seen = {}, m;
  RESULT_RE.lastIndex = 0;
  while ((m = RESULT_RE.exec(html))) {
    if (seen[m[1]]) continue;
    seen[m[1]] = 1;
    var c = parseCaption(m[3]);
    out.push({ url: m[1], kind: m[2], title: c.title, year: c.year, tag: c.tag });
  }
  return out;
}

// Full HD entry plus the separate [4K] entry of the same title, when nepu has one.
function pickMatches(results, info, mediaType) {
  var kind = mediaType === 'tv' ? 'show' : 'movie';
  var wanted = info.titles.map(norm);
  return results.filter(function (r) {
    if (r.kind !== kind) return false;
    if (r.tag && r.tag !== '4K') return false;   // [SUB] / [DUB] anime variants, [3D]
    if (wanted.indexOf(norm(r.title)) < 0) return false;
    if (info.year != null && r.year != null && Math.abs(r.year - info.year) > YEAR_TOLERANCE) return false;
    return true;
  }).map(function (r, i) { r.order = i; return r; }).sort(function (a, b) { return ((a.tag === '4K' ? 1 : 0) - (b.tag === '4K' ? 1 : 0)) || (a.order - b.order); });
}

function findPages(info, mediaType) {
  var tried = [];
  function next(i) {
    if (i >= info.titles.length) return Promise.resolve([]);
    var q = info.titles[i];
    return siteText(SITE + '/search/' + encodeURIComponent(q), null, 'search ' + q).then(function (html) {
      var results = parseResults(html), hits = pickMatches(results, info, mediaType);
      log('search', JSON.stringify(q), 'results', results.length, 'matches', hits.length);
      tried.push(q);
      return hits.length ? hits : next(i + 1);
    });
  }
  return next(0);
}

// ---------------------------------------------------------------------------------------------------------------------------
// page -> embed id -> relay playlist
// ---------------------------------------------------------------------------------------------------------------------------
function embedIds(html) {
  var ids = [], m, re = /data-embed="(\d+)"/g;
  while ((m = re.exec(html))) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
  return ids;
}

function sourceLabel(html) {
  var m = /class="source-selected"[^>]*>\s*([^<]+?)\s*</.exec(html);
  return m ? m[1] : '';
}

// POST /ajax/embed answers with a script holding a short-lived signed relay URL for the HLS playlist.
function relayUrl(embedId, pageUrl) {
  return siteFetch(SITE + '/ajax/embed', {
    method: 'POST',
    headers: { 'Referer': pageUrl, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: 'id=' + embedId
  }, 'ajax/embed ' + embedId).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
    var m = /relayManifestUrl\s*=\s*"([^"]+)"/.exec(t);
    if (!m) return null;
    var path;
    try { path = JSON.parse('"' + m[1] + '"'); } catch (e) { path = m[1].replace(/\\u0026/g, '&'); }
    return /^https?:/.test(path) ? path : SITE + path;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// stream object
//
// The relay playlist lives on nepu.is (behind Cloudflare), so the player must send the same cookie + User-Agent. Its segments sit
// on an open CDN (maho-cdn.com). A relay URL is single-session: it stays valid until it is first used, then for ~60 s, so URLs are
// minted fresh on every call and NEVER cached here.
// ---------------------------------------------------------------------------------------------------------------------------
function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

function deliver(url, c) {
  var is4k = c.p.tag === '4K';
  var title = c.p.title + (c.p.year ? ' (' + c.p.year + ')' : '') + (c.isTv ? ' S' + pad2(c.season || 1) + 'E' + pad2(c.episode || 1) : '');
  return {
    name: 'Nepu - ' + c.label,
    title: title,
    description: 'Nepu | ' + c.label + ' | HLS',
    url: url,
    quality: is4k ? '2160p' : '1080p',
    headers: { 'User-Agent': USER_AGENT, 'Cookie': 'cf_clearance=' + CF_CLEARANCE, 'Referer': SITE + '/' },
    subtitles: []
  };
}

function getStreams(tmdbId, mediaType, season, episode) {
  return fetchStreams(tmdbId, mediaType, season, episode);
}

// Values typed into the app (Nuvio: Plugins > Nepu > Settings) win over the constants above.
function applyAppSettings() {
  var s = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {};
  if (typeof s.cf_clearance === 'string' && s.cf_clearance) CF_CLEARANCE = s.cf_clearance;
  if (typeof s.user_agent === 'string' && s.user_agent) USER_AGENT = s.user_agent;
}

function diagRow(text) {
  return { name: text, title: text, description: text, url: SITE + '/', quality: 'ERROR', headers: {}, subtitles: [] };
}

function textOrQ(url) {
  return withTimeout(fetch(url), 6000, url).then(function (r) { return r.text(); }).then(function (t) { return String(t).replace(/\s+/g, ' ').slice(0, 60); }).catch(function () { return '?'; });
}

// which address does this device really use on the internet? (the Cloudflare cookie only works from the address that earned it)
function diagnose() {
  var why = problems.length ? problems.slice(0, 3) : ['no streams and no error (unknown reason)'];
  return Promise.all([textOrQ('https://api.ipify.org'), textOrQ('https://api64.ipify.org')]).then(function (ips) {
    var rows = why.map(function (w) { return diagRow('Nepu ERROR: ' + w); });
    rows.push(diagRow('Nepu INFO: this device reaches the internet as IPv4 ' + ips[0] + ' / preferred ' + ips[1]));
    return rows;
  });
}

function fetchStreams(tmdbId, mediaType, season, episode) {
  T0 = Date.now();
  problems = [];
  applyAppSettings();
  log('getStreams', tmdbId, mediaType, season, episode);
  if (!CF_CLEARANCE || CF_CLEARANCE.indexOf('__') === 0) { problem('CF_CLEARANCE is not set'); return DIAGNOSTICS ? diagnose() : Promise.resolve([]); }
  var isTv = mediaType === 'tv';

  return tmdbInfo(tmdbId, mediaType).then(function (info) {
    if (!info) { problem('TMDB lookup failed for id ' + tmdbId); return []; }
    log('tmdb', JSON.stringify(info));
    return findPages(info, mediaType).then(function (pages) {
      if (!pages.length) { problem('no nepu entry for ' + JSON.stringify(info.titles) + ' ' + info.year); return []; }
      var perTier = {};   // nepu keeps several uploads of one title: number them per tier ("Full HD", "Full HD (2)", ...)
      pages.forEach(function (p) { var t = p.tag === '4K' ? '4K' : 'HD'; perTier[t] = (perTier[t] || 0) + 1; p.n = perTier[t]; });
      return Promise.all(pages.map(function (p) {
        var pageUrl = isTv ? p.url + '/season/' + (season || 1) + '/episode/' + (episode || 1) : p.url;
        return siteText(pageUrl, null, 'page ' + pageUrl.replace(SITE, '')).then(function (html) {
          var ids = embedIds(html);
          if (!ids.length) { problem('no player on ' + pageUrl.replace(SITE, '')); return []; }
          var label = (p.tag === '4K' ? '4K' : (sourceLabel(html) || 'Full HD')) + (p.n > 1 ? ' (' + p.n + ')' : '');
          return Promise.all(ids.map(function (id) {
            if (LAZY_RELAY) return deliver('nepu-lazy:' + encodeURIComponent(id + '|' + pageUrl), { label: label, p: p, info: info, isTv: isTv, season: season, episode: episode });
            return relayUrl(id, pageUrl).then(function (url) {
              if (!url) { problem('no relay url for embed ' + id); return null; }
              return deliver(url, { label: label, p: p, info: info, isTv: isTv, season: season, episode: episode });
            });
          }));
        }).catch(function (e) { log('ERROR', pageUrl.replace(SITE, ''), String(e && e.message || e)); return []; });
      })).then(function (lists) {
        var out = [];
        lists.forEach(function (l) { (l || []).forEach(function (s) { if (s) out.push(s); }); });
        log('streams', out.length);
        return out;
      });
    });
  }).catch(function (e) { problem('FATAL ' + String(e && e.message || e)); return []; })
    .then(function (out) { return out.length || !DIAGNOSTICS ? out : diagnose(); });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams, _internals: { parseCaption: parseCaption, parseResults: parseResults, pickMatches: pickMatches, norm: norm, embedIds: embedIds } };
else global.getStreams = getStreams;
