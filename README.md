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
* Storm attributes (storm tracks and the storm-cell table, TVS, hail, mesocyclone and melting-layer overlays) and the
  automatic storm motion are read per volume from the rotating TGFTP Level 3 files and drawn only over the radar
  volume they belong to: matched by volume start time (within 2 min; Level 3 SAILS/MRLE cuts by their volume scan
  number). A frame without them, such as the live volume still being scanned or an archived loop older than TGFTP
  keeps (about 250 files per product, 28–46 h at the busy sites checked), shows "No storm attributes for HH:MMZ" at
  the radar. Automatic storm-relative velocity uses each volume's own vector, or the manual one where it has none.
* NEXRADPro → Level 2 product menu, three products built from every tilt of the volume: **ZDR Column** and
  **KDP Column** (the largest ZDR / KDP among the beams at or above the −10 °C height, counting only gates with
  reflectivity ≥ 20 dBZ and CC ≥ 0.80) and **Hail Core** (the largest reflectivity at or above the −20 °C height).
  The heights are the HRRR analysis 0 °C, −10 °C and −20 °C isotherm heights at the radar, or the custom heights
  when "Custom isotherm heights" is on in the Level 2 algorithm settings. With custom heights, or when the model has
  no −10 °C height, the −10 °C height is taken midway between the other two and the legend says "Estimated". Each
  product has its own palette (the palette button of the radar panel).
* Extended GOES-R Data → Product "Level 2 Product": cloud-top height (`ABI-L2-ACHA`, CONUS / Full Disk /
  Mesoscale), cloud-top temperature (`ABI-L2-ACHT`, Full Disk / Mesoscale; not produced for CONUS) and fire/hot spot
  with fire radiative power (`ABI-L2-FDC`, CONUS / Full Disk / Mesoscale) from GOES-19 or GOES-18. Cloud-top values
  are drawn for good-quality pixels only (product DQF 0); fires are points coloured by power, probe them for
  category, power, temperature and area.
* MRMS → ProbSevere v3 (Options… for the dialog): NOAA's operational ProbSevere v3 storm objects (MRMS v12.3 and
  later), outlined (optionally filled) and coloured by the selected probability (any severe, tornado, hail or wind),
  with a minimum-probability filter, % labels, 30-minute motion arrows, opacity and line width. Files come about every
  2 minutes; the file drawn is the newest one at or before the displayed time and at most 2.5 minutes older (the newest
  file stays current for 6 minutes until its successor is due); otherwise nothing is drawn and the status says so.
  Interact rollover and Probe show all four probabilities, MESH, maximum low-level azimuthal shear, motion, object ID,
  valid time and a sparkline of the selected probability over the last hour for that object.
* CWRV3 → Storm alerts…: alerts for the GPS position (when connected) and named alert points (Add… then click the
  map; rename/remove in the dialog) within a radius in the distance units (miles or km). Triggers, each optional: a
  new NWS Tornado, Severe Thunderstorm, Flash Flood, Snow Squall or Extreme Wind warning whose polygon contains a
  location or lies within the radius; ProbSevere tornado/hail/wind probability at or above its threshold for an
  object within the radius; a NEXRAD TVS within the radius (the selected site's Level 3 overlays, so storm tracks or
  TVS icons must be on); and a storm (NEXRAD cell motion, or ProbSevere motion for objects above a minimum
  probability) projected to come within the radius in N minutes. Each event alerts once per location and again only
  on an upgrade (a warning update that adds tornado observed, a damage threat, PDS or an emergency; a ProbSevere
  probability reaching a higher 10 % band). Only the newest live data is checked (active NWS alerts polled every
  minute, the newest ProbSevere file when under 10 minutes old, NEXRAD products under 15 minutes old), never the
  displayed loop frame, and never with fixture or benchmark data. Outputs, each optional: on-screen message, tones
  synthesised in the browser (a different pattern per alert type; one tone per check, the most severe), speech and
  OS notifications (permission is asked when the option is turned on). Test alert sends a sample through the enabled
  outputs. Browsers start audio only after a click, so after a reload tones resume with the first click on the page.
* MRMS adds, from the public MRMS bucket: reflectivity at −10 °C and −20 °C; H50/H60 (depth of the 50/60 dBZ echo
  above the 0 °C and −20 °C levels, kft); 50 and 60 dBZ echo tops; 48 and 72 h multi-sensor QPE (Pass 2); next-60-minute
  lightning probability; 24 h low- and mid-level rotation tracks; FLASH flash-flood guidance (CREST maximum unit
  streamflow, QPE-to-FFG ratio as a percentage, QPE average recurrence interval in years; 2–10 min cadence); and the
  MRMS model freezing level (0 °C height, ft MSL) and surface wet-bulb temperature (°C). Products that share a unit
  with an existing one use its palette setting; the others have their own palette settings
  (`ext.settings.mrms*Palette`). The lightning jump grids are not offered: their dimensionless codes are not
  documented in the public MRMS table.
