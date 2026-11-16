// Prebuilds public GIS data into compact static assets (public/gis/*) and the radar-site table
// (src/generated/radar-sites.ts). Sources are public domain: Natural Earth (naciscdn.org), US Census
// cartographic boundaries and TIGER/Line 2021 primary roads (www2.census.gov), NCEI HOMR NEXRAD/TDWR list.
// Downloads are cached in .cache/gis/. Usage: npm run gis
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzip } from '../src/decode/zip';
import { readShp, readDbf, simplify, type DbfRecord, type Shape } from '../src/decode/shapefile';
import { encodeLineSet, type LineFeature } from '../src/gis/lineset';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache/gis');
const outDir = join(root, 'public/gis');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const manifest: { id: string; url: string; sha256: string; bytes: number }[] = [];

async function download(url: string): Promise<Uint8Array> {
  const file = join(cacheDir, url.split('/').pop()!);
  if (!existsSync(file)) {
    process.stdout.write(`fetch ${url} … `);
    const r = await fetch(url, { headers: { 'User-Agent': 'cwrv3-gis-prebuild' } });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
    console.log('ok');
  }
  const b = new Uint8Array(readFileSync(file));
  manifest.push({ id: url.split('/').pop()!, url, sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length });
  return b;
}

async function shapes(url: string): Promise<{ shp: Shape[]; dbf: DbfRecord[] }> {
  const files = await unzip(await download(url), (n) => /\.(shp|dbf)$/i.test(n));
  const shpName = [...files.keys()].find((n) => n.toLowerCase().endsWith('.shp'))!;
  const dbfName = [...files.keys()].find((n) => n.toLowerCase().endsWith('.dbf'))!;
  return { shp: readShp(files.get(shpName)!), dbf: readDbf(files.get(dbfName)!) };
}

function lines(src: { shp: Shape[]; dbf: DbfRecord[] }, tol: number, classify: (r: DbfRecord) => number | null, extra?: (r: DbfRecord) => number): LineFeature[] {
  const out: LineFeature[] = [];
  src.shp.forEach((s, i) => {
    const cls = classify(src.dbf[i]);
    if (cls === null) return;
    for (const part of s.parts) {
      const simp = simplify(part, tol);
      if (simp.length >= 4) out.push({ cls, value: extra ? extra(src.dbf[i]) : 0, coords: simp });
    }
  });
  return out;
}

function save(name: string, feats: LineFeature[]) {
  const bin = encodeLineSet(feats);
  writeFileSync(join(outDir, name), bin);
  console.log(`  ${name}: ${feats.length} parts, ${(bin.length / 1e6).toFixed(2)} MB`);
}

const NE = 'https://naciscdn.org/naturalearth/10m';
const CB = 'https://www2.census.gov/geo/tiger/GENZ2023/shp';

