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
  * Cross-section / RHI (Alt+X, or Draw line in the dialog) through the Level 2 volume drawn on the map: drag from A
    to B, or click A then B. With RHI on, both ends lie on one radial from the radar (the azimuth of the point placed
    or dragged; each end keeps its range). The end points stay draggable; Esc, Clear, the panel's close box or another
    radar site removes the line. The panel (movable; drag its lower-right corner to resize, the plot size is saved)
    renders the section on the GPU from every tilt of the volume (half a beamwidth around each tilt, reflectivity and
    dual-pol blended between tilts up to two beamwidths apart, velocity from the nearer tilt) with the map's palette
    for the moment: reflectivity, velocity (dealiased), storm-relative velocity (the shown volume's storm motion, as
    the map), ZDR, CC or KDP. It shows heights from 0 to the maximum height (kft or km above the radar, per the
    distance units), the distance from A (an RHI: the range from the radar), optional beam-centre lines of each tilt
    and the 0/−10/−20 °C heights (HRRR at the radar, or the custom heights; "estimated" −10 °C as for the column
    products), a legend and a header with the site, volume time and moment. It follows the volume drawn as the loop
    plays (the previous section stays, labelled with its own volume time, while the next volume uploads). Moving the
    pointer over the plot reads the value with the reference sampler, the height above radar level and sea level, the
    ground and slant range and the nearest tilt. "Follow storm motion" moves the end points with the shown volume's
    storm motion from the time the line was placed or last edited, like a manual storm track.
  * Max-value trail: the per-gate maximum of a Level 2 product over the complete volumes of the loop (window 0), or
    over the volumes within the last N minutes up to the volume shown, drawn over the radar at the chosen opacity:
    hail core, ZDR column, KDP column, azimuthal shear, VIL, MEHS, POSH, VIL density, echo tops, gust potential or
    reflectivity at the shown tilt. Each volume's product is built once for the trail (site, product, tilt and
    algorithm inputs) and the maximum is blended on the GPU; the legend reads "max over HH:MM–HH:MMZ (N volumes)".
    The live volume still being scanned is not included; another site, product or algorithm input starts over.
  * Rolling live volume products: with Live Sweep on, the Level 2 volume products (11–19) of the live volume use its
    tilts scanned so far and fill the tilts above them from the previous volume. The legend reads "Rolling volume: N
    of M tilts from the previous volume · data HH:MM–HH:MMZ" (the span of the radials used); complete volumes are
    unchanged.
  * 3D volume view (the right-hand group of the dialog) of the Level 2 volume shown at the timeline time, drawn
    over the map with the ordinary camera (Ctrl+drag tilts and swivels): **Volume** renders the volume
    semi-transparently with the moment's palette (transparent below "Volume: from", denser toward the top of the
    scale, times the opacity), **Isosurfaces** draws one or two lit surfaces where the moment reaches a value, each
    with its own colour and opacity. Moments: reflectivity, velocity, storm-relative velocity (the volume's own storm
    motion, as for the storm-relative product), ZDR, CC and KDP; each keeps its own thresholds. For the velocities the
    thresholds are speeds: surface 1 is outbound and surface 2 inbound, and the volume threshold applies to both.
    Heights are stretched by Radar Control → Tilt exaggeration (factor 1 + value / 25, as the 3D tilt, never below
    0.2); the height scale at the radar marks every 5 km (10 kft with imperial units) up to the top of the view, 20 km
    above the radar. "Samples per ray" sets the quality: 160 samples at most along a ray, with steps of 0.2 km near
    the radar that widen with range as the beams do, and proportionally finer or coarser for other values. The view
    is drawn at half the map's resolution; when its GPU time (F8) stays above 4 ms it is drawn at a third or a quarter
    until a finer size fits again (the dialog shows the size in use). It follows the loop: each frame shows its own
    volume, and nothing is drawn for a frame whose volume is still loading. It needs Level 2 data and is drawn over
    the product's sweep, not sorted in depth with it or with other layers.
