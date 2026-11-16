// GRLevelX placefile parser: commands, Object offsets and the original's error strings.
import { describe, it, expect } from 'vitest';
import { parsePlacefile } from '../src/layers/placefiles';

describe('placefile parser', () => {
  it('parses the common commands', () => {
    const pf = parsePlacefile(`; test
Title: Spotters
RefreshSeconds: 60
Threshold: 250
Color: 255 0 0
Font: 1, 12, 1, "Arial"
IconFile: 1, 22, 22, 11, 11, "https://example.test/icons.png"
Icon: 35.2,-97.4,0,1,3,"Spotter A"
Text: 35.5,-97.5,1,"OKC","Oklahoma City"
Place: 36.1,-95.9,Tulsa
Line: 2, 0, "front"
35.0,-98.0
36.0,-97.0
End:
Triangles:
35,-98,255,0,0,128
36,-98
36,-97
End:
Object: 34.0,-99.0
Text: 10, 20, 1, "offset"
End:
`);
    expect(pf.title).toBe('Spotters');
    expect(pf.refreshSec).toBe(60);
    expect(pf.threshold).toBe(250);
    expect(pf.icons[0]).toMatchObject({ lat: 35.2, lon: -97.4, file: 1, icon: 3, hover: 'Spotter A'});
    expect(pf.texts.map((t) => t.text)).toEqual(['OKC', 'Tulsa', 'offset']);
    expect(pf.texts[2]).toMatchObject({ lat: 34, lon: -99, dx: 20, dy: -10 });
    expect(pf.lines[0]).toMatchObject({ width: 2, color: [255, 0, 0, 255], pts: [-98, 35, -97, 36] });
    expect(pf.tris[0].colors[0]).toEqual([255, 0, 0, 128]);
    expect(pf.errors).toEqual([]);
  });
  it('reports malformed input with the original messages', () => {
    const pf = parsePlacefile('Color: red\nEnd:\nTriangles:\n35,-98\n36,-98\nEnd:\n');
    expect(pf.errors).toContain('Error: Color - bad data section. (line 1)');
    expect(pf.errors).toContain('Warning: Apparently extraneous End: statement. (line 2)');
    expect(pf.errors.some((e) => e.startsWith('Error tesselating vertices at command 3'))).toBe(true);
  });
});
