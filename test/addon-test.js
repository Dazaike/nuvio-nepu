// Calls the running addon like Nuvio does (cold, then warm) and plays every returned stream with the headers the addon hands out.
//   node test/addon-test.js [baseUrl]
const base = process.argv[2] || 'http://127.0.0.1:7861';
const T = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);

async function play(s) {
  const h = s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request;
  const r = await T(fetch(s.url, { headers: h }), 30000);
  const body = await r.text();
  if (!r.ok || body.indexOf('#EXTM3U') !== 0) return 'FAIL playlist ' + r.status;
  const segs = body.split('\n').filter(l => /^https?:/.test(l));
  const x = await T(fetch(segs[segs.length >> 1], { headers: { Range: 'bytes=0-1023' } }), 30000);
  return (x.status === 206 || x.status === 200 ? 'PASS ' : 'FAIL ') + segs.length + ' segs, middle seg ' + x.status;
}

(async () => {
  const m = await (await fetch(base + '/manifest.json')).json();
  console.log('manifest:', m.name, 'v' + m.version, 'resources', m.resources, 'types', m.types, 'idPrefixes', m.idPrefixes);
  const cases = [['movie', 'tt0137523', 'Fight Club (imdb)'], ['movie', 'tmdb:603', 'The Matrix (tmdb)'], ['series', 'tt0944947:1:1', 'GoT S1E1 (imdb)'], ['series', 'tmdb:60625:1:1', 'Rick and Morty (tmdb)'], ['movie', 'tt9999999', 'unknown imdb id']];
  let ok = 0, total = 0;
  for (const [type, id, label] of cases) {
    const row = [];
    for (const pass of ['cold', 'warm']) {
      const t0 = Date.now();
      const r = await fetch(base + '/stream/' + type + '/' + encodeURIComponent(id) + '.json');
      const j = await r.json();
      row.push(pass + ' ' + (Date.now() - t0) + ' ms / ' + j.streams.length + ' streams');
      if (pass === 'warm' && j.streams.length) {
        for (const s of j.streams.filter(x => !/^Nepu (ERROR|INFO)/.test(x.name))) { const p = await play(s); total++; if (p.startsWith('PASS')) ok++; row.push('   ' + s.name + ': ' + p); }
        for (const s of j.streams.filter(x => /^Nepu (ERROR|INFO)/.test(x.name))) row.push('   (diagnostic row) ' + s.name);
      }
    }
    console.log(label.padEnd(26), row.join(' | '));
  }
  console.log('\n' + ok + '/' + total + ' warm streams played (playlist + middle segment)');
  process.exit(ok === total && total > 0 ? 0 : 1);
})();
