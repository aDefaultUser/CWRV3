#!/usr/bin/env node
// Serves the production build (dist/) on loopback with the bounded CORS proxy. Usage: npm run build && npm run serve
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleProxy } from './proxy.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.bin': 'application/octet-stream', '.map': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain' };

/** Request handler for files under `root` (proxy first). Never rejects: malformed paths get 400. */
export function staticHandler(root) {
  return async (req, res) => {
    try {
      if (await handleProxy(req, res)) return;
      let path;
      try { path = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { res.statusCode = 400; res.end('bad request'); return; }
      let p = normalize(path).replace(/^(\.\.[/\\])+/, '');
      if (p.endsWith('/')) p += 'index.html';
      const file = join(root, p);
      if (!file.startsWith(root)) { res.statusCode = 403; res.end(); return; }
      try {
        await stat(file);
        res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
        res.end(await readFile(file));
      } catch { res.statusCode = 404; res.end('not found'); }
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(new URL('..', import.meta.url).pathname, 'dist');
  const port = Number(process.env.PORT ?? 4173);
  createServer(staticHandler(root)).listen(port, '127.0.0.1', () => console.log(`CWRV3: http://127.0.0.1:${port}/`));
}
