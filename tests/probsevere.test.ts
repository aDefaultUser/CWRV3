import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProbSevere, checkedProbSevere, probSevereTime, pickProbSevereFrame, probTrend, sparkline, psMotion, probeLines, probColor, PS_MATCH_MS, PS_NEWEST_MS } from '../src/sections/probsevere';

// Trimmed real NCEP files (4 objects each, 30 minutes apart).
const load = (stamp: string) => JSON.parse(readFileSync(`tests/fixtures/probsevere/MRMS_PROBSEVERE_${stamp}.json`, 'utf8'));
const EARLY = load('20261118_004438'), LATE = load('20261118_011438');
const T_LATE = Date.UTC(2026, 10, 18, 1, 14, 38);

describe('ProbSevere v3 parsing', () => {
  it('reads the validTime, probabilities, MESH, shear, motion and polygons', () => {
    const f = parseProbSevere(LATE);
    expect(f.t).toBe(T_LATE);
    expect(f.objects.map((o) => o.id)).toEqual(['34590', '35157', '35243', '35315']);
    const o = f.objects[0];
    expect(o.prob).toEqual([87, 19, 64, 70]);
    expect(o.meshIn).toBe(1.37);
    expect(o.maxLlaz).toBe(0.015);
    expect([o.motionE, o.motionN]).toEqual([0.7, 0]);
    expect(o.rings).toHaveLength(1);
    expect(o.rings[0].slice(0, 4)).toEqual([-83.09, 25.22, -83.02, 25.22]);
    expect(o.lon).toBeCloseTo(-83.083, 2); expect(o.lat).toBeCloseTo(25.164, 2);
  });
  it('rejects other products and versions, and files without a valid time', () => {
    expect(() => parseProbSevere({ ...LATE, product: 'ProbSevere 2.0' })).toThrow(/v3 only/);
    expect(() => parseProbSevere({ ...LATE, validTime: '' })).toThrow(/validTime/);
    expect(() => parseProbSevere({ type: 'Feature' })).toThrow();
  });
  it('never relabels a file: its valid time must match the requested time', () => {
    expect(checkedProbSevere(LATE, T_LATE, 'x').t).toBe(T_LATE);
    expect(() => checkedProbSevere(EARLY, T_LATE, 'MRMS_PROBSEVERE_20261118_011438.json')).toThrow(/does not match/);
  });
  it('parses file-name times', () => {
    expect(probSevereTime('ProbSevere/20261118/MRMS_PROBSEVERE_20261118_011438.json')).toBe(T_LATE);
    expect(probSevereTime('nothing')).toBeNull();
  });
});

describe('ProbSevere frame matching', () => {
  const t0 = T_LATE - 10 * 60e3;
  const frames = [0, 2, 4, 8, 10].map((m) => ({ t: t0 + m * 60e3 }));
  const newest = frames[frames.length - 1].t;
  it('draws the newest file at or before the displayed time within about one cadence', () => {
    expect(pickProbSevereFrame(frames, t0 + 2 * 60e3, newest)?.t).toBe(t0 + 2 * 60e3);
    expect(pickProbSevereFrame(frames, t0 + 3 * 60e3, newest)?.t).toBe(t0 + 2 * 60e3);
    expect(pickProbSevereFrame(frames, t0 + 4 * 60e3 - 20e3, newest)?.t).toBe(t0 + 4 * 60e3); // timeline step slack
  });
  it('draws nothing in a data gap, before the first file or after the newest file has expired', () => {
    expect(pickProbSevereFrame(frames, t0 + 4 * 60e3 + PS_MATCH_MS + 1, newest)).toBeNull(); // 6 min file missing
    expect(pickProbSevereFrame(frames, t0 - 60e3, newest)).toBeNull();
    expect(pickProbSevereFrame(frames, newest + PS_NEWEST_MS + 1, newest)).toBeNull();
  });
  it('keeps the newest listed file current until its successor is due', () => {
    expect(pickProbSevereFrame(frames, newest + 4 * 60e3, newest)?.t).toBe(newest);
    // The same age is too old for a file that has a listed successor (not yet loaded).
    expect(pickProbSevereFrame(frames, newest + 4 * 60e3, newest + 2 * 60e3)).toBeNull();
  });
});

describe('ProbSevere probe text', () => {
  const files = [parseProbSevere(EARLY), parseProbSevere(LATE)];
  it('builds a per-object trend of the selected probability and a sparkline', () => {
    expect(probTrend(files, '34590', 0, T_LATE)).toEqual([25, 87]);
    expect(probTrend(files, '34590', 1, T_LATE)).toEqual([5, 19]);
    expect(probTrend(files, '34590', 0, T_LATE - 60e3)).toEqual([25]); // files after the shown time are excluded
    expect(probTrend(files, 'nope', 0, T_LATE)).toEqual([]);
    expect(sparkline([0, 25, 87, 100])).toBe('▁▃▇█');
  });
  it('converts motion: MOTION_SOUTH is positive northward', () => {
    expect(psMotion({ motionE: 0, motionN: 1 })).toEqual({ towardDeg: 0, speedKt: 1.943844 });
    expect(psMotion({ motionE: -3, motionN: -2 })!.towardDeg).toBeCloseTo(236.3, 1);
    expect(psMotion({ motionE: NaN, motionN: 0 })).toBeNull();
  });
  it('lists probabilities, MESH, shear, motion, ID, valid time and the trend', () => {
    const o = files[1].objects[0];
    const lines = probeLines(o, T_LATE, 1, probTrend(files, o.id, 1, T_LATE));
    expect(lines[0]).toBe('ProbSevere v3 object 34590 · valid 01:14Z');
    expect(lines[1]).toBe('Severe 87% · Tor 19% · Hail 64% · Wind 70%');
    expect(lines[2]).toBe('Tor trend (1 h) ▁▂ 5→19%');
    expect(lines[3]).toBe('MESH 1.37 in · max LL az shear 0.015 /s · moving toward 90° at 1 kt');
  });
  it('colours by probability from green to magenta', () => {
    expect(probColor(0)).toEqual([70, 200, 90]);
    expect(probColor(100)).toEqual([255, 0, 255]);
    expect(probColor(50)).toEqual([255, 140, 0]);
  });
});
