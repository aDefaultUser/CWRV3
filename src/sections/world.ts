// World tab (Worldwide Weather): the RainViewer global radar mosaic (opt-in, behind its terms) and the NOAA GMGSI
// global geostationary satellite mosaic, each with its own switch, opacity and options, status and source links.
import type { App } from '../app/app';
import type { Section, SectionCtx } from './index';
import { act, bool, combo, custom, status } from './index';
import { settings } from '../settings/store';
import { WorldRadarLayer, termsAccepted, RV_SITE, RV_API_DOCS, RV_TERMS, RV_MAX_Z, RV_BUDGET_PER_MIN } from '../layers/world-radar';
import { WorldSatelliteLayer, GMGSI_INFO, GMGSI_BUCKET, GMGSI_MAX_FRAMES } from '../layers/world-satellite';
import { closeDialog, openDialog } from '../ui/dialogs';

const RV_FAQ = 'https://www.rainviewer.com/api/transition-faq.html';
const GMGSI_REGISTRY = 'https://registry.opendata.aws/noaa-gmgsi/';

export const RADAR_TERMS = [
  'Worldwide radar shows the RainViewer global radar mosaic through RainViewer\'s public Weather Maps API.',
  '',
  `• Terms: RainViewer states that the free API continues for personal and educational use (API transition summary). Read RainViewer's API documentation and Terms and Conditions (links below) before accepting.`,
  '• Privacy: this browser requests api.rainviewer.com and tilecache.rainviewer.com directly, so RainViewer sees your IP address and the map areas you view. Nothing is sent while the layer is off.',
  `• Load: only tiles in view are fetched, at most level ${RV_MAX_Z} (closer views enlarge them), and at most ${RV_BUDGET_PER_MIN} requests per minute (RainViewer's limit is 100 per IP); after a rate-limit answer requests pause.`,
  '• Data: a composite of national radar networks, the past ~2 hours in 10-minute frames; the time shown is the frame time of RainViewer\'s list, and older or archive times have no RainViewer data. The tiles are coloured images (RainViewer scheme 2, Universal Blue): there are no values to probe.',
  '• Clear areas mean no precipitation detected or no radar coverage; "Shade areas without radar" marks the areas outside coverage from RainViewer\'s coverage mask (updated rarely).',
  '• The NOAA NEXRAD and MRMS layers are separate and are not affected.',
].join('\n');

export const SATELLITE_INFO = [
  'NOAA/NESDIS Global Mosaic of Geostationary Satellite Imagery (GMGSI, v3), public bucket noaa-gmgsi-pds on AWS Open Data.',
  '',
  '• Satellites: GOES-East and GOES-West (USA), Meteosat 0° and Indian Ocean (EUMETSAT), Himawari (JMA) — as listed in each file.',
  '• Cadence: one mosaic per hour per channel, published about 35–45 minutes after its nominal hour; its scans start up to ~20 minutes before that hour. The label shows the nominal time and the range of scan start times named in the file.',
  `• Coverage: NOAA states 60°S–60°N. The grid reaches ±72.7°; pixels beyond 60° are drawn only where the file flags them good and are seen at very low angles. Polar regions are not covered. Visible has data in daylight only.`,
  '• Resolution: ~0.072° (about 8 km at the equator) Mercator grid, averaged 2×2 by default (1×1 in the best performance mode, 3×3 in the fastest), good pixels only. Its 4999 columns are spread over exactly 360° (positions move by at most 0.014°) so that there is no seam at the antimeridian.',
  '• Values: NOAA scaled 0–255 image values (not calibrated temperatures or reflectances), drawn in grey; the probe shows them as such.',
  `• Loop: up to ${GMGSI_MAX_FRAMES} hourly frames of the loop window; a frame stays shown one hour (the newest until its successor is published).`,
].join('\n');

