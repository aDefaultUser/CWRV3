#!/usr/bin/env node
// Performance procedure against the production bundle (npm run build && npm run serve). Isolated Chromium
// (temporary profile, DevTools port 9333) on the hardware Vulkan adapter. Level 2 scenarios use the fixed archive
// volumes of public/perf-fixtures.json. Writes <out>/<date>-<label>.json with raw per-frame data.
// Usage: node tools/perf/run-bench.mjs <label> <mode: fixed4k|dpr15|dpr1|dpr2> --out <dir> [--fps 60|0] [--novsync]
//        [--headful] [--seconds 60] [--runs 3] [--scenarios idle,panzoom,l2loop,l3probe,stress] [--trace l2loop]
//        (further scenarios, not in the default list: l2volume and l2iso, the 3D volume view while orbiting the radar)
//        [--fixtures <dir with local copies of the fixture volumes, verified by SHA-256>]
// --fps sets the FPS target for the runs (0 = unlimited; omitted = the user's settings, unlimited by default);
// --novsync also disables the browser's vsync and frame-rate limit (headroom runs).
import { launch } from '../browser/cdp.mjs';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const label = args[0] ?? 'run', mode = args[1] ?? 'fixed4k';
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const novsync = args.includes('--novsync');
const fps = opt('--fps', null) === null ? null : Number(opt('--fps'));
const outDir = opt('--out', null);
if (!outDir) throw new Error('--out <dir> is required (results are kept outside the source tree)');
const headful = args.includes('--headful');
const seconds = Number(opt('--seconds', 60)), runs = Number(opt('--runs', 3));
const scenarios = opt('--scenarios', 'idle,panzoom,l2loop,l3probe,stress').split(',');
const traceScenario = opt('--trace', '');
const URL_ = process.env.APP_URL ?? 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// Verify local copies of the fixture volumes when a directory is given (--fixtures); the browser loads the same
// immutable archive objects from the public bucket.
const fixtures = JSON.parse(readFileSync('public/perf-fixtures.json', 'utf8'));
const fixtureDir = opt('--fixtures', null);
const fixtureCheck = fixtures.l2.files.map((f) => {
  if (!fixtureDir) return { name: f.name, local: false };
  const p = `${fixtureDir}/${f.name}`;
  if (!existsSync(p)) return { name: f.name, local: false };
  const ok = createHash('sha256').update(readFileSync(p)).digest('hex') === f.sha256;
  if (!ok) throw new Error(`fixture ${f.name} does not match its SHA-256`);
  return { name: f.name, local: true, sha256: f.sha256 };
});

