import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
// @ts-expect-error plain ESM module without types
import { handleProxy } from './server/proxy.mjs';

const proxy: Connect.NextHandleFunction = (req, res, next) => { handleProxy(req, res).then((done: boolean) => { if (!done) next(); }, next); };
const proxyPlugin = (): Plugin => ({
  name: 'cwrv3-local-proxy',
  configureServer: (server) => { server.middlewares.use(proxy); },
  configurePreviewServer: (server) => { server.middlewares.use(proxy); },
});
/**
 * `virtual:archive2-wasm`: the URL of the Rust Archive II decoder built by tools/wasm.mjs (an asset of the build),
 * or null without it, when the decode worker keeps the TypeScript decoder. Registered for both pipelines: the dev
 * server transforms worker modules with the top-level plugins, the build bundles workers with `worker.plugins`.
 */
const ARCHIVE2_WASM = fileURLToPath(new URL('./rust/archive2/target/wasm32-unknown-unknown/release/cwrv3_archive2.wasm', import.meta.url));
const archive2Wasm = (): Plugin => ({
  name: 'cwrv3-archive2-wasm',
  resolveId: (id) => (id === 'virtual:archive2-wasm' ? '\0virtual:archive2-wasm' : undefined),
  load: (id) => {
    if (id !== '\0virtual:archive2-wasm') return undefined;
    return existsSync(ARCHIVE2_WASM) ? `export { default } from ${JSON.stringify(`${ARCHIVE2_WASM}?url`)};` : 'export default null;';
  },
});

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173 },
  plugins: [proxyPlugin(), archive2Wasm()],
  worker: { format: 'es', plugins: () => [archive2Wasm()] },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['h5wasm'] },
});
