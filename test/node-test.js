// Runs the provider in a restricted vm context that looks like Nuvio's QuickJS runtime (no Buffer / TextEncoder / URL / process; only
// fetch, console and timers from the host), then plays the first stream the way a player would: playlist, then a segment from the
// start and one from the middle.   node test/node-test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const secrets = require('../.secrets/cf.json');
const file = process.env.PROVIDER_FILE || path.join(__dirname, '..', 'providers', 'nepu.js');
let code = fs.readFileSync(file, 'utf8');
if (/__CF_CLEARANCE__/.test(code) || process.env.USE_SECRETS) {
  code = code.replace("var CF_CLEARANCE = '__CF_CLEARANCE__';", "var CF_CLEARANCE = " + JSON.stringify(secrets.cf_clearance) + ";").replace(/var USER_AGENT = '[^']*';/, 'var USER_AGENT = ' + JSON.stringify(secrets.ua) + ';');
}
if (/__[A-Z_]+__/.test(code.replace(/'__CF_CLEARANCE__'/g, ''))) { console.error('unfilled placeholder left in provider'); process.exit(1); }

const logs = [];
const sandbox = { console: { log: (...a) => logs.push(a.join(' ')) }, fetch: (u, o) => fetch(u, o), setTimeout, clearTimeout };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const getStreams = sandbox.getStreams;
if (typeof getStreams !== 'function') throw new Error('provider did not define global getStreams');

const cases = [
  ['movie 550 (Fight Club)', ['550', 'movie']],
  ['movie 603 (The Matrix, has [4K])', ['603', 'movie']],
  ['tv 1399 S1E1 (Game of Thrones)', ['1399', 'tv', 1, 1]],
  ['tv 60625 S1E1 (Rick and Morty)', ['60625', 'tv', 1, 1]],
  ['movie 1 (no such title on nepu?)', ['999999999', 'movie']],
];
const T = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);

async function play(s) {
  const steps = [];
  const r = await T(fetch(s.url, { headers: s.headers }), 30000);
  const body = await r.text();
  if (!r.ok || body.indexOf('#EXTM3U') !== 0) return { ok: false, steps: ['playlist ' + r.status + ' ' + body.slice(0, 60).replace(/\s+/g, ' ')] };
  const segs = body.split('\n').filter(l => /^https?:/.test(l));
  steps.push('playlist 200 ' + (body.length >> 10) + 'KB ' + segs.length + ' segs');
  for (const [n, i] of [['seg first', 0], ['seg middle', segs.length >> 1]]) {
    const x = await T(fetch(segs[i], { headers: { Range: 'bytes=0-1023' } }), 30000);
    steps.push(n + ' ' + x.status);
    if (x.status !== 206 && x.status !== 200) return { ok: false, steps };
  }
  return { ok: true, steps };
}

(async () => {
  const rows = []; let pass = 0, expected = 0;
  for (const [name, args] of cases) {
    logs.length = 0;
    const t0 = Date.now();
    const all = await getStreams.apply(null, args);
    const diag = all.filter(s => s.quality === 'ERROR'), out = all.filter(s => s.quality !== 'ERROR');
    const ms = Date.now() - t0;
    if (!out.length) { rows.push([name, 'NO STREAM', diag.map(d => d.name).join('<br>'), ms]); console.log('\n---', name, '\n' + logs.join('\n')); continue; }
    const results = [];
    for (const s of out) { const p = await play(s); results.push(s.name + ': ' + (p.ok ? 'PASS ' : 'FAIL ') + p.steps.join(', ')); if (p.ok) pass++; expected++; }
    rows.push([name, out.length + ' stream(s)', results.join('<br>'), ms]);
    console.log('\n---', name, '\n' + logs.join('\n'));
  }
  console.log('\n| case | streams | playback check | getStreams ms |\n|---|---|---|---|');
  rows.forEach(r => console.log('| ' + r.join(' | ') + ' |'));
  console.log('\n' + pass + '/' + expected + ' returned streams played (playlist + first + middle segment)');
  process.exit(pass === expected && expected > 0 ? 0 : 1);
})();
