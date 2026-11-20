#!/usr/bin/env node
// Builds the Rust Archive II decoder (rust/archive2) for wasm32-unknown-unknown with the locked dependencies; Vite
// serves the artifact to the decode worker (virtual:archive2-wasm). Without cargo, rustc or the wasm32 target this
// prints how to add them, deletes the artifact of any earlier build (Vite would ship it, stale, with the new code)
// and exits 0: the build then decodes Level 2 with the TypeScript decoder. CWRV3_REQUIRE_WASM=1 makes a missing
// toolchain an error; a failing cargo build always is. The target directory is given explicitly, so CARGO_TARGET_DIR
// or a cargo config cannot move the artifact away from the path vite.config.ts and the tests read.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = join(root, 'rust/archive2');
const target = 'wasm32-unknown-unknown';
const artifact = join(crate, 'target', target, 'release', 'cwrv3_archive2.wasm');
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.error || r.status !== 0 ? null : r.stdout.trim(); };
const sysroot = run('rustc', ['--print', 'sysroot']);
const missing = sysroot === null || run('cargo', ['--version']) === null ? 'Rust (cargo, rustc)'
  : !existsSync(join(sysroot, 'lib', 'rustlib', target)) ? `the ${target} target (rustup target add ${target})` : null;
if (missing) {
  rmSync(artifact, { force: true });
  const msg = `wasm: ${missing} not installed; Level 2 will decode with the TypeScript decoder`;
  if (process.env.CWRV3_REQUIRE_WASM === '1') { console.error(msg); process.exit(1); }
  console.warn(msg);
  process.exit(0);
}
const r = spawnSync('cargo', ['build', '--quiet', '--release', '--locked', '--target', target, '--target-dir', join(crate, 'target'), '--manifest-path', join(crate, 'Cargo.toml')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
