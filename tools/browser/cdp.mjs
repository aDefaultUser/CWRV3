// Minimal Chrome DevTools Protocol driver for an isolated Chromium (temporary profile; nothing installed).
// Used for screenshots and performance runs because the embedded preview browser exposes no WebGPU adapter.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch({ width = 2560, height = 1440, dpr = 1, headless = false, extraArgs = [], port = 9333 } = {}) {
  // Refuse a busy port: otherwise the client below would silently attach to a leftover browser and share its state.
  const busy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is already serving DevTools (leftover Chromium?); stop it first`);
  const profile = mkdtempSync(join(tmpdir(), 'cwrv3-chromium-'));
  const args = [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`, ...(headless ? ['--headless=new'] : ['--ozone-platform=wayland']), '--use-angle=vulkan', '--use-vulkan=native', ...extraArgs, 'about:blank',
  ];
  const proc = spawn('chromium', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const killOnExit = () => proc.kill('SIGTERM');
  const onSignal = () => { killOnExit(); process.exit(130); };
  process.once('exit', killOnExit);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, onSignal);
  // Each launch removes its own handlers on close, so many sequential sessions do not accumulate listeners.
  const detach = () => { process.off('exit', killOnExit); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!ws) throw new Error('chromium did not start: ' + stderr.slice(-800));
  const sock = new WebSocket(ws);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
  let id = 0;
  const pending = new Map();
  const events = [];
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.j(new Error(JSON.stringify(msg.error))) : p.r(msg.result); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); sock.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const api = {
    send, events, profile, stderr: () => stderr,
    async goto(url) { await send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 1500)); },
    async eval(expression, timeout = 300000) {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
      return res.result.value;
    },
    async screenshot(path, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: false });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
    },
    async metrics(w, h, scale) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false }); },
    async close() { detach(); try { sock.close(); } catch { /* */ } proc.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); rmSync(profile, { recursive: true, force: true }); },
  };
  return api;
}