* Model → RRFS (the operational successor of NAM/HiresW): 3 km CONUS from `noaa-rrfs-ops-pds`, every 3 h to 18 h
  (RRFS), 00/06/12/18 UTC to 84 h (RRFS 84 hour), and the pressure-level file (RRFS Pressure Levels), by `.idx`
  byte ranges like HRRR. The 13 km North America file (rotated lat/lon grid) is not used.
* Radar status (api.weather.gov `/radar/stations`, read at most every 5 minutes while site labels or NEXRAD are on):
  the NEXRAD status line shows the selected site's current VCP (with the RDA operability or state when it is not
  on-line/operating); the site's "i" badge and the map rollover over a site show VCP, operability, state, Level 2
  latency, alarms and the check time. A site reported inoperable or shut down, or whose Level 2 data is more than 30
  minutes old, is drawn grey and dimmed. Missing fields read "unknown"; a table older than 15 minutes is not shown.
* Radar analysis tools (CWRV3 menu → Radar analysis tools…):
  * Range rings around the selected NEXRAD site, drawn with the NEXRAD layer: interval (in the distance units of
    Spatial Tools → Imperial units, mi or km), count, colour, width, distance labels on the north side and optional
    azimuth spokes every N degrees. They follow site changes.
  * In Probe mode, single-tilt NEXRAD products (Level 2 base and per-tilt products, Level 3 products with a tilt) add
    the ground and slant range and azimuth from the radar and the beam-centre height above radar level and sea level
    (site elevation from the NCEI station table) for the tilt drawn, in mi/ft or km/m. Volume and multi-tilt products
    (live composite, Level 2 VIL/echo tops/hail/gust, composite reflectivity, precipitation, Level 3 products without
    a tilt) show none.
  * VR shear (Alt+V) on a Level 2 velocity / storm-relative velocity or Level 3 velocity / SRM product: click the
    maximum inbound and then the maximum outbound velocity. Both values are read through the NEXRAD probe (what Probe
    shows, including smoothing and scan blending) from the scan drawn at the timeline time; the dialog shows Vin, Vout,
    ΔV, Vr = (|Vin| + |Vout|)/2 (only for opposite signs), the distance, shear ΔV/d (s⁻¹), mean range and beam height.
    Points must be on screen to be read; a new scan at the timeline time is read again, and a product, tilt or site
    change clears the measurement. Esc cancels it.
  * Sounding (Alt+S, or Ctrl+right-click → Sounding here…): click a point; the panel shows a skew-T log-p diagram
    (temperature, dew point, surface-based and 100 hPa mixed-layer parcels, wind barbs), a hodograph coloured by
    height band with the Bunkers right/left movers and 0–6 km mean wind, and SB/ML/MU CAPE and CIN, LCL/LFC/EL,
    0–1/0–3 km helicity (Bunkers right mover), 0–1/0–6 km bulk shear, precipitable water and 700–500 hPa / 0–3 km
    lapse rates. Sources: the nearest radiosonde (up to three stations within 800 km, 00/12 UTC launches at or before
    the timeline time, newest first), a model profile (RAP, HRRR, GFS, NAM, RRFS; IEM's nearest BUFKIT site, valid at
    the timeline time rounded to the hour), or the selected radar's VAD wind profile (Level 3 product 48, newest at or
    before the timeline time; winds only, layers from its lowest level, standard-atmosphere pressures for the
    pressure-weighted means). The panel names the station, position, run and valid time that were returned. The
    formulations follow MetPy 1.7 (Ambaum saturation pressure, Romps LCL, virtual-temperature CAPE/CIN,
    pressure-weighted Bunkers motion); the unit tests compare them with MetPy's documented values.
* F8 (or CWRV3 → Advanced → Performance panel) shows the global frame rate and times, GPU time of the main pass and
  of the layers' offscreen prepasses where the adapter supports timestamp queries, total tracked texture memory and the JS heap (N/A where the browser does not report
  it), and one row per layer or owner with its decode jobs, texture uploads, live texture memory and status. Each layer's decode time excludes network, queueing and transfer, shown beside
  the worker's fetch + decode wall time. It samples only while open and sends nothing anywhere.

