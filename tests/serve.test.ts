// Production server: a malformed percent-encoded path gets 400 and the server keeps serving.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain ESM module without types
import { staticHandler } from '../server/serve.mjs';

describe('serve.mjs', () => {
  it('returns 400 for a malformed URL and then serves a valid file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cwrv3-serve-'));
    writeFileSync(join(root, 'index.html'), '<p>ok</p>');
    const server = createServer(staticHandler(root));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
      expect(bad.status).toBe(400);
      const good = await fetch(`http://127.0.0.1:${port}/`);
      expect(good.status).toBe(200);
      expect(await good.text()).toBe('<p>ok</p>');
    } finally { server.close(); }
  });
});
