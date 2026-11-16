// Great-circle helpers on a spherical Earth (mean radius), used by measurement tools and storm tracks.
const R_KM = 6371.0088;
export function gcDistanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
export function destination(lon: number, lat: number, brgDeg: number, km: number): [number, number] {
  const r = Math.PI / 180, d = km / R_KM, b = brgDeg * r, p1 = lat * r, l1 = lon * r;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [l2 / r, p2 / r];
}
