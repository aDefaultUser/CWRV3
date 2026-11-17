<img src="assets/icon.svg" width="64" height="64" alt="">

# CWRV3

A local, browser-based weather workstation with WebGPU rendering, driven only by public weather and GIS data (NOAA/NWS,
NASA, USGS, Iowa Environmental Mesonet, Natural Earth, US Census TIGER, the UNL Drought Monitor). It has twelve
section tabs (Basic, Surface, NEXRADPro, MRMS, Model, MESO, Forecast, NDFD, NWS/SPC, Tropical, Winter, Misc) on a
shared 3D map with GIS, tools and dialogs. Decoding (Archive II, Level III, GRIB2 with JPEG 2000, NetCDF/HDF5,
shapefiles) runs in Web Workers.

made by Cloud Nuke Software Collective. Original idea made by Paul Marv Software.

## Setup and run

Requirements: Node.js 22.12+ and npm; a Chromium-based browser with WebGPU on a hardware adapter (on Linux start
Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` if no adapter is found); internet access to the
public data hosts.

```sh
npm install
npm run dev                       # development server, http://127.0.0.1:5173/
npm run build && npm run serve    # production build, http://127.0.0.1:4173/
```

GIS data is included. Run `npm run gis` only to rebuild it from the public sources.

Both servers listen on loopback only and include a small proxy (`server/proxy.mjs`) for public hosts that send no
CORS headers: GET/HEAD from 127.0.0.1 to a fixed HTTPS allowlist, with redirect, size and time limits.

## Using CWRV3

Choose a section tab, enable its layers, then pan or zoom the map. In NEXRADPro, select a radar site, Level 2 or
Level 3, a product and a tilt. The timeline controls playback. Explore moves the map; Interact opens objects;
Probe reads the displayed value under the pointer.

* Timeline: with "Wrap timeline to NEXRAD radar loop" (Radar Control) or "Wrap timeline to MRMS loop" on, that loop
  owns stepping and playback (NEXRAD first, then MRMS); the Model timeline owns it while selected. Settings → Loop
  Speed: the Level 2, Level 3 and MRMS frame times apply as set; the minimum/maximum loop-time overrides stretch or
  shrink only the General timeline. The end delay holds the newest frame. Timing changes apply to the frame in
  progress; the Play button's tooltip shows the loop, frame count and applied frame time. Skip to end pauses on the
  newest available frame and follows newer frames as they arrive.
* Level 2 download volumes is how many of the newest volumes are fetched; max memory volumes is how many are kept as
  new scans arrive (lowering it drops the oldest at once).
* Extended GOES-R Data → Product "Level 2 Product": cloud-top height (`ABI-L2-ACHA`, CONUS / Full Disk /
  Mesoscale), cloud-top temperature (`ABI-L2-ACHT`, Full Disk / Mesoscale; not produced for CONUS) and fire/hot spot
  with fire radiative power (`ABI-L2-FDC`, CONUS / Full Disk / Mesoscale) from GOES-19 or GOES-18. Cloud-top values
  are drawn for good-quality pixels only (product DQF 0); fires are points coloured by power, probe them for
  category, power, temperature and area.
* F8 (or CWRV3 → Advanced → Performance panel) shows the global frame rate and times, GPU pass time where the adapter
  supports timestamp queries, total tracked texture memory and the JS heap (N/A where the browser does not report
  it), and one row per layer or owner with its decode jobs, texture uploads, live texture memory and status. Each layer's decode time excludes network, queueing and transfer, shown beside
  the worker's fetch + decode wall time. It samples only while open and sends nothing anywhere.

Open Settings from the CWRV3 menu to change rendering, radar, lightning and display preferences. Changes save in
this browser automatically. Use settings export/import to move them to another browser. The About area of Settings links to the source
repository, [aDefaultUser/CWRV3](https://github.com/aDefaultUser/CWRV3).

* Drag to pan; use the wheel to zoom. Ctrl+drag tilts and swivels.
* R toggles radar site labels; Alt+D measures distance; Alt+L adds road labels.
* Ctrl+T starts telestration, Space clears it, and Esc cancels the active tool.

## Development

```sh
npm run check    # typecheck, unit tests, production build
npm test         # unit tests only
npm run loc      # functional lines of code (method in tools/loc.mjs)
npm run bench -- <label> <fixed4k|dpr1|dpr15|dpr2> --out <dir> [--fps 60|0] [--headful] [--runs 3]
```

The benchmark (`tools/perf/run-bench.mjs`) drives an isolated Chromium (temporary profile, DevTools port 9333) against
the production build; Level 2 runs use the fixed KTLX archive volumes listed in `public/perf-fixtures.json`.

## Preferences and persistence

Every preference is saved in the browser's `localStorage` under the `cwrv3.` prefix. Each setting is its own record,
`cwrv3.setting/<id>` holding the JSON value; the other user state (styles, text styles, style library, presets,
viewpoints, scene and layer presets, layer order, RGB recipes, model configurations, palettes loaded from files,
placefile and shapefile lists, road labels, dialog options, GPS serial options) uses one key per preference.
Large user files (shapefiles, custom background, logo, overlay image) are kept in Cache Storage
(`cwrv3-user-files`); downloaded public data is cached in `cwrv3-data-v1`.

* Settings are written 250 ms after a change and immediately when the page is hidden or unloaded, so a reload right
  after a change keeps it. A write is one `setItem` per changed setting, with no read-modify-write of a shared
  document, so two tabs changing different settings never overwrite each other in any interleaving; for the same
  setting the last write wins. Other tabs read the current record on each storage event (never the event's
  possibly stale value) and keep their own changes that are not yet written.
* The three whole documents of earlier builds (`cwrv3.CWRV3Settings`, `cwrv3.CWRV3ConfigurationSettings`,
  `cwrv3.ProductStatus`) are still read as a fallback for settings without a record, never written; a record always
  takes precedence, and a reset writes the default as a record.
* A settings write the browser rejects (storage full or disabled) is shown as "Not saved: …"; only the settings whose
  write failed stay pending and are retried every 5 s and on the next change; when the browser offers no storage at all, changes stay pending and "Not saved" is shown. It is
  never reported as saved. Other preferences are written when they change, and a failed write is retried on their
  next change. Advanced → "Settings storage / all settings…" shows the state and edits every setting by ID,
  with JSON export/import (imports use the same type, range and post-load rules as loading; a file that is not a
  settings export, or has no valid value for its document, is rejected without changing anything, and a
  one-document export resets only that document).
* Preferences of earlier builds (`wsv3web.*` keys, `wsv3-user-files` cache) are migrated once, automatically.

## Frame rate

Settings → Graphics → FPS limits: **Target** (default 0 = unlimited) bounds all rendering; **Idle** (default 15)
and **Loop** (default 0 = follow the target) can only lower it while nothing changes or a loop plays without user
input. With an unlimited target the browser's display refresh is the only bound. A finite target is applied in whole
display refreshes with the signed phase carried between frames, so it averages to the target at any refresh rate
(60 fps on a 144 Hz display alternates 2 and 3 refreshes) and locks to an integer divisor when the target is within
0.5 % of one (60 fps on a 179.9–180.1 Hz display renders every third refresh).

## Known differences from the original

Exact parity with the original program is not claimed. Known differences:

* No vendor code, art, fonts, servers, licensing, account features or telemetry. Vendor-only features and
  desktop-only options (Direct3D swap chain, second monitor, window state, GDI capture, DXT compression, COM port
  name, the serial library's terminal dialog) are shown disabled with the reason.
* All 157 palette names the original's palette selector offers exist, but their colours are independently authored
  (base reflectivity and velocity use the public NWS tables); they do not match the original's colours.
* Globe lighting, atmosphere, terrain shading, update flash, fade trail and several other display options are
  independent interpretations, not the original algorithms. Some settings whose meaning is unknown are kept but
  have no effect (listed with reasons in the all-settings editor).
* Anisotropic filtering (`settings.generalAnisotropicFiltering`, edited in the all-settings editor; the original
  dialog has no control) applies to basemap imagery only, which has GPU-generated mip levels: 0–1 = off (trilinear),
  2–16 = maximum anisotropy, larger stored values act as 16. Terrarium elevation, radar and other data textures are
  never mipmapped or averaged. The public imagery stops at zoom level 8, so the visible gain at steep tilts is small.
* Defaults that differ on purpose: the FPS target is unlimited and the loop limit follows it (the original capped
  at 60/50 fps).
* Lightning uses the public GOES GLM feed only; strike markers are the Tabler "bolt" icon tinted by age, with
  mirrored/rotated variants for "Strike icon variety"; Glow adds a soft halo behind each bolt. Hail and freezing-rain symbols are procedural (no approved
  icon).
* Some Level 2 derived products carry approximations (echo-top interpolation, VILD scaling, POSH for WT ≤ 0); the
  Level 3 general status message product is not drawn.
* NAM-family and HiresW model feeds were unavailable from the public servers when last checked (HTTP 404 on
  2026-11-15) and are reported as unavailable instead of being substituted.
* The live sweep depends on the public real-time chunk bucket being current for the site; otherwise it falls back to
  the TGFTP volume and says so.

## Performance

Measured with `npm run bench` on an AMD Ryzen 9 9950X3D and Radeon RX 9070 XT (Mesa RADV, Chromium 157, Linux),
production build, FPS target 60. Frame times are `requestAnimationFrame` intervals of rendered frames.

| Run | Scenario | Result |
| --- | --- | --- |
| Visible window, 2363×1078 at DPR 1, 180 Hz display, 3 × 60 s | pan/zoom | 3/3 runs 60.0 fps, p99 16.8 ms, 0 frames > 20 ms |
| | stress (all layers) | 3/3 runs 60.0 fps, p99 16.8 ms, 0 frames > 20 ms |
| | Level 2 loop (8 KTLX volumes) | runs 1 and 3: 60.0 fps, p99 16.8 ms, 0 frames > 20 ms; run 2 excluded: the host stopped `requestAnimationFrame` for 484.6 s |
| Headless, fixed 3840×2160, 60 Hz, 1 × 20 s smoke | pan/zoom, target 60 | 60.0 fps, p99 16.8 ms, 0/1201 frames > 20 ms, GPU 1.6 ms mean |
| | pan/zoom, unlimited | 60.0 fps (bounded by the 60 Hz headless refresh), p99 16.8 ms, 0/1201 frames > 20 ms |

Mean CPU time per frame was about 2 ms and GPU time about 0.6–1.6 ms in every run, so the frame rate is set by
the FPS target or the display refresh, not by rendering cost. The 4K runs are short smoke checks, not full
measurements.

## Data sources

NOAA Open Data on AWS (MRMS, HRRR, RAP, GFS, NBM, GOES ABI/GLM including the ABI L2+ cloud-top height, cloud-top
temperature and fire/hot spot products, NEXRAD Level 2 archive and real-time chunks), NWS
TGFTP (Level 2/3, NDFD, text products), api.weather.gov, Aviation Weather Center, SPC, WPC, CPC, NHC, NDBC, USGS
earthquakes, NASA FIRMS, NOAA water data, the US Drought Monitor (University of Nebraska–Lincoln), Iowa Environmental
Mesonet, NASA GIBS imagery and AWS Terrain Tiles. Bundled GIS layers come from Natural Earth and US Census TIGER.

## Licences and third-party material

* Tabler Icons 3.52.0 (MIT): `public/assets/icons/tabler/LICENSE`, file list and hashes in
  `public/assets/icons/manifest.json`.
* Route shields: OpenStreetMap Americana artwork and maplibre-gl-shields shapes (CC0-1.0,
  `public/assets/roads/shields/LICENSE-*`). The Interstate shield is a registered mark of AASHTO; it is used only to
  identify Interstate routes on the map.
* Noto Sans (SIL OFL 1.1): `public/assets/roads/fonts/LICENSE-OFL-1.1-NotoSans.txt`.
* FHWA 2024 Standard Highway Signs, all 1,059 listed codes (`public/assets/roads/mutcd/`; source, hashes and per-file
  status in `manifest.json`). The sign drawings are US government works, but the library is not entirely free of
  rights: the 10 files in `restricted/` (flagged `restricted` in the manifest, which is authoritative) carry marks
  whose use MUTCD 1D.06 limits — the Interstate shield (registered mark of AASHTO; M1-1, M1-1a, M1-2, M1-3, I2-4),
  the 511 travel-information pictograph (D12-5), the National Scenic Byway graphic (M10-1, M10-1aP) and the
  Eisenhower Interstate System graphic, which may be FHWA-owned (M1-10, M1-10a). The app does not draw these files.
* NWS standard reflectivity/velocity tables via MetPy (BSD-3-Clause): `src/palettes/METPY-LICENSE.txt`.
* npm dependencies: earcut (ISC), @cornerstonejs/codec-openjpeg (MIT), h5wasm (MIT).
* The Cloud Nuke logo (`public/assets/branding/`) is the owner's artwork.

## Code size

`npm run loc` counts lines that hold code after removing comments and blank lines, in handwritten runtime source
(`src/` without `src/generated/`, plus `server/`); tests, generated catalogs, assets and tools are excluded.

| Part | Lines |
| --- | ---: |
| TypeScript / JavaScript | 17,367 |
| WGSL shaders | 689 |
| **Total functional** | **18,056** |
| CSS (separate) | 174 |