// Window CSS size and DPR. fixed4k: 2560×1440 window with a fixed 3840×2160 backbuffer; dpr15: 2560×1440 CSS at
// DPR 1.5 = native 3840×2160; dpr1/dpr2: 2560×1440 at DPR 1 / 2.
const dims = { dpr15: [2560, 1440, 1.5], fixed4k: [2560, 1440, 1], dpr1: [2560, 1440, 1], dpr2: [2560, 1440, 2] }[mode];
const extra = novsync ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const b = await launch({ width: dims[0], height: dims[1], dpr: dims[2], headless: !headful, extraArgs: extra });
const env = {
  date: new Date().toISOString(), commit: sh('git rev-parse --short HEAD') + (sh('git status --porcelain') ? '+uncommitted' : ''), mode, fps, novsync, headful, seconds, runs,
  chromium: sh('chromium --version'), vulkan: sh('vulkaninfo --summary 2>/dev/null | grep -E "deviceName|driverName|driverInfo|apiVersion" | head -8'),
  cpu: sh("grep -m1 'model name' /proc/cpuinfo"), kernel: sh('uname -r'), fixtures: fixtureCheck,
};
const SETUP = {
  idle: "A.renderer.camera.setView({lon:-95,lat:39,z:163.75,tilt:0,swivel:0},true);",
  panzoom: "A.renderer.camera.setView({lon:-95,lat:39,z:163.75,tilt:0,swivel:0},true);",
  l2loop: "await cwrv3bench.useL2Fixture(); S.set('layerState.NEXRADOn',true); S.set('layerState.NEXRADLevel2',true); S.set('layerState.NEXRADLevel2Product',0); S.set('settings.nexradScanTransitionMode',1); S.set('settings.nexrad3DTilt',true); S.set('settings.nexrad3DTiltShadow',true); S.set('settings.nexradSitesOn',true); A.renderer.camera.setView({lon:-97.28,lat:35.33,z:14,tilt:35,swivel:20},true);",
  l3probe: "A.nexrad.fixture=null; cwrv3bench.timeline.anchor=null; S.set('ext.layerState.LoopLength',3); A.setLiveScan(false); S.set('layerState.NEXRADLevel2',false); S.set('layerState.NEXRADLevel3Product',0); S.set('config.generalMapMode',2); A.refreshAll(); A.renderer.camera.setView({lon:-97.28,lat:35.33,z:14,tilt:0,swivel:0},true);",
  stress: "S.set('config.generalMapMode',1); S.set('config.performanceMode',2); S.set('layerState.LightningOn',true); S.set('layerState.10mWindVectorsOn',true); S.set('layerState.saFillOn',true); S.set('layerState.FrontsOn',true); S.set('layerState.CentersOn',true); S.set('layerState.NEXRADLevel2',true); S.set('settings.nexradSitesOn',true); A.renderer.camera.setView({lon:-95,lat:39,z:120,tilt:15,swivel:0},true);",
};
// The 3D volume view scenarios use the Level 2 loop's setup; the benchmark turns the view on and orbits the camera.
SETUP.l2volume = SETUP.l2iso = SETUP.l2loop;
const results = { env, adapter: null, scenarios: {} };
const date = env.date.slice(0, 10);
try {
  mkdirSync(outDir, { recursive: true });
  await b.goto(URL_);
  await sleep(4000);
  if (mode === 'fixed4k') await b.eval('cwrv3app.renderer.gpu.fixedSize=[3840,2160]; 1');
  await sleep(30000); // first data load
  for (const sc of scenarios) {
    await b.eval(`(async()=>{const S=cwrv3bench.settings, A=cwrv3app; ${SETUP[sc]} return 1})()`);
    await sleep(sc === 'idle' || sc === 'panzoom' ? 5000 : 30000);
    const fpsArg = fps === null ? '' : `, fps:${fps}`;
    await b.eval(`cwrv3bench.run({scenario:'${sc}', seconds:15${fpsArg}, label:'warmup', raw:false}).then(()=>1)`, 600000);
    const rs = [];
    for (let i = 0; i < runs; i++) {
      const tracing = traceScenario === sc && i === 0;
      if (tracing) await b.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,viz,gpu,cc,benchmark,blink.user_timing,toplevel', transferMode: 'ReturnAsStream' });
      rs.push(await b.eval(`cwrv3bench.run({scenario:'${sc}', seconds:${tracing ? Math.min(20, seconds) : seconds}${fpsArg}, label:'${sc}#${i + 1}'})`, 900000));
      if (tracing) {
        const done = new Promise((r) => { const iv = setInterval(() => { const e = b.events.find((x) => x.method === 'Tracing.tracingComplete'); if (e) { clearInterval(iv); r(e.params.stream); } }, 200); });
        await b.send('Tracing.end');
        const stream = await done;
        let data = '';
        for (;;) { const c = await b.send('IO.read', { handle: stream, size: 1 << 20 }); data += c.base64Encoded ? Buffer.from(c.data, 'base64').toString() : c.data; if (c.eof) break; }
        writeFileSync(`${outDir}/${date}-${label}-${sc}.trace.json`, data);
        console.log('trace saved', data.length);
      }
    }
    results.adapter = rs[0].adapter;
    results.scenarios[sc] = { runs: rs.map((r) => ({ label: r.label, fpsLimit: r.fpsLimit, stats: r.stats, cadence: r.cadence, longTasks: r.longTasks, jsHeapMB: r.jsHeapMB, backbuffer: r.backbuffer, tiles: r.tiles, fixture: r.fixture, prepass: r.prepass, volumeView: r.volumeView, layers: r.layers.filter((l) => l.enabled).map((l) => `${l.id}:${l.status.state}`), raw: r.raw })) };
    const s = rs.map((r) => r.stats);
    console.log(sc, s.map((x, i) => `fps ${x.fps.toFixed(1)} p99 ${x.p99Ms.toFixed(2)} >20ms ${x.dropped20ms}/${x.frames} cpu ${x.cpuMean.toFixed(2)} gpu ${x.gpuMean.toFixed(2)}/${x.gpuP95?.toFixed?.(2)} late ${rs[i].cadence.lateFrames} raf ${rs[i].cadence.rafPeriodMs.toFixed(2)}`).join(' | '), 'bb', rs[0].backbuffer.width + 'x' + rs[0].backbuffer.height);
    if (rs[0].volumeView) console.log('  prepass', rs.map((r) => `mean ${r.prepass.meanMs.toFixed(2)} p95 ${r.prepass.p95Ms.toFixed(2)} max ${r.prepass.maxMs.toFixed(2)} ms, target ${r.volumeView.target?.join('x')}`).join(' | '));
    for (const r of rs) if (r.cadence.lateFrames) console.log('  late-frame events', JSON.stringify(r.cadence.lateFrameEvents), 'all events', JSON.stringify(r.cadence.frameEvents));
  }
} catch (e) {
  // Report why the page went away (renderer crash, navigation) before failing.
  const why = b.events.filter((x) => /targetCrashed|frameNavigated|detached/i.test(x.method)).slice(-3).map((x) => x.method + ' ' + JSON.stringify(x.params).slice(0, 300));
  console.error('benchmark aborted:', e.message, why.join(' | '), b.stderr().slice(-1500));
  throw e;
} finally { await b.close(); }
const file = `${outDir}/${date}-${label}.json`;
writeFileSync(file, JSON.stringify(results));
console.log('wrote', file);
