// tools/wasm.mjs, run from a copy with stand-in rustc and cargo: without a toolchain or the wasm32 target it deletes
// the artifact of an earlier build (Vite would ship it) and exits 0, or 1 under CWRV3_REQUIRE_WASM=1; a failing cargo
// build is an error and leaves the artifact alone.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe.skipIf(process.platform === 'win32')('tools/wasm.mjs', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** Runs the tool in a fresh copy with a stale artifact, `bin` (stand-in commands) as the whole PATH. */
  function run(commands: { rustc?: string; cargo?: string }, env: Record<string, string> = {}, target = 'x86_64-unknown-linux-gnu') {
    const dir = mkdtempSync(join(tmpdir(), 'cwrv3-wasm-'));
    dirs.push(dir);
    const bin = join(dir, 'bin'), sysroot = join(dir, 'sysroot'), release = join(dir, 'rust/archive2/target/wasm32-unknown-unknown/release');
    for (const d of [join(dir, 'tools'), bin, release, join(sysroot, 'lib/rustlib', target)]) mkdirSync(d, { recursive: true });
    copyFileSync(new URL('../tools/wasm.mjs', import.meta.url), join(dir, 'tools/wasm.mjs'));
    const artifact = join(release, 'cwrv3_archive2.wasm');
    writeFileSync(artifact, 'stale');
    for (const [name, body] of Object.entries(commands)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body.replaceAll('$SYSROOT', sysroot)}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const r = spawnSync(process.execPath, [join(dir, 'tools/wasm.mjs')], { env: { PATH: bin, ...env }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr, artifact: existsSync(artifact) };
  }
  const rustc = 'echo "$SYSROOT"';
  const cargo = (build: string) => `[ "$1" = --version ] && exit 0\n${build}`;

  it('deletes the stale artifact without cargo or rustc, failing only under CWRV3_REQUIRE_WASM=1', () => {
    expect(run({})).toMatchObject({ status: 0, artifact: false, out: expect.stringContaining('Rust (cargo, rustc) not installed') });
    expect(run({ rustc })).toMatchObject({ status: 0, artifact: false, out: expect.stringContaining('Rust (cargo, rustc) not installed') });
    expect(run({}, { CWRV3_REQUIRE_WASM: '1' })).toMatchObject({ status: 1, artifact: false });
  });

  it('deletes the stale artifact without the wasm32 target', () => {
    expect(run({ rustc, cargo: cargo('exit 0') })).toMatchObject({ status: 0, artifact: false, out: expect.stringContaining('rustup target add wasm32-unknown-unknown') });
    expect(run({ rustc, cargo: cargo('exit 0') }, { CWRV3_REQUIRE_WASM: '1' })).toMatchObject({ status: 1, artifact: false });
  });

  it('fails with a failing cargo build', () => {
    const r = run({ rustc, cargo: cargo('echo "error[E0308]: mismatched types" >&2\nexit 101') }, {}, 'wasm32-unknown-unknown');
    expect(r).toMatchObject({ status: 101, artifact: true, out: expect.stringContaining('E0308') });
  });
});
