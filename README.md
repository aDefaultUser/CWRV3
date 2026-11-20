<img src="assets/icon.svg" width="64" height="64" alt="">

# CWRV3

A browser-based weather workstation with WebGPU rendering, built only on public weather and GIS data. Thirteen section
tabs (Basic, World, Surface, NEXRADPro, MRMS, Model, MESO, Forecast, NDFD, NWS/SPC, Tropical, Winter, Misc) share one
3D map. Decoding (NEXRAD Archive II and Level III, GRIB2, NetCDF/HDF5, shapefiles) runs in Web Workers.

made by Cloud Nuke Software Collective. Original idea made by Paul Marv Software.

## Quick start

Needs Node.js 22.12+, npm, internet access to the public data hosts, and a Chromium-based browser with
WebGPU on a hardware adapter (on Linux, start Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` if no
adapter is found).

```sh
npm install
npm run dev                       # development server, http://127.0.0.1:5173/
npm run build && npm run serve    # production build, http://127.0.0.1:4173/
```

Both servers listen on loopback only and include a small proxy (`server/proxy.mjs`) for public hosts that send no
CORS headers: GET/HEAD to a fixed HTTPS allowlist, with redirect, size and stall limits. GIS data is bundled;
`npm run gis` rebuilds it from the public sources.

**Optional Rust decoder.** With Rust 1.85+ and `rustup target add wasm32-unknown-unknown`, `npm run dev`, `build`,
`test` and `check` first build the faster Level 2 decoder in `rust/archive2` to WebAssembly (no C compiler needed).
With no Rust toolchain, Level 2 uses the TypeScript decoder (`src/decode/archive2.ts`). The decoders matched on the
valid scans tested. Rust rejects corrupt bzip2 records. Set `CWRV3_REQUIRE_WASM=1` to require the Rust build.

## Using CWRV3

Pick a section tab, switch on its layers, then pan and zoom the map. In NEXRADPro choose a radar site, Level 2 or
Level 3, a product and a tilt. Use the timeline controls to step or play the loop.

| Input | Action |
| --- | --- |
| Left drag · wheel or right drag | Pan · zoom |
| Ctrl+left drag · Ctrl+right drag | Tilt and swivel · zoom box |
| R · F8 | Radar site labels · performance panel |
| Alt+D · Alt+L | Measure distance · place road labels |
| Alt+V · Alt+S · Alt+X | VR shear · sounding · cross-section / RHI |
| Alt+P · Alt+F1–F12 | Next linked-pane layout · apply a scene preset |
| Ctrl+T · Space · Esc | Telestration · clear it · cancel the active tool |
| Ctrl+F · Ctrl+Z | Fullscreen · fly to the last clicked point |

Map modes: **Explore** moves the map only, **Interact** opens objects (warnings, sites, rollovers), **Probe** reads the
value under the pointer. The **CWRV3 menu** holds Settings, Help (keyboard summary) and the larger tools:

- **Radar analysis tools…**: range rings, beam height in Probe, VR shear, soundings (radiosonde, model or VAD),
  cross-section / RHI, max-value trail, rolling live-volume products and a 3D volume view (volume or isosurfaces).
- **Linked panes…**: up to four panes sharing one camera, timeline and pointer; only NEXRAD differs per pane.
  Presets REF / SRV, REF / VEL / ZDR / CC and four lowest tilts; layouts can be saved by name.
- **Archive replay…**: radar, warnings, reports, SPC products, MRMS and satellite for a past UTC time, with five
  built-in severe-weather events and your own presets. Layers without a public archive say "not available for this
  time"; "Return to live data" goes back.
- **Storm alerts…**: on-screen, tone, speech or OS-notification alerts for warnings, ProbSevere, TVS and approaching
  storms near the GPS position or named points.

Settings save automatically in this browser (`localStorage`, `cwrv3.` prefix; user files and the data cache in Cache
Storage). Advanced → "Settings storage / all settings…" shows the storage state, edits any setting by ID and exports
or imports settings as JSON. Settings that cannot work in a browser are shown disabled with the reason.

## World tab

Two layers outside the US products, each with its own switch, opacity, status line and on-map source credit.

- **Radar** (RainViewer global mosaic) is off by default and opt-in: the first time it is switched on, RainViewer's
  terms open (personal and educational use, direct browser requests, rate limits) and radar starts only after
  "Accept and show radar"; "Withdraw acceptance" turns it off. Tiles come straight from RainViewer (not through the
  proxy) within its request limit, cover only the last ~2 hours at zoom levels 0–7, and are coloured images, so Probe
  reads no value. "Shade areas without radar" marks areas outside RainViewer's coverage.
- **Satellite** (NOAA/NESDIS GMGSI) is the hourly global geostationary mosaic (longwave IR, visible, water vapour or
  shortwave IR) from `noaa-gmgsi-pds`. Files arrive 35–45 minutes after the hour; coverage is about 60°S–60°N.
  Values are NOAA's scaled 0–255 image values in grey, not temperatures.

## Known limitations

- Palette colours are independently authored; base reflectivity and velocity use the public NWS tables.
- ZDR column, KDP column and hail core are proxies (maxima above an isotherm height), not column depths.
- NAM-family and HiresW feeds were unavailable from the public servers when last checked (November 2026) and say so;
  RRFS is offered as its own model.
- Live sweep needs a current public real-time chunk feed for the site, else it shows the newest full volume.
  Archive replay is limited to what public archives hold.

## Development

```sh
npm run check    # typecheck, unit tests, production build
npm test         # unit tests only (Node, no browser)
npm run wasm     # build the Rust decoder alone
npm run loc      # functional lines of code (method in tools/loc.mjs)
npm run bench -- <label> <fixed4k|dpr1|dpr15|dpr2> --out <dir>   # isolated Chromium, DevTools port 9333
cargo test --release --manifest-path rust/archive2/Cargo.toml     # also cargo clippy and cargo fmt
```

`tests/archive2-wasm.test.ts` checks that the Rust and TypeScript decoders agree; set `CWRV3_ARCHIVE2_SAMPLES` to a
directory of Archive II files to include whole real volumes. The benchmark runs against the production build
(`APP_URL`, default `http://127.0.0.1:4173/`) with the fixed KTLX volumes in `public/perf-fixtures.json`.
`npm run deploy` publishes `dist/` to Cloudflare Pages, where `functions/proxy/[[path]].ts` applies the same proxy
rules (`server/proxy-rules.mjs`).

## Data sources

NOAA Open Data on AWS (NEXRAD Level 2 and real-time chunks, NEXRAD Level 3 archive, MRMS with FLASH and ProbSevere v3,
HRRR, RRFS, RAP, GFS, NBM, GOES ABI/GLM and ABI L2+, GMGSI), NWS TGFTP, api.weather.gov, Aviation Weather Center, SPC,
WPC, CPC, NHC, NDBC, USGS earthquakes, NASA FIRMS, NOAA water data, the US Drought Monitor (University of
Nebraska–Lincoln), Iowa Environmental Mesonet (soundings, BUFKIT profiles and archived warnings, reports, outlooks and
storm attributes), NASA GIBS imagery and AWS Terrain Tiles. Bundled GIS layers come from Natural Earth and US Census
TIGER. Worldwide radar (opt-in) comes from RainViewer's public Weather Maps API.

## Licences and third-party material

- Tabler Icons 3.52.0 (MIT): `public/assets/icons/tabler/LICENSE`; files and hashes in
  `public/assets/icons/manifest.json`.
- Route shields: OpenStreetMap Americana artwork and maplibre-gl-shields shapes (CC0-1.0,
  `public/assets/roads/shields/LICENSE-*`). The Interstate shield, a registered mark of AASHTO, only identifies routes.
- Noto Sans (SIL OFL 1.1): `public/assets/roads/fonts/LICENSE-OFL-1.1-NotoSans.txt`.
- FHWA 2024 Standard Highway Signs, all 1,059 listed codes (`public/assets/roads/mutcd/`; source, hashes and status in
  `manifest.json`). The drawings are US government works, but the 10 files in `restricted/` carry marks whose use
  MUTCD 1D.06 limits (Interstate shield, 511 pictograph, National Scenic Byway and Eisenhower Interstate System
  graphics); the app does not draw them.
- NWS reflectivity/velocity tables via MetPy (BSD-3-Clause): `src/palettes/METPY-LICENSE.txt`. The test fixture
  `tests/fixtures/sounding/ddc-2016052200.txt` is MetPy's `staticdata/may22_sounding.txt` (same licence).
- npm: earcut (ISC), @cornerstonejs/codec-openjpeg (MIT), h5wasm (MIT). Rust: bzip2 0.6.1 (MIT OR Apache-2.0) and
  libbz2-rs-sys 0.2.7 (bzip2-1.0.6 licence); their licence texts ship in `public/assets/archive2/`.
- The Cloud Nuke logo (`public/assets/branding/`) is the owner's artwork.
- RainViewer tiles are not redistributed: the browser loads them under RainViewer's terms
  (https://www.rainviewer.com/api/weather-maps-api.html, https://www.rainviewer.com/terms.html) with a linked credit
  on the map; the legend uses RainViewer's published colour table. NOAA GMGSI imagery is US government data.
- Test fixtures: `tests/fixtures/radar/KTLX20261115_135928_V06-trim` is NOAA NEXRAD Level 2 data from the public
  `unidata-nexrad-level2` bucket, object `2026/11/15/KTLX/KTLX20261115_135928_V06` (MD5
  `575ffb210a0fa91b2c4d462f25ab9ddd`), cut unchanged at record boundaries (header, metadata and the first 240 radials
  of the 15.5° tilt). `tests/fixtures/gmgsi/` holds NOAA GMGSI files of 2026-11-20 18:00 UTC reduced to every 40th
  row and 50th column; `tests/fixtures/rainviewer/` a RainViewer frame list of the same day.

## Code size

`npm run loc` counts code in `src/` (excluding `src/generated/`), `server/`, and `rust/*/src/`.
The total is **24,675 functional lines** (22,858 TypeScript/JavaScript, 954 WGSL, 863 Rust), plus 181 lines of CSS.