* Linked panes (CWRV3 menu → Linked panes…; Alt+P or "Next pane layout" cycles the layouts): the map as one pane,
  two side by side, two stacked or four (2 × 2). The panes share the one camera (pan, zoom, tilt and swivel in any
  pane move all of them), the one timeline and the pointer: a crosshair marks the pointer's map point in every other
  pane, and in Probe mode every pane shows the readout of what it draws there. Only NEXRAD differs between panes.
  Pane 1 is the Radar Control selection (level, product, tilt), as in the single view; panes 2–4 each have their own
  data level (Level 2 or 3), product, tilt and "Min. earlier" (that pane shows the volume of so many minutes before
  the timeline time, and nothing before its first volume). Every other layer (background, GIS, warnings, MRMS,
  satellite, annotations…) is drawn the same in every pane. Each pane has its NEXRAD legend across its top and a
  caption with the site, product, tilt, offset and the volume time it draws, or why it draws nothing ("loading…",
  "not available for this volume", "no volume at this time"); the other layers' legends are in pane 1 only.
  * Quick presets: **REF / SRV** (two panes), **REF / VEL / ZDR / CC** (four panes: reflectivity, dealiased
    velocity, ZDR and CC at the current tilt) and **Four lowest tilts** (the current single-tilt product, or
    reflectivity, at the four lowest angles of the volume shown; a SAILS/MRLE rescan or split cut of an angle counts
    once). A preset or a saved layout also sets pane 1, i.e. the Radar Control product and tilt. "Save current
    as…" keeps the layout and every pane's view under a name; Recall (or a double click) and Delete act on the list.
  * A volume is downloaded and decoded once for all panes; a pane adds one product build and one sweep texture
    (1–5 MB) per volume. While more than one pane is shown the Level 2 loop is the newest 12 volumes in every pane.
  * The timeline's frames are pane 1's. A pane whose sweep of the shown volume is still loading keeps its previous
    volume, and its caption names the volume time it actually draws.
  * Storm attributes (storm tracks, TVS, hail, mesocyclones, melting layer) are matched to pane 1's volume and are
    drawn in another pane only while that pane draws the same volume (so not in a pane with a time offset).
  * Range rings, the cross-section line and the VR-shear points are drawn in every pane, and the line and points can
    be placed or dragged in any pane. VR shear measures the pane its first point is clicked in when that pane shows
    velocity, else the first pane that does (the readout names the pane), and ends when that pane's product changes.
    The Probe beam geometry is that of each pane's own tilt.
  * Pane 1 only: the cross-section panel's volume, the max-value trail and its legend, the 3D volume view, the live
    composite, the live-sweep gauge, beam and data age, and the screen-space items (timestamp, watch and info boxes,
    placed road labels).
  * Archive replay works in every pane: Level 2 panes from the volume archive, a Level 3 pane from the Level 3
    archive.
