import './ui/theme.css';
import { App } from './app/app';
import { installBench } from './perf/bench';

async function boot() {
  const canvas = document.createElement('canvas');
  canvas.id = 'map';
  const app = new App(canvas);
  try {
    await app.init();
    installBench(app);
    (window as unknown as { cwrv3app: App }).cwrv3app = app;
  } catch (e) {
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:14px sans-serif;background:#05070d;padding:40px;text-align:center;white-space:pre-wrap';
    msg.textContent = `CWRV3 could not start.\n\n${(e as Error).message}\n\nWebGPU is required (Chromium with WebGPU enabled; on Linux: --enable-unsafe-webgpu --enable-features=Vulkan).`;
    document.body.appendChild(msg);
    console.error(e);
  }
}
boot();
