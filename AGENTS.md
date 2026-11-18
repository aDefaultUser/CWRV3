# CWRV3 agent guide

Local WebGPU weather workstation (TypeScript, Vite, no framework) over public NOAA/NWS data. `README.md` covers
usage, data sources, persistence and licences.

## Commands

```sh
npm install
npm run dev        # http://127.0.0.1:5173/ (loopback; includes the allowlisted proxy, server/proxy.mjs)
npm run check      # tsc --noEmit + vitest run + vite build: run before handing work back
npm test           # unit tests only (tests/*.test.ts, Node; no browser)
npm run loc        # functional line count; update the README table when it changes
npm run bench -- <label> <mode> --out <dir>   # isolated Chromium on DevTools port 9333 (refuses a busy port)
```

WebGPU needs a hardware adapter: on Linux `chromium --enable-unsafe-webgpu --enable-features=Vulkan`.
`tools/browser/cdp.mjs` drives an isolated Chromium (temporary profile) for scripted checks; keep jobs finite.

## Layout

- `src/app/` — `app.ts` (shell, input, settings wiring, frame loop), `timeline.ts` (loop window, owner resolution,
  playback), `pacer.ts` (FPS limits), `stores.ts`/`persist.ts` (non-setting preferences).
- `src/settings/` — `store.ts` (one localStorage record per setting, coercion, dialog edit/Cancel), `exclusions.ts`
  (settings shown disabled with a reason).
- `src/ui/` — `form.ts` renders the original form geometry (`src/generated/ui-forms.ts`) with explicit bindings
  from `bindings.ts`; controls without a binding fall back to the catalog's single-setting binding.
- `src/layers/`, `src/sections/` — map layers (`MapLayer`: `refresh`, `draw`, `legends`, `probeKind`/`probeText`,
  `probeAt`); `nexrad.ts` is NEXRAD Level 2/3, `goes-l2.ts` the GOES L2+ products.
- `src/render/` — WebGPU renderer, shaders, raster/radar draws, basemap tiles (`tiles.ts`) and GPU mips. A layer's
  `prepass(ctx)` encodes its offscreen passes before the main pass (`ctx.timing()` adds them to `gpuMs`).
- Radar volumes: `src/radar/volume-pack.ts` (every tilt of one moment on a fixed azimuth frame, worker task
  `l2.volume`), `src/radar/volume-sample.ts` (reference sampler: azimuth, ground range, height → value) and
  `src/render/volume.ts` (`VolumeStore`, the WGSL mirror `volumeWgsl`, `VolumeSection`); `NexradLayer.volumePack`.
  3D view: `src/layers/radar-volume3d.ts` (settings, pack of the shown frame), `src/render/volume-view.ts` (march
  target, composite), `src/render/volume-ray.ts` (reference ray math); packs carry an occupancy grid for skipping.
  3D view: `src/layers/radar-volume3d.ts` (settings, pack of the shown frame), `src/render/volume-view.ts` (march
  target, composite), `src/render/volume-ray.ts` (reference ray math); packs carry an occupancy grid for skipping.
- Linked panes: `src/render/panes.ts` (grid geometry, pane-relative points), `src/app/panes.ts` (layout, views of
  panes 1–3, presets, saved layouts). The renderer draws the scene into each pane's viewport with the one camera
  sized to a pane: a layer is recorded once and replayed, unless it is `perPane` (NEXRAD), whose `draw` runs per pane
  with `ctx.pane`. `NexradLayer.view(pane)`: pane 0 is the radar settings; every per-pane method takes the pane.
- `src/decode/`, `src/workers/` — decoders (Archive II, Level 3, GRIB2, NetCDF/HDF5 via h5wasm) run in the worker
  pool; callers name the owner: `pool.for(layerId).run(task, args)`. `l2-volumes.ts` holds the Level 2 volume cache
  (live chunk volumes update incrementally; `tests/helpers/archive2-writer.ts` writes synthetic volumes for tests).
- `src/perf/` — frame meter, benchmark, F8 performance panel.
- `src/generated/` — hand-maintained catalogs (settings, forms, products); edit them directly.

## Conventions

- Public data only, no vendor code/assets, no telemetry, no new hosts outside the proxy allowlist.
- Small, direct changes in the existing style; comments only for non-obvious intent. Every setting change must
  reach its runtime effect (listener, refresh or per-frame read) and persist; unsupported settings stay disabled
  with their reason, never with a fake effect.
- Data is drawn only under the identity (site, product, tilt, sector…) it was requested for; stale or out-of-order
  results are discarded, never relabelled.
- Tests exercise the real code paths (bindings, timeline, stores, decoders) with small public fixtures in
  `tests/fixtures/`; keep large data, evidence and benchmark output outside the repository.

## Working arrangement

The user's orchestrator assigns coding to Opus 5.5 (high effort), reviews the diff, and runs a council review at
completion. Delegated coding agents do the work themselves and do not start councils or further agents.
