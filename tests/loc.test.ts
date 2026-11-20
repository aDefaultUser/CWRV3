// The LOC tool counts code lines, splits embedded WGSL out of TS, and ignores comments, strings with '//' and regexes.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM tool without types
import { countScript, countCss, countRust } from '../tools/loc.mjs';

describe('functional LOC counting', () => {
  it('counts TS and embedded WGSL once each, excluding comments and blanks', () => {
    const src = [
      '// comment', "const a = 'http://x//y'; // trailing", '', '/* block', '   comment */',
      'export const S = COMMON + /* wgsl */ `', '// wgsl comment', 'fn f() -> f32 {', '  return 1.0; // x', '}', '', '`;',
      'const t = `tpl ${a} more`;', 'const re = /"[^"]*"|\\/\\//g;', 'const n = 1;',
    ].join('\n');
    expect(countScript(src)).toEqual({ ts: 6, wgsl: 3 });
  });
  it('counts Rust without comments, with lifetimes and char literals', () => {
    const src = ['// c', '/// doc', "fn f<'a>(x: &'a str) -> char { // t", '    let s = "a // b";', '    /* block', "    */ '/'", '}', '', '/* a /* nested */ b */', "let c = '\\'';"].join('\n');
    expect(countRust(src)).toBe(5);
  });
  it('counts CSS without comments', () => { expect(countCss('/* x */\na { b: c; }\n\n/* y\n z */\nd {}')).toBe(2); });
});
