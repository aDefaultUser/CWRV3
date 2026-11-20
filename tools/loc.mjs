#!/usr/bin/env node
// Functional lines of code: handwritten runtime TypeScript/JavaScript (src/ minus src/generated, plus server/),
// WGSL embedded in /* wgsl */ template literals (counted once, as WGSL, not as TS), Rust (rust/*/src), and CSS
// separately. A line
// counts when it holds code after removing comments; blank and comment-only lines do not count. Excluded: tests,
// fixtures, generated catalogs, vendored libraries/assets, build output, tools. Usage: node tools/loc.mjs [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..');
const walk = (d) => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });

/** Per-line classification of a JS/TS source: code lines, plus WGSL code lines inside /* wgsl *\/ templates. */
export function countScript(text) {
  const tsLines = new Set(), wgslLines = new Set();
  let line = 0, state = 'code', wgsl = false, braceDepth = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i], d = text[i + 1];
    if (c === '\n') { line++; if (state === 'line') state = wgsl ? 'tpl' : 'code'; continue; }
    switch (state) {
      case 'code':
        if (c === '/' && d === '/') { state = 'line'; i++; continue; }
        if (c === '/' && d === '*') {
          const end = text.indexOf('*/', i + 2), body = text.slice(i + 2, end);
          const nextTick = /^\s*`/.test(text.slice(end + 2, end + 40));
          for (let k = i; k < end; k++) if (text[k] === '\n') line++;
          i = end + 1;
          if (body.trim() === 'wgsl' && nextTick) { i = text.indexOf('`', i) ; state = 'tpl'; wgsl = true; }
          continue;
        }
        if (c === '/' && regexAllowed(text, i)) { i = skipRegex(text, i); tsLines.add(line); continue; }
        if (c === "'" || c === '"') { state = c; tsLines.add(line); continue; }
        if (c === '`') { state = 'tpl'; wgsl = false; tsLines.add(line); continue; }
        if (c === '}' && braceDepth.length && braceDepth[braceDepth.length - 1] === 0) { braceDepth.pop(); state = 'tpl'; wgsl = braceDepth.wgsl ?? false; tsLines.add(line); continue; }
        if (c === '{' && braceDepth.length) braceDepth[braceDepth.length - 1]++;
        if (c === '}' && braceDepth.length) braceDepth[braceDepth.length - 1]--;
        if (!/\s/.test(c)) tsLines.add(line);
        continue;
      case 'line': continue;
      case "'": case '"':
        if (c === '\\') { i++; continue; }
        if (c === state) state = 'code';
        continue;
      case 'tpl':
        if (c === '\\') { i++; (wgsl ? wgslLines : tsLines).add(line); continue; }
        if (c === '`') { state = 'code'; tsLines.add(line); wgsl = false; continue; }
        if (c === '$' && d === '{') { braceDepth.push(0); braceDepth.wgsl = wgsl; state = 'code'; i++; tsLines.add(line); continue; }
        if (wgsl && c === '/' && d === '/') { state = 'line'; i++; continue; }
        if (!/\s/.test(c)) (wgsl ? wgslLines : tsLines).add(line);
        continue;
    }
  }
  // A line holding both TS and WGSL (the template opening/closing) counts once, as TS.
  for (const l of tsLines) wgslLines.delete(l);
  return { ts: tsLines.size, wgsl: wgslLines.size };
}

/** A '/' starts a regular-expression literal when the previous token cannot end an expression. */
function regexAllowed(text, i) {
  let k = i - 1;
  while (k >= 0 && /[ \t]/.test(text[k])) k--;
  if (k < 0 || text[k] === '\n') return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(text[k])) return true;
  return /\b(return|typeof|case|of|in|do|else|void)$/.test(text.slice(Math.max(0, k - 8), k + 1));
}
function skipRegex(text, i) {
  let cls = false;
  for (let k = i + 1; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === '\n') return k - 1; // not a regex after all: stop at the line end
    if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) return k;
  }
  return text.length;
}

/** Code lines of Rust source: outside comments; a quote after `'` that is not a char literal starts a lifetime. */
export function countRust(text) {
  const lines = new Set();
  let line = 0, depth = 0, str = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], d = text[i + 1];
    if (c === '\n') { line++; continue; }
    if (depth) { if (c === '*' && d === '/') { depth--; i++; } else if (c === '/' && d === '*') { depth++; i++; } continue; }
    if (str) { lines.add(line); if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '/' && d === '/') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { depth = 1; i++; continue; }
    if (c === '"') str = true;
    else if (c === "'" && (d === '\\' || text[i + 2] === "'")) i = Math.max(i, text.indexOf("'", i + (d === '\\' ? 3 : 2)));
    if (!/\s/.test(c)) lines.add(line);
  }
  return lines.size;
}

export function countCss(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).split('\n').filter((l) => l.trim()).length;
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
function main() {
const runtime = [...walk('src').filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.startsWith('src/generated/')), ...walk('server').filter((f) => /\.(mjs|js|ts)$/.test(f))];
const css = walk('src').filter((f) => f.endsWith('.css'));
const rust = readdirSync(join(root, 'rust')).flatMap((c) => walk(join('rust', c, 'src'))).filter((f) => f.endsWith('.rs'));
const rows = runtime.map((f) => ({ file: relative(root, join(root, f)), ...countScript(readFileSync(join(root, f), 'utf8')) }));
const total = rows.reduce((a, r) => ({ ts: a.ts + r.ts, wgsl: a.wgsl + r.wgsl }), { ts: 0, wgsl: 0 });
const cssLines = css.reduce((s, f) => s + countCss(readFileSync(join(root, f), 'utf8')), 0);
const byDir = {};
for (const r of rows) { const k = r.file.split('/').slice(0, 2).join('/'); byDir[k] = (byDir[k] ?? 0) + r.ts + r.wgsl; }
for (const f of rust) { const k = f.split('/').slice(0, 2).join('/'); byDir[k] = (byDir[k] ?? 0) + countRust(readFileSync(join(root, f), 'utf8')); }
const rustLines = rust.reduce((s, f) => s + countRust(readFileSync(join(root, f), 'utf8')), 0);
const result = { files: rows.length + rust.length, typescriptJavascript: total.ts, wgsl: total.wgsl, rust: rustLines, functionalTotal: total.ts + total.wgsl + rustLines, css: cssLines, byDirectory: byDir };
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1));
else {
  console.log(`runtime files ${result.files}: TS/JS ${total.ts} + WGSL ${total.wgsl} + Rust ${rustLines} = ${result.functionalTotal} functional lines; CSS ${cssLines} (separate)`);
  for (const [k, v] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
}
}