* Archive replay (CWRV3 menu → Archive replay…): enter a UTC date and time (and optionally a radar site) and choose
  Go to time. The loop then ends at that time instead of now: radar, warnings, storm reports, SPC products, MRMS and
  satellite are loaded for it, the status bar shows **ARCHIVE yyyy-mm-dd HH:MMZ** (click it to reopen the dialog) and
  names the enabled layers that have nothing for that time. "◀ One loop" / "One loop ▶" move the time by the loop
  length (Loop Length still sets how much is loaded), Live (or CWRV3 menu → Return to live data) goes back to current
  data. The mode and time are kept across a reload. Event presets hold a name, time, radar site and map view: five
  built-in events (1999-05-03 Bridge Creek–Moore KTLX, 2011-04-27 Tuscaloosa–Birmingham KBMX, 2013-05-20 Moore KTLX,
  2021-12-10 Mayfield KPAH, 2024-05-06 Barnsdall KINX; each checked to have Level 2 volumes) and your own (Save
  current as…, Delete). What is shown in archive mode:
  * NEXRAD Level 2 from the AWS archive only (the gzip volumes of the years before mid-2016 included), no live sweep.
    Volumes before Message 31 (1991 to 2008) are decoded from their Message 1 radials: reflectivity at 1 km gates,
    velocity and spectrum width at 250 m gates, 1° radials (each sweep cut to one turn), no dual-pol, so ZDR, CC, PHI,
    KDP and the ZDR/KDP columns show "not available for this volume". The site position comes from the radar site
    table, and cuts of volumes without a VCP record (before about 2005) from the VCP's cut list, or from their
    moments for a VCP not in it. Doppler gates the legacy RDA (before about 2006) placed behind the antenna are
    dropped; its ranges are otherwise used as recorded. The bucket holds these years as whole-file gzip (no .Z
    files were found in the listings checked).
    Level 3 products from the Unidata Level 3 archive bucket (2020-03-30 on); where the archive has no
    digital base reflectivity or velocity (N?Q / N?U, from 2022–23), their super-resolution successors (N?B / N?G) are
    drawn and named in the status line. Storm attributes are matched per volume as in live mode: storm tracks,
    mesocyclones, melting layer and the automatic storm motion from the archived Level 3 products, and what the
    archive does not hold for the period (TVS, hail and the storm-cell table always; cells and mesocyclones before
    2020) from IEM's storm attributes (2000 on), stored under the volume time IEM reports for them.
  * Warnings: IEM storm-based warning polygons (Tornado, Severe Thunderstorm, Flash Flood, Special Marine, Snow
    Squall, Extreme Wind), each version drawn only from when it took effect until an update, cancellation or expiry
    replaced it. Hail, wind, tornado and damage tags are those of the issuance and are shown on the issued polygon
    only (later statements can change them; their polygons carry no tags); there is no storm-motion line, so no
    tracking objects. Watches are SPC's issued four-sided outlines, not county unions. Nothing is announced as new,
    and the storm alerts stay silent.
  * Local storm reports, SPC mesoscale discussions and WPC precipitation discussions (each shown while it was in
    effect at the timeline time) and the SPC convective outlook that was the newest issued at the archive time, from
    IEM. MRMS and the national mosaic by bucket date (2020-10-14 on), ProbSevere v3 where the archived files are v3
    (those of 2025-10-01 and later that were checked are; those of 2025-06-01 and earlier are an older version: the
    first such file stops the downloads and the status says so), GOES imagery, GOES Level 2 products and GLM
    lightning from the satellite that held the position then (GOES-16 as East before 2025-04-07, GOES-17 as West
    before 2023-01-04), MESO/STP/SCP from the RAP archive, precipitation typing and hail isotherms from HRRR valid at
    the data time, and soundings (radiosonde, model, VAD from the Level 3 archive) for the timeline time.
  * Everything else shows "not available for this time" and is neither loaded nor drawn: surface analysis, METAR and
    marine observations, the model, NDFD, winter, forecast, tropical and Misc layers, NWS advisories, Special Weather
    Statements, placefiles, the custom radar, radar status, zone alerts and the current text products. A product
    whose archive does not reach the chosen time says the same (for example MRMS in 2013).
* F8 (or CWRV3 → Advanced → Performance panel) shows the global frame rate and times, GPU time of the main pass and
  of the layers' offscreen prepasses where the adapter supports timestamp queries, total tracked texture memory and the JS heap (N/A where the browser does not report
  it), and one row per layer or owner with its decode jobs, texture uploads, live texture memory and status. Each layer's decode time excludes network, queueing and transfer, shown beside
  the worker's fetch + decode wall time. It samples only while open and sends nothing anywhere.

