// Settings deliberately without runtime effect, each with its own reason. The settings UI shows these controls
// disabled with the reason.
const DESKTOP = 'excluded', VENDOR = 'excluded-vendor', UNKNOWN = 'excluded';

/** Exact IDs, or prefixes ending in '.', mapped to [status, reason]. */
export const SETTING_EXCLUSIONS: Record<string, [string, string]> = {
  'config.graphicsSwapchain.': [DESKTOP, 'Direct3D swap-chain parameter; WebGPU presents through the browser compositor (no swap mode, buffer count, sync interval or frame-latency control).'],
  'config.dualmActivated': [DESKTOP, 'Second-monitor output of the desktop renderer; a web page cannot drive another display.'],
  'config.videoGDIWindowHandle': [DESKTOP, 'GDI capture by window handle; browsers capture through getDisplayMedia (whole screen / this tab are implemented).'],
  'config.videoDisableRAMPunishments': [DESKTOP, 'Encoder memory-pressure behaviour of the desktop recorder; MediaRecorder manages its own buffers.'],
  'config.helpURL': [VENDOR, 'Vendor help URL kept as a stored default only; never opened.'],
  'settings.generalLastUpdateCheck': [VENDOR, 'Vendor update check timestamp; no update server is contacted.'],
  'config.NWSAInstalled': [VENDOR, 'Flag of the vendor NWSA add-on install step; the public advisories layer needs no install.'],
  'settings.severeWarningsDataSourceMode': [VENDOR, 'Chooses among the vendor warning servers and the override; the public NWS API is always used (vendor servers are never contacted).'],
  'settings.severeWarningsServerOverride': [VENDOR, 'Override URL for the vendor/third-party warning push server; its protocol is undocumented, alerts come from the public NWS API.'],
  'config.classicUIStyle': [DESKTOP, 'Classic vs skinned VCL look of the desktop UI; the web build has one skin.'],
  'config.generalLaunchMaximized': [DESKTOP, 'Window state at launch is controlled by the browser.'],
  'config.terrainDXTOptimize': [DESKTOP, 'DXT texture compression switch of the Direct3D engine; tiles are uploaded uncompressed.'],
  'config.gpsCOMPort': [DESKTOP, 'Windows COM port name; Web Serial selects the port in the browser chooser (the GPS itself is implemented).'],
  'settings.nexradAlgorithmHailPOHZThreshold': [UNKNOWN, 'The original only loads, saves and shows this value; hail icons show the NWS HI product POH.'],
  'settings.nexradUseWindDataDealiasing': [UNKNOWN, 'The original has no consumer for this hidden value; dealiasing uses the two implemented schemes.'],
  'settings.nexradLevel3PrecipDifferencePalette': [UNKNOWN, 'Applies only to the precipitation-difference products DOD/DSD, which are disabled entries of the original Level 3 table.'],
  'settings.generalMappingMode': [UNKNOWN, 'General/MappingModeIndex has no known meaning (stored only; not the map mode, which is config.generalMapMode).'],
  'settings.raster3DLightMode': [UNKNOWN, '3DRaster light parameters are static keys only; no documented 3D raster object or lighting model to apply them to (zenith default 180° fits no verifiable convention).'],
  'settings.raster3DLightAzimuth': [UNKNOWN, 'see settings.raster3DLightMode'], 'settings.raster3DLightZenith': [UNKNOWN, 'see settings.raster3DLightMode'],
  'config.vfCustomIdx': [UNKNOWN, 'Index into a custom vector-field style table whose layout is unknown; vectors use the documented TVectorBarPanel types.'],
  'layerState.LightningIdx': [VENDOR, 'Source index of the paid lightning add-on; the public substitute has one source (GOES GLM).'],
  'settings.metarProductIndex': [UNKNOWN, 'Persisted without UI and without a known meaning; the displayed field is layerState.METARFieldIndex.'],
};

/** [status, reason] for a setting without runtime effect, or undefined. */
export function settingExclusion(id: string): [string, string] | undefined {
  if (SETTING_EXCLUSIONS[id]) return SETTING_EXCLUSIONS[id];
  if (id === 'config.dualmIdx') return SETTING_EXCLUSIONS['config.dualmActivated'];
  for (const [p, v] of Object.entries(SETTING_EXCLUSIONS)) if (p.endsWith('.') && id.startsWith(p)) return v;
  return undefined;
}

/** Notes shown in the all-settings editor for effective settings that have no control in the original dialogs. */
export const SETTING_NOTES: Record<string, string> = {
  'settings.generalAnisotropicFiltering': 'Basemap imagery anisotropic filtering: 0 or 1 = off (trilinear mipmaps only), 2–16 = maximum anisotropy; values above 16 act as 16, the WebGPU maximum.',
};
