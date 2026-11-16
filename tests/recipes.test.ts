import { describe, it, expect } from 'vitest';
import { compileExpr, parseRecipeText, recipeShader } from '../src/render/recipes';

describe('multispectral recipes', () => {
  it('compiles whitelisted expressions with float literals', () => {
    expect(compileExpr('clamp((ch1 - 2) / 30, 0, 1)')).toBe('clamp ( ( ch1 - 2.0 ) / 30.0 , 0.0 , 1.0 )');
  });
  it('rejects anything outside the language', () => {
    expect(() => compileExpr('textureLoad(d0a)')).toThrow(/unknown name/);
    expect(() => compileExpr('ch1; }')).toThrow(/unexpected/);
    expect(() => compileExpr('(ch1')).toThrow(/parentheses/);
  });
  it('needs r, g and b; alpha defaults to 1', () => {
    expect(parseRecipeText('r = ch1\ng = ch2\nb = ch3').a).toBe('1.0');
    expect(() => parseRecipeText('r = ch1')).toThrow(/missing "g/);
  });
  it('generates an fsUser entry with only enabled channels sampled', () => {
    const code = recipeShader({ name: 'x', bands: [13, 2, 3, 14], enabled: [true, false, false, false], text: 'r = ch1 / 50\ng = 0\nb = 0', paletteChannel: -1, contrast: { on: true, value: 50 }, gamma: { on: false, value: 0 }, additive: true });
    expect(code).toContain('@fragment fn fsUser');
    expect(code).toContain('let k1 = sampleD(d0a, d0a, uv); let ch1 = -110.0 + 167.0');
    expect(code).toContain('let k2 = 0.0');
    expect(code).toContain('* 2.0 + 0.5');
    expect(code).toContain('return vec4f(rgb * a, 0.0)');
  });
});