Open Settings from the CWRV3 menu to change rendering, radar, lightning and display preferences. Changes save in
this browser automatically. Use settings export/import to move them to another browser. The About area of Settings links to the source
repository, [aDefaultUser/CWRV3](https://github.com/aDefaultUser/CWRV3).

* Drag to pan; use the wheel to zoom. Ctrl+drag tilts and swivels.
* R toggles radar site labels; Alt+D measures distance; Alt+L adds road labels; Alt+V starts a VR-shear measurement;
  Alt+S picks a sounding point; Alt+X draws a cross-section / RHI line; Alt+P shows the next pane layout (one pane,
  two side by side, two stacked, four).
* Ctrl+T starts telestration, Space clears it, and Esc cancels the active tool (and clears the VR-shear measurement
  and the cross-section line).

## Development

```sh
npm run check    # typecheck, unit tests, production build
npm test         # unit tests only
npm run loc      # functional lines of code (method in tools/loc.mjs)
npm run bench -- <label> <fixed4k|dpr1|dpr15|dpr2> --out <dir> [--fps 60|0] [--headful] [--runs 3]
```

`APP_URL` selects the server the benchmark opens (default `http://127.0.0.1:4173/`). `--scenarios` also accepts
`l2volume` and `l2iso` (not in the default list): the 3D volume view in volume or isosurface mode while the camera
orbits the radar and the Level 2 loop plays; their results add the GPU time of the prepass. `l2panes2` and
`l2panes4` (also not in the default list) show the REF / SRV and REF / VEL / ZDR / CC pane presets while the Level 2
loop plays and the map pans and zooms around the radar. In the browser console,
`cwrv3bench.volumeCheck()` renders vertical sections of the drawn Level 2 volume with the GPU volume sampler and
compares them pixel by pixel with the TypeScript reference; `cwrv3bench.trailCheck()` reads back the max-value trail
drawn now and compares it texel by texel with the TypeScript blend reference over the same volumes. `cwrv3bench.isoCheck()` reads back where the
isosurface march first meets the 50 dBZ surface from three camera positions and checks every twelfth ray against
the TypeScript sampler (a hit must lie on a real crossing; a ray without a hit must have no echo thicker than two
march steps).

The benchmark (`tools/perf/run-bench.mjs`) drives an isolated Chromium (temporary profile, DevTools port 9333) against
the production build; Level 2 runs use the fixed KTLX archive volumes listed in `public/perf-fixtures.json`.

## Preferences and persistence

Every preference is saved in the browser's `localStorage` under the `cwrv3.` prefix. Each setting is its own record,
`cwrv3.setting/<id>` holding the JSON value; the other user state (styles, text styles, style library, presets,
viewpoints, scene and layer presets, layer order, RGB recipes, model configurations, palettes loaded from files,
placefile and shapefile lists, road labels, dialog options, GPS serial options, storm alert points, the archive
replay time and archive event presets, the pane layout with the views of panes 2–4 (`cwrv3.panes`) and the saved
pane layouts (`cwrv3.paneLayouts`)) uses one key per preference.
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
* The 3D volume view is not in the original. It samples the tilts directly (nearest gate and azimuth bin, linear
  between neighbouring tilts, nothing below the lowest beam or between tilts more than two beamwidths apart), so far
  from the radar it shows the beams as slabs. March steps follow the data's resolution, not the screen's: an echo
  thinner than a step along the ray can be missed. Isosurface normals come from differences 0.6 km apart. The
  volume is not depth-sorted with the map's other layers, and a velocity pack carries one storm motion, so two
  views of the same volume cannot show ground-relative and storm-relative velocity at once.
* Linked panes are not in the original. There is one camera and one timeline: panes cannot be panned, zoomed or
  played independently, and a pane's time can differ only by a fixed offset. A pane has the camera's 30° vertical
  field of view, so the same camera distance shows the same north–south extent in a half-height pane at half the
  scale. The backbuffer is divided into equal whole-pixel panes (an odd width or height leaves one unused pixel row
  or column). Only NEXRAD has per-pane products; the trail, the 3D view and the section follow pane 1.
* NAM-family and HiresW model feeds were unavailable from the public servers when last checked (HTTP 404 on
  2026-11-17; the `noaa-nam-pds` bucket ends on 2026-11-03) and are reported as unavailable instead of being
  substituted. RRFS, which replaced them operationally, is listed as its own model.
* The live sweep depends on the public real-time chunk bucket being current for the site; otherwise it falls back to
  the TGFTP volume and says so.
* Archive replay is a CWRV3 addition built on public archives, so it differs from live mode where those differ:
  warning tags and watch shapes (see Archive replay above), no Special Weather Statements, storm attributes partly
  from IEM's table instead of the Level 3 graphics (no past or forecast track positions for cells that come from it),
  and super-resolution Level 3 base products where the original ones are no longer archived. IEM answers a
  storm-attribute request with each radar's volume nearest the asked time; a frame without a volume within 2 minutes
  shows "No storm attributes". Queries for a period that ended more than a day ago are cached as immutable.

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
| | 3D volume view, volume rendering (`l2volume`: orbit around KTLX, loop playing), target 60, 2 × 40 s | 2/2 runs 60.0 fps, p99 16.8 ms, 0/2401 frames > 20 ms, CPU 2.7 ms mean, GPU 2.1 ms mean, of which the 1920×1080 march 0.62 ms mean, 0.70 ms p95, 0.77 ms max |
| | 3D volume view, isosurfaces 50 and 30 dBZ (`l2iso`), target 60, 2 × 40 s | 2/2 runs 60.0 fps, p99 16.8 ms, 0/2401 frames > 20 ms, CPU 2.7 ms mean, GPU 2.4 ms mean, of which the march 0.97 ms mean, 1.4 ms p95, 1.6 ms max |
| | Linked panes, 2 side by side REF / SRV (`l2panes2`: loop playing, pan and zoom around KTLX), target 60, 2 × 40 s | 2/2 runs 60.0 fps, p99 16.8 ms, 0/2401 frames > 20 ms, CPU 2.1 ms mean, GPU 1.6–1.7 ms mean, 1.7–1.8 ms p95 |
| | Linked panes, 4 (2 × 2) REF / VEL / ZDR / CC (`l2panes4`), target 60, 2 × 40 s | 2/2 runs 60.0 fps, p99 16.8 ms, 0/2401 frames > 20 ms, CPU 2.0 ms mean, GPU 2.2–2.3 ms mean, 2.4 ms p95 |

Mean CPU time per frame was about 2 ms and GPU time about 0.6–1.6 ms in every run without the 3D volume view or
panes, so the frame rate is set by the FPS target or the display refresh, not by rendering cost. The 4K runs are
short smoke checks, not full measurements.

Linked panes cost GPU time, not CPU time: the layers that are the same in every pane are recorded once per frame and
replayed in each pane's viewport, and only NEXRAD is drawn per pane. In the session of the two pane rows the
single-pane Level 2 loop measured 1.5 ms GPU and 2.2 ms CPU (2 × 40 s, 60.0 fps), so two panes added about 0.2 ms
and four about 0.8 ms of GPU time at 3840×2160 (the pane runs also pan and zoom, which the loop run does not). Each
pane holds its own sweep of every volume of the loop: with the 8 fixture volumes, reflectivity at two tilts in two
panes was 20.2 MB of NEXRAD texture memory against 10.1 MB for the single view (F8).

The march of the 3D volume view costs what the echo on screen costs. Measured by hand at 3840×2160 (a 1920×1080
target, 160 samples per ray) with the fixture's storms filling the view, 150–250 km from the radar: 2.2–2.4 ms for
the default reflectivity isosurfaces (0.7 ms with one opaque surface) and 1.8–2.1 ms for volume rendering; a view
with no echo above the threshold costs 0.1 ms. Noisy moments exceed the 4 ms budget at half resolution
(storm-relative velocity and CC isosurfaces, ZDR volume): the target then drops to 1280×720 or 960×540 and the march
stays at 1.3–3.1 ms, at 60 fps in every case. A reflectivity close-up from 88 km with echo over the whole screen
measured 2.4–3.0 ms on a 918×489 target; it was not measured at 4K, where by pixel count it would run at a third or
a quarter of the map's resolution. Building a pack's occupancy grid takes 25–90 ms per volume and moment (timed in
Node on a 14-tilt, 1832-gate pack; in the app it runs in a decode worker) and the grid is 2.2 MB of texture memory.

## Data sources

NOAA Open Data on AWS (MRMS including FLASH and the ProbSevere v3 storm objects, with the NCEP MRMS real-time directory as a
fallback, HRRR, RRFS, RAP, GFS, NBM, GOES ABI/GLM including the ABI L2+ cloud-top height, cloud-top
temperature and fire/hot spot products, from GOES-16/17 for archive times before GOES-19/18 took over; NEXRAD Level 2
archive and real-time chunks; and, for archive replay only, the NEXRAD Level 3 archive `unidata-nexrad-level3`, a
direct CORS-enabled host added because TGFTP keeps only the newest ~250 files per product), NWS
TGFTP (Level 2/3, NDFD, text products), api.weather.gov (alerts, zones, radar station status), Aviation Weather Center, SPC, WPC, CPC, NHC, NDBC, USGS
earthquakes, NASA FIRMS, NOAA water data, the US Drought Monitor (University of Nebraska–Lincoln), Iowa Environmental
Mesonet (including radiosondes from `json/raob.py` with the station list `api/1/network/RAOB.json`, BUFKIT model
profiles from `api/1/nws/bufkit.json`, and for archive replay `api/1/vtec/sbw_interval.geojson`, `geojson/sbw.php`,
`geojson/lsr.php`, `api/1/spc_watch_outline.geojson`, `api/1/nws/spc_mcd.geojson`, `api/1/nws/wpc_mpd.geojson`,
`api/1/nws/spc_outlook.geojson` and `geojson/nexrad_attr.php`), NASA GIBS imagery and AWS Terrain Tiles. Bundled GIS layers come from Natural Earth and US Census TIGER.

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
| TypeScript / JavaScript | 21,727 |
| WGSL shaders | 921 |
| **Total functional** | **22,648** |
| CSS (separate) | 178 |
