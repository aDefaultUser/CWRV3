import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error plain ESM module without types
import { handleProxy } from './server/proxy.mjs';

/**
 * Writes a gzip copy next to each GIS file in the build output. Shared hosts that don't compress .bin/.json serve
 * these instead (public/.htaccess), roughly halving the ~16 MB fetched before the map can draw.
 */
const gisGzipPlugin = (): Plugin => {
  let outDir = 'dist';
  return {
    name: 'cwrv3-gis-gzip',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const dir = join(outDir, 'gis');
      for (const name of readdirSync(dir)) {
        if (/\.(bin|json)$/.test(name)) writeFileSync(join(dir, `${name}.gz`), gzipSync(readFileSync(join(dir, name)), { level: 9 }));
      }
    },
  };
};

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
  plugins: [proxyPlugin(), gisGzipPlugin()],
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['h5wasm'] },
});
