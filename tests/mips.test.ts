import { describe, expect, it } from 'vitest';
import { anisotropyOf, generateLayerMips, mipLevels } from '../src/render/mips';
import { settingExclusion } from '../src/settings/exclusions';

describe('basemap imagery filtering', () => {
  it('maps the stored byte to a WebGPU anisotropy: 0/1 off, clamped to 16', () => {
    expect([0, 1, 2, 4, 16, 17, 255, -3, NaN].map(anisotropyOf)).toEqual([1, 1, 2, 4, 16, 16, 16, 1, 1]);
    expect(settingExclusion('settings.generalAnisotropicFiltering')).toBeUndefined();
  });

  it('rebuilds all levels of exactly the reused atlas layer, with one pipeline per device', () => {
    const log = { pipelines: 0, views: [] as GPUTextureViewDescriptor[], dispatches: [] as number[][], submits: 0 };
    const device = {
      createShaderModule: () => ({}),
      createComputePipeline: () => { log.pipelines++; return { getBindGroupLayout: () => ({}) }; },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups: (x: number, y: number) => log.dispatches.push([x, y]), end() {} }),
        finish: () => ({}),
      }),
      queue: { submit: () => log.submits++ },
    } as unknown as GPUDevice;
    const tex = { width: 256, mipLevelCount: mipLevels(256), createView: (d: GPUTextureViewDescriptor) => { log.views.push(d); return {}; } } as unknown as GPUTexture;
    generateLayerMips(device, tex, 37);
    generateLayerMips(device, tex, 37);
    expect(mipLevels(256)).toBe(9);
    expect(log.pipelines).toBe(1);
    expect(log.submits).toBe(2);
    expect(log.dispatches.slice(0, 8)).toEqual([[16, 16], [8, 8], [4, 4], [2, 2], [1, 1], [1, 1], [1, 1], [1, 1]]);
    expect(log.views.every((v) => v.baseArrayLayer === 37 && v.arrayLayerCount === 1 && v.mipLevelCount === 1)).toBe(true);
    expect(log.views.slice(0, 2).map((v) => v.baseMipLevel)).toEqual([0, 1]); // level 1 reads level 0
  });
});