export function worldSection(c: SectionCtx): Section {
  const radar = new WorldRadarLayer(c.r);
  const sat = new WorldSatelliteLayer(c.r);
  const radarOn = () => settings.bool('ext.layerState.WorldRadarOn') && termsAccepted();
  const setRadar = (app: App, on: boolean) => {
    if (on && !termsAccepted()) { openTerms(app); return; }
    settings.set('ext.layerState.WorldRadarOn', on);
  };
  const openTerms = (app: App) => openDialog('TFrmWorldRadarTerms', app.bindings.TFrmWorldRadarTerms ?? {}, { extra: (body) => {
    const memo = body.querySelector<HTMLTextAreaElement>('textarea');
    if (memo) { memo.style.whiteSpace = 'pre-wrap'; memo.style.font = '12px/1.4 var(--font)'; }
    links(body, [[RV_API_DOCS, 'RainViewer Weather Maps API'], [RV_FAQ, 'API transition summary'], [RV_TERMS, 'RainViewer Terms and Conditions'], [RV_SITE, 'rainviewer.com']]);
  } });
  const radarStatus = () => {
    if (settings.bool('ext.layerState.WorldRadarOn') && !termsAccepted()) return 'Off until the RainViewer terms are accepted (Terms / source…).';
    return radar.enabled() ? radar.status.text || 'Starting…' : 'Off. Opt-in: RainViewer global radar, past 2 h.';
  };
  const satStatus = () => (sat.enabled() ? [sat.status.text || 'Starting…', sat.mapLabel()].filter(Boolean).join('\n') : 'Off. NOAA GMGSI hourly mosaic, 60°S–60°N.');
  return {
    tab: 'World', frame: 'TWorldLayersFrame', layers: [radar, sat],
    watch: ['ext.layerState.WorldRadar', 'ext.layerState.WorldSatellite', 'ext.config.worldRadarTermsAccepted'],
    bindings: (app) => {
      radar.onTiles = () => app.poke();
      return {
        TWorldLayersFrame: {
          'TWorldLayersFrame.rdOn': custom(radarOn, (v: boolean) => setRadar(app, v)),
          'TWorldLayersFrame.rdAlpha': { kind: 'num', id: 'ext.layerState.WorldRadarAlpha' },
          'TWorldLayersFrame.rdSmooth': bool('ext.layerState.WorldRadarSmooth'),
          'TWorldLayersFrame.rdCoverage': bool('ext.layerState.WorldRadarCoverage'),
          'TWorldLayersFrame.rdLegend': bool('ext.layerState.WorldRadarLegend'),
          'TWorldLayersFrame.rdTerms': act(() => openTerms(app)),
          'TWorldLayersFrame.rdStatus': status(radarStatus),
          'TWorldLayersFrame.stOn': bool('ext.layerState.WorldSatelliteOn'),
          'TWorldLayersFrame.stProduct': combo('ext.layerState.WorldSatelliteProduct'),
          'TWorldLayersFrame.stInfo': act(() => app.showText('Worldwide satellite — NOAA GMGSI', `${SATELLITE_INFO}\n\nSource: ${GMGSI_INFO}\nData: ${GMGSI_REGISTRY} (${GMGSI_BUCKET})`)),
          'TWorldLayersFrame.stAlpha': { kind: 'num', id: 'ext.layerState.WorldSatelliteAlpha' },
          'TWorldLayersFrame.stStatus': status(satStatus),
        },
        TFrmWorldRadarTerms: {
          'TFrmWorldRadarTerms.mmTerms': status(() => RADAR_TERMS),
          'TFrmWorldRadarTerms.btnAccept': act(() => { settings.set('ext.config.worldRadarTermsAccepted', true); settings.set('ext.layerState.WorldRadarOn', true); closeDialog('TFrmWorldRadarTerms'); }),
          'TFrmWorldRadarTerms.btnDecline': act(() => closeDialog('TFrmWorldRadarTerms')),
          'TFrmWorldRadarTerms.btnRevoke': act(() => { settings.set('ext.config.worldRadarTermsAccepted', false); settings.set('ext.layerState.WorldRadarOn', false); closeDialog('TFrmWorldRadarTerms'); }, undefined, undefined, () => !termsAccepted()),
        },
      };
    },
    decorate: (frame) => {
      // Source links under each group (the on-map credits link to the same sites while a layer is shown).
      const place = (group: string, items: [string, string][]) => {
        const g = frame.querySelector<HTMLElement>(`[data-id="ui.TWorldLayersFrame.${group}"]`);
        if (!g) return;
        const box = document.createElement('div');
        box.className = 'world-links';
        box.style.cssText = 'position:absolute;right:8px;top:48px;font-size:11px;display:flex;gap:8px';
        links(box, items);
        g.appendChild(box);
      };
      place('gbSat', [[GMGSI_INFO, 'NOAA GMGSI'], [GMGSI_REGISTRY, 'AWS Open Data']]);
    },
  };
}

/** Appends links that open in a new tab. */
function links(parent: HTMLElement, items: [string, string][]) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:6px';
  for (const [href, text] of items) {
    const a = document.createElement('a');
    a.href = href; a.textContent = text; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.style.color = '#8cf';
    row.appendChild(a);
  }
  parent.appendChild(row);
}
