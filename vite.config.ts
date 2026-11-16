import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error plain ESM module without types
import { handleProxy } from './server/proxy.mjs';

const proxyPlugin = (): Plugin => ({
  name: 'cwrv3-local-proxy',
  configureServer(server) {
    server.middlewares.use((req, res, next) => { handleProxy(req, res).then((done: boolean) => { if (!done) next(); }, next); });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => { handleProxy(req, res).then((done: boolean) => { if (!done) next(); }, next); });
  },
});

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173 },
  plugins: [proxyPlugin()],
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['h5wasm'] },
});
