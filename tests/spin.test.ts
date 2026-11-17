// Spin controls: range and increment per control (binding, design values, setting range) and commit clamping.
// Native stepping itself is checked in the browser (arrow buttons and keys step from the shown value).
import { describe, expect, it } from 'vitest';
import { spinRange, clampSpin, formDef, type Binding } from '../src/ui/form';

const ctl = (form: string, name: string) => formDef(form).controls.find((c) => c.name === name)!;

describe('spin range', () => {
  it('keeps the design range and an integer step for the Level 2 volume counts', () => {
    expect(spinRange(ctl('TFrmSettings', 'sSpinEdit1'), { kind: 'num', id: 'settings.nexradLevel2MaxVolumeDownloadCount' })).toEqual({ min: 1, max: 12, step: 1 });
    expect(spinRange(ctl('TFrmSettings', 'sSpinEdit15'), { kind: 'num', id: 'settings.nexradLevel2VolumeCountMemory' })).toEqual({ min: 3, max: 26, step: 1 });
  });

  it('uses the original increments (camera sensitivity 10 %, fly duration 50 ms, track filter 5 dBZ)', () => {
    const b: Binding = { kind: 'num', id: 'config.generalCameraPanSensitivity', scale: 100, min: 5, max: 250 };
    expect(spinRange(ctl('TFrmSettings', 'sSpinEdit19'), b)).toEqual({ min: 5, max: 250, step: 10 });
    expect(spinRange(ctl('TFrmSettings', 'sSpinEdit10'), { kind: 'num', id: 'config.generalCameraFlyDuration', min: 10, max: 90000 }).step).toBe(50);
  });

  it('scales a setting range into the shown units and leaves storage-type limits open', () => {
    const r = spinRange({ id: 'ui.X.y', name: 'y', cls: 'TsSpinEdit', parent: null }, { kind: 'num', id: 'settings.nexradLevel2VolumeCountMemory', scale: 2 });
    expect(r).toEqual({ min: 6, max: 52, step: 1 });
    expect(spinRange({ id: 'ui.X.y', name: 'y', cls: 'TsSpinEdit', parent: null }, { kind: 'num', id: 'settings.generalLoopSpeedEndDelay' })).toEqual({ min: null, max: null, step: 1 });
  });

  it('moves an integer setting by whole units even on a decimal spin edit', () => {
    expect(spinRange({ id: 'ui.X.y', name: 'y', cls: 'TsDecimalSpinEdit', parent: null, inc: 0.1 }, { kind: 'num', id: 'settings.generalLoopSpeedLevel2FrameTime' }).step).toBe(1);
  });

  it('clamps a committed value to the range', () => {
    const r = { min: 3, max: 26 };
    expect([clampSpin(27, r), clampSpin(2, r), clampSpin(10, r), clampSpin(-5, { min: null, max: null })]).toEqual([26, 3, 10, -5]);
  });
});
