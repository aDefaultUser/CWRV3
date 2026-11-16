// GPU mip generation for colour-image atlas layers (basemap imagery). Each level is a 2×2 box average of the level
// above, done in linear light (the JPEG imagery is sRGB-encoded in an rgba8unorm texture). Only for colour images:
// encoded data (Terrarium heights, radar codes) must never be averaged and keeps a single level.

const MIPS_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
fn toLinear(c: vec4f) -> vec4f { return vec4f(pow(c.rgb, vec3f(2.2)), c.a); }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let c = (toLinear(textureLoad(src, p, 0)) + toLinear(textureLoad(src, p + vec2i(1, 0), 0))
         + toLinear(textureLoad(src, p + vec2i(0, 1), 0)) + toLinear(textureLoad(src, p + vec2i(1, 1), 0))) * 0.25;
  textureStore(dst, vec2i(id.xy), vec4f(pow(c.rgb, vec3f(1.0 / 2.2)), c.a));
}`;

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();

/** Number of mip levels of a square texture of `size` texels (down to 1×1). */
export const mipLevels = (size: number) => Math.floor(Math.log2(size)) + 1;

/**
 * Rebuilds every mip level of one layer of an rgba8unorm 2D-array texture from its level 0 (call after writing level
 * 0, e.g. when an atlas slot is reused). The texture needs TEXTURE_BINDING and STORAGE_BINDING usage.
 */
export function generateLayerMips(device: GPUDevice, tex: GPUTexture, layer: number): void {
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: MIPS_WGSL }), entryPoint: 'main' } });
    pipelines.set(device, pipeline);
  }
  const view = (level: number) => tex.createView({ dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
  const enc = device.createCommandEncoder({ label: 'atlas mips' });
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  // Dispatches in one pass run in order, so each level reads the one written just before it.
  for (let level = 1; level < tex.mipLevelCount; level++) {
    const size = Math.max(1, tex.width >> level);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(level - 1) }, { binding: 1, resource: view(level) }] }));
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
  }
  pass.end();
  device.queue.submit([enc.finish()]);
}

/**
 * Sampler anisotropy for the "Anisotropic Filtering" setting (stored as a byte): 0 and 1 mean off (1×); larger
 * values are clamped to 16, the WebGPU maximum (implementations clamp further to what the hardware supports).
 */
export const anisotropyOf = (setting: number) => Math.min(16, Math.max(1, Math.round(Number(setting) || 0)));
