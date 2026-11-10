# nuvio-nepu

Nuvio local-scraper repository for [nepu.is](https://nepu.is). One provider, `nepu`, movies + TV, HLS (`m3u8`).
For a title it returns the Full HD upload, the separate `[4K]` upload when nepu has one, and any extra uploads of the same title
(numbered `Full HD (2)`, `4K (2)`, ...).

## Plugin or addon

nepu.is is behind a Cloudflare managed challenge. Passing it sets an HttpOnly `cf_clearance` cookie, valid about a year, **bound to the
public IP it was issued to** and to the browser's User-Agent. Replayed from a datacenter IP it is rejected: tested from Vercel
(egress 54.234.84.57), the request with the cookie got the same `403 cf-mitigated: challenge` as a request without it. So a hosted
(Vercel etc.) addon cannot work; whatever talks to nepu.is has to sit on the home network the cookie came from.

Two ways to run it, same code:

* **Plugin** (`providers/nepu.js`): runs inside Nuvio. Every open is 4 requests in a row (TMDB, search, page, embed), about 2 s on a PC and
  ~15 s measured on the TV.
* **Addon** (`addon/server.js`): a small Node server on a device at home. Nuvio makes one request to it; it loads `providers/nepu.js`
  unchanged and caches the stable lookups on disk (TMDB 30 d, nepu search and title pages 12 h), so a repeat open only needs the
  `/ajax/embed` request. Measured on a PC: cold about 2 s, warm about 0.55 s.

### Addon on the TV box (Termux)

    pkg install nodejs git
    git clone https://github.com/Dazaike/nuvio-nepu
    cd nuvio-nepu && termux-wake-lock && node addon/server.js

Then in Nuvio add the addon `http://127.0.0.1:7861/manifest.json` (same device) or `http://<device LAN IP>:7861/manifest.json` from another
device. Update with `git pull`. Optional `addon/config.json`: `{"cf_clearance": "...", "user_agent": "...", "port": 7861}` overrides the
values in `providers/nepu.js`. Nuvio sends `tt...` or `tmdb:...` ids; both work. Test: `node test/addon-test.js [baseUrl]`.

Cached pages that stop yielding a player are dropped and retried live automatically; delete `addon/cache/` to reset everything.

## The cookie (read this)

1. Open https://nepu.is in a normal browser on the same network as the Nuvio device, pass the check if asked.
2. DevTools -> Application -> Cookies -> `https://nepu.is` -> copy the value of `cf_clearance` (HttpOnly, not visible from the console).
   Copy the browser's UA from the console: `navigator.userAgent`.
3. Enter both in Nuvio: Plugins > Nepu > Settings. Or edit `CF_CLEARANCE` / `USER_AGENT` at the top of `providers/nepu.js`.

Redo this when the log says `403 from nepu.is` (cookie expired, or your public IP changed). The cookie is a CAPTCHA pass, not a login,
but if you commit it to a public repository anyone can read it (it only works from your IP + that User-Agent).

## How it works

    TMDB id --api.themoviedb.org--> title + year
    GET  /search/<title>            -> result cards; match normalised title + year (+/-1), skip [SUB]/[DUB]/[3D]; [4K] is its own entry
    GET  /movie/<slug>              (tv: /show/<slug>/season/S/episode/E) -> data-embed="<id>"
    POST /ajax/embed  id=<id>       (Referer = that page) -> script containing relayManifestUrl="/ajax/hls?f=..&e=..&s=<sig>"
    GET  /ajax/hls?...              -> single HLS media playlist (MPEG-TS), segments on an open CDN (maho-cdn.com)

The stream URL handed to the player is the `/ajax/hls` URL plus `Cookie: cf_clearance=...` and `User-Agent` headers.

Measured behaviour of the relay URL (Node, same IP as the cookie):

* unused: valid at least 400 s (its `e=` says 600 s)
* after its **first** use: still valid ~40 s, 410 at 60 s, 404 afterwards
* so it is minted fresh on every `getStreams` call and **never cached**, and the plugin never fetches the playlist itself
  (that would start the 60 s clock before the player gets it)

## Checks

    node test/node-test.js   # provider in a QuickJS-like sandbox for 5 cases, then playlist + first + middle segment of every returned stream

`test/node-test.js` reads the cookie from `.secrets/cf.json` (`{"cf_clearance": "...", "ua": "..."}`, git-ignored) when the provider file still has the placeholder.

## Known limits

* Not verified inside Nuvio itself: needs the app to pass `Cookie` / `User-Agent` on `fetch` and on the player's requests (the Vivarium provider relies on the same).
* The player fetches the playlist once. If it is slow to start (> ~6 min after the list was shown) the URL has expired: reopen the title.
* No subtitles yet (nepu has a cached-subtitle endpoint, not wired up).
* Season/episode numbers are nepu's own; they follow TMDB for normal shows but can differ for anime.