Open Settings from the CWRV3 menu to change rendering, radar, lightning and display preferences. Changes save in
this browser automatically. Use settings export/import to move them to another browser. The About area of Settings links to the source
repository, [aDefaultUser/CWRV3](https://github.com/aDefaultUser/CWRV3).

* Drag to pan; use the wheel to zoom. Ctrl+drag tilts and swivels.
* R toggles radar site labels; Alt+D measures distance; Alt+L adds road labels; Alt+V starts a VR-shear measurement;
  Alt+S picks a sounding point.
* Ctrl+T starts telestration, Space clears it, and Esc cancels the active tool (and clears the VR-shear measurement).

## Development

```sh
npm run check    # typecheck, unit tests, production build
npm test         # unit tests only
npm run loc      # functional lines of code (method in tools/loc.mjs)
npm run bench -- <label> <fixed4k|dpr1|dpr15|dpr2> --out <dir> [--fps 60|0] [--headful] [--runs 3]
```

`APP_URL` selects the server the benchmark opens (default `http://127.0.0.1:4173/`). In the browser console,
`cwrv3bench.volumeCheck()` renders vertical sections of the drawn Level 2 volume with the GPU volume sampler and
compares them pixel by pixel with the TypeScript reference.

The benchmark (`tools/perf/run-bench.mjs`) drives an isolated Chromium (temporary profile, DevTools port 9333) against
the production build; Level 2 runs use the fixed KTLX archive volumes listed in `public/perf-fixtures.json`.

## Preferences and persistence

Every preference is saved in the browser's `localStorage` under the `cwrv3.` prefix. Each setting is its own record,
`cwrv3.setting/<id>` holding the JSON value; the other user state (styles, text styles, style library, presets,
viewpoints, scene and layer presets, layer order, RGB recipes, model configurations, palettes loaded from files,
placefile and shapefile lists, road labels, dialog options, GPS serial options, storm alert points) uses one key per
preference.
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
  Level 3 general status message product is not drawn. The volume products (MEHS to hail core) place every tilt on
  one fixed half-degree azimuth frame by true azimuth (nearest radial, a 1° radial fills two bins, nothing is
  averaged), so their values at echo edges differ slightly from builds before this frame existed.
* The ZDR column, KDP column and hail core products are not in the original and are proxies, not column depths:
  each is a maximum over beam centres above an isotherm height, without vertical interpolation between tilts, so
  far from the radar few beams qualify. KDP is this program's own estimate and is noisy at high tilts; the 20 dBZ
  and CC 0.80 gates are this implementation's choice.
* NAM-family and HiresW model feeds were unavailable from the public servers when last checked (HTTP 404 on
  2026-11-17; the `noaa-nam-pds` bucket ends on 2026-11-03) and are reported as unavailable instead of being
  substituted. RRFS, which replaced them operationally, is listed as its own model.
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
| | Level 2 loop (8 KTLX volumes), target 60, 1 × 60 s | 60.0 fps, p99 16.8 ms, 0/3601 frames > 20 ms, CPU 2.1 ms mean, GPU 1.3 ms mean |

Mean CPU time per frame was about 2 ms and GPU time about 0.6–1.6 ms in every run, so the frame rate is set by
the FPS target or the display refresh, not by rendering cost. The 4K runs are short smoke checks, not full
measurements.

## Data sources

NOAA Open Data on AWS (MRMS including FLASH and the ProbSevere v3 storm objects, with the NCEP MRMS real-time directory as a
fallback, HRRR, RRFS, RAP, GFS, NBM, GOES ABI/GLM including the ABI L2+ cloud-top height, cloud-top
temperature and fire/hot spot products, NEXRAD Level 2 archive and real-time chunks), NWS
TGFTP (Level 2/3, NDFD, text products), api.weather.gov (alerts, zones, radar station status), Aviation Weather Center, SPC, WPC, CPC, NHC, NDBC, USGS
earthquakes, NASA FIRMS, NOAA water data, the US Drought Monitor (University of Nebraska–Lincoln), Iowa Environmental
Mesonet (including radiosondes from `json/raob.py` with the station list `api/1/network/RAOB.json`, and BUFKIT model
profiles from `api/1/nws/bufkit.json`), NASA GIBS imagery and AWS Terrain Tiles. Bundled GIS layers come from Natural Earth and US Census TIGER.

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
* NWS standard reflectivity/velocity tables via MetPy (BSD-3-Clause): `src/palettes/METPY-LICENSE.txt`. The test
  fixture `tests/fixtures/sounding/ddc-2016052200.txt` is MetPy's `staticdata/may22_sounding.txt` (same licence).
* npm dependencies: earcut (ISC), @cornerstonejs/codec-openjpeg (MIT), h5wasm (MIT).
* The Cloud Nuke logo (`public/assets/branding/`) is the owner's artwork.

## Code size

`npm run loc` counts lines that hold code after removing comments and blank lines, in handwritten runtime source
(`src/` without `src/generated/`, plus `server/`); tests, generated catalogs, assets and tools are excluded.

| Part | Lines |
| --- | ---: |
| TypeScript / JavaScript | 19,460 |
| WGSL shaders | 753 |
| **Total functional** | **20,213** |
| CSS (separate) | 174 |