async function main() {
  // Coastline, lakes, rivers, country and state/province boundaries.
  save('coast.bin', lines(await shapes(`${NE}/physical/ne_10m_coastline.zip`), 0.01, () => 0));
  save('lakes.bin', lines(await shapes(`${NE}/physical/ne_10m_lakes.zip`), 0.01, (r) => (Number(r.scalerank) <= 6 ? 0 : null)));
  save('rivers.bin', lines(await shapes(`${NE}/physical/ne_10m_rivers_lake_centerlines.zip`), 0.01, (r) => (Number(r.scalerank) <= 6 ? 0 : null)));
  save('countries.bin', lines(await shapes(`${NE}/cultural/ne_10m_admin_0_boundary_lines_land.zip`), 0.01, () => 0));
  save('states.bin', lines(await shapes(`${NE}/cultural/ne_10m_admin_1_states_provinces_lines.zip`), 0.005,
    (r) => (['USA', 'CAN', 'MEX'].includes(String(r.adm0_a3 ?? r.ADM0_A3)) ? 0 : null)));

  // Counties: snapped to a 0.002° grid so neighbours share identical vertices; shared edges are drawn once
  // and county rings are kept by GEOID for watch outlines (union of affected counties).
  const counties = await shapes(`${CB}/cb_2023_us_county_500k.zip`);
  const snap = (v: number) => Math.round(v * 500) / 500;
  const segKey = (a: number, b: number, c: number, d: number) => (a < c || (a === c && b < d) ? `${a},${b},${c},${d}` : `${c},${d},${a},${b}`);
  const seen = new Set<string>();
  const countyLines: LineFeature[] = [];
  const countyRings: LineFeature[] = [];
  const geoids: string[] = [];
  counties.shp.forEach((s, i) => {
    const rec = counties.dbf[i];
    const geoid = String(rec.GEOID);
    for (const part of s.parts) {
      const ring: number[] = [];
      for (let k = 0; k < part.length; k += 2) {
        const x = snap(part[k]), y = snap(part[k + 1]);
        if (ring.length && ring[ring.length - 2] === x && ring[ring.length - 1] === y) continue;
        ring.push(x, y);
      }
      if (ring.length < 6) continue;
      countyRings.push({ cls: 0, value: geoids.length, coords: Float64Array.from(ring) });
      let run: number[] = [];
      for (let k = 0; k + 3 < ring.length; k += 2) {
        const key = segKey(ring[k], ring[k + 1], ring[k + 2], ring[k + 3]);
        if (seen.has(key)) { if (run.length >= 4) countyLines.push({ cls: 0, value: 0, coords: Float64Array.from(run) }); run = []; continue; }
        seen.add(key);
        if (!run.length) run.push(ring[k], ring[k + 1]);
        run.push(ring[k + 2], ring[k + 3]);
      }
      if (run.length >= 4) countyLines.push({ cls: 0, value: 0, coords: Float64Array.from(run) });
    }
    geoids.push(geoid);
  });
  save('counties.bin', countyLines);
  save('county-rings.bin', countyRings);
  const stateAbbr: Record<string, string> = {};
  const states = await shapes(`${CB}/cb_2023_us_state_500k.zip`);
  for (const r of states.dbf) stateAbbr[String(r.STATEFP)] = String(r.STUSPS);
  // UGC county code = state abbreviation + 'C' + county FIPS, e.g. OKC109.
  writeFileSync(join(outDir, 'county-ids.json'), JSON.stringify(geoids.map((g) => `${stateAbbr[g.slice(0, 2)] ?? '??'}C${g.slice(2)}`)));

  // Primary roads (TIGER/Line 2021): class by RTTYP; value = route number for shields.
  const roads = await shapes('https://www2.census.gov/geo/tiger/TIGER2021/PRIMARYROADS/tl_2021_us_primaryroads.zip');
  const ROUTE_CLASS: Record<string, number> = { I: 0, U: 1, S: 2 };
  save('roads-primary.bin', lines(roads, 0.002, (r) => ROUTE_CLASS[String(r.RTTYP)] ?? null, (r) => {
    const m = String(r.FULLNAME).match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }));

  // Cities (Natural Earth populated places).
  const places = await shapes(`${NE}/cultural/ne_10m_populated_places.zip`);
  const cities = places.dbf.map((r, i) => {
    const pt = places.shp[i].parts[0];
    return { n: String(r.NAME), lon: +pt[0].toFixed(4), lat: +pt[1].toFixed(4), pop: Number(r.POP_MAX) || 0, rank: Number(r.SCALERANK), lrank: Number(r.LABELRANK), cap: /capital/i.test(String(r.FEATURECLA)) ? 1 : 0, cc: String(r.ADM0_A3) };
  }).sort((a, b) => b.pop - a.pop);
  writeFileSync(join(outDir, 'cities.json'), JSON.stringify(cities));
  console.log(`  cities.json: ${cities.length}`);

  // Radar sites (NCEI HOMR fixed-width list: NEXRAD and TDWR), alphabetical by ICAO.
  const txtBytes = await download('https://www.ncei.noaa.gov/access/homr/file/nexrad-stations.txt');
  const txt = new TextDecoder().decode(txtBytes).split('\n');
  const head = txt[0];
  const col = (name: string) => head.indexOf(name);
  const cut = (line: string, a: string, b: string | null) => line.slice(col(a), b ? col(b) : undefined).trim();
  const sites = txt.slice(2).filter((l) => l.trim()).map((l) => ({
    id: cut(l, 'ICAO', 'WBAN'), name: cut(l, 'NAME', 'COUNTRY'), st: cut(l, 'ST ', 'COUNTY'),
    lat: Number(cut(l, 'LAT', 'LON')), lon: Number(cut(l, 'LON', 'ELEV')), elevFt: Number(cut(l, 'ELEV', 'UTC')),
    type: /TDWR/.test(cut(l, 'STNTYPE', null)) ? 'TDWR' : 'NEXRAD',
  })).sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(root, 'src/generated/radar-sites.ts'),
    `// GENERATED by tools/fetch-gis.ts from NCEI HOMR nexrad-stations.txt (public domain). Alphabetical by ICAO.\n` +
    `export interface RadarSite { id: string; name: string; st: string; lat: number; lon: number; elevFt: number; type: 'NEXRAD' | 'TDWR' }\n` +
    `export const RADAR_SITES: readonly RadarSite[] = ${JSON.stringify(sites)};\n`);
  console.log(`  radar sites: ${sites.length} (KBOX index ${sites.findIndex((s) => s.id === 'KBOX')})`);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ built: new Date().toISOString(), sources: manifest }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
