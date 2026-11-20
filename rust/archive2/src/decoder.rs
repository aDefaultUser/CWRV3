// Archive II decoding (ROC ICD 2620010 file format; ICD 2620002 message 31 / message 5 layouts; message 1 as read
// by Py-ART and MetPy). Every value matches the TypeScript reference (src/decode/archive2.ts) bit for bit; where the
// reference would throw on a truncated message (a RangeError from its DataView), this decoder skips the truncated
// radial or block instead, and it skips moment blocks whose word size is not 8 or 16 bits or differs from the
// sweep's first block of that moment.
use crate::DecodeError;
use crate::be::Be;
use crate::bunzip::bunzip;
use std::collections::BTreeMap;

pub const MOMENT_NAMES: [&[u8]; 7] = [b"REF", b"VEL", b"SW", b"ZDR", b"PHI", b"RHO", b"CFP"];

/// Decompressed size of one bzip2 record (real records are about 2 MB).
pub const MAX_RECORD_BYTES: usize = 64 << 20;
/// Decompressed size of a whole-file bzip2 volume (tgftp .bz2 names).
pub const MAX_FILE_BYTES: usize = 512 << 20;
/// Radials of one sweep (a super-resolution sweep has 720).
pub const MAX_RADIALS: usize = 8192;
/// Moment data of one decoder (a full super-resolution volume is about 100 MB).
pub const MAX_DECODED_BYTES: usize = 768 << 20;

/// Cuts (angle/waveform) of the VCPs flown before message 5 was archived, as the message 5 records of 2007–08
/// volumes give them.
const LEGACY_VCPS: [(u16, &str); 5] = [
    (
        11,
        "0.4834/1 0.4834/2 1.4502/1 1.4502/2 2.4170/4 3.3838/4 4.3066/4 5.3174/4 6.1963/4 7.5146/3 8.7012/3 10.0195/3 11.9971/3 14.0186/3 16.6992/3 19.5117/3",
    ),
    (
        12,
        "0.4834/1 0.4834/2 0.8789/1 0.8789/2 1.3184/1 1.3184/2 1.8018/4 2.4170/4 3.1201/4 3.9990/4 5.0977/4 6.4160/4 7.9980/3 10.0195/3 12.4805/3 15.6006/3 19.5117/3",
    ),
    (21, "0.4834/1 0.4834/2 1.4502/1 1.4502/2 2.4170/4 3.3838/4 4.3066/4 6.0205/4 9.8877/3 14.5898/3 19.5117/3"),
    (32, "0.4834/1 0.4834/2 1.4941/1 1.4941/2 2.5049/4 3.5156/4 4.4824/4"),
    (
        121,
        "0.4834/1 0.4834/2 0.4834/2 0.4834/2 1.4502/1 1.4502/2 1.4502/2 1.4502/2 2.4170/4 2.4170/3 2.4170/3 3.3838/4 3.3838/3 3.3838/3 4.3066/4 4.3066/3 6.0205/4 9.8877/3 14.5898/3 19.5117/3",
    ),
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VcpCut {
    pub elevation: f64,
    pub waveform: u8,
    pub super_res: u8,
    pub sails: bool,
    pub sails_seq: u8,
    pub mrle: bool,
    pub mrle_seq: u8,
    pub mpda: bool,
    pub base_tilt: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Vcp {
    pub pattern: u16,
    pub sails: bool,
    pub sails_cuts: u8,
    pub mrle: bool,
    pub mrle_cuts: u8,
    pub mpda: bool,
    pub base_tilt: bool,
    pub base_tilts: u8,
    pub cuts: Vec<VcpCut>,
}

#[derive(Debug)]
pub enum Raw {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

#[derive(Debug)]
pub struct Moment {
    /// Index in `MOMENT_NAMES`.
    pub name: usize,
    /// Row stride: the most gates of any radial so far.
    pub gates: usize,
    /// Rows held in `raw` (radial-major, `rows × gates` codes; radials without the moment are zeros).
    pub rows: usize,
    pub first_m: i32,
    pub spacing_m: i32,
    pub scale: f64,
    pub offset: f64,
    pub raw: Raw,
}

impl Moment {
    pub fn word(&self) -> u8 {
        match self.raw {
            Raw::U8(_) => 8,
            Raw::U16(_) => 16,
        }
    }
}

#[derive(Debug)]
pub struct Sweep {
    pub azimuths: Vec<f32>,
    pub elevations: Vec<f32>,
    pub times_ms: Vec<f64>,
    pub az_spacing: f64,
    pub nyquist: Option<f64>,
    pub unamb_km: Option<f64>,
    /// In order of first appearance.
    pub moments: Vec<Moment>,
    pub complete: bool,
    /// Azimuth turned since the first radial (message 1 sweeps, which overrun one revolution).
    turned: f64,
    /// Changes whenever the reference would rebuild the sweep: a radial arrives, or the VCP that gives its cut.
    pub version: u32,
}

impl Sweep {
    fn new(az_spacing: f64) -> Self {
        Sweep {
            azimuths: Vec::new(),
            elevations: Vec::new(),
            times_ms: Vec::new(),
            az_spacing,
            nyquist: None,
            unamb_km: None,
            moments: Vec::new(),
            complete: false,
            turned: 0.0,
            version: 0,
        }
    }

    /// Mean measured elevation, summed in radial order like the reference.
    pub fn mean_elevation(&self) -> f64 {
        let sum = self.elevations.iter().fold(0.0, |s, &e| s + f64::from(e));
        sum / self.elevations.len().max(1) as f64
    }

    fn has(&self, name: usize) -> bool {
        self.moments.iter().any(|m| m.name == name)
    }

    /// As waveforms: 1 surveillance only, 2 Doppler only (halves of a split cut), 3 both.
    fn kind(&self) -> u8 {
        match (self.has(1), self.has(0)) {
            (true, true) => 3,
            (true, false) => 2,
            _ => 1,
        }
    }
}

#[derive(Default)]
pub struct Decoder {
    /// Latin-1 bytes.
    pub site: Vec<u8>,
    pub volume_time_ms: Option<f64>,
    pub lat: Option<f32>,
    pub lon: Option<f32>,
    pub height_m: Option<i32>,
    pub vcp_number: Option<u16>,
    pub vcp: Option<Vcp>,
    /// Message 1 radials seen: the volume has no site metadata and may have no VCP record.
    pub legacy: bool,
    pub sweeps: BTreeMap<u8, Sweep>,
    /// Bytes of moment data held (bounded by `MAX_DECODED_BYTES`).
    pub decoded_bytes: usize,
    failed: bool,
    scratch: Vec<u8>,
}

fn date_ms(mjd: u32, ms: u32) -> f64 {
    (mjd as f64 - 1.0) * 86_400_000.0 + ms as f64
}

/// `String.prototype.trim` over Latin-1 bytes.
fn js_trim(mut s: &[u8]) -> &[u8] {
    let ws = |b: &u8| matches!(b, 0x09..=0x0d | 0x20 | 0xa0);
    while let Some((first, rest)) = s.split_first() {
        if !ws(first) {
            break;
        }
        s = rest;
    }
    while let Some((last, rest)) = s.split_last() {
        if !ws(last) {
            break;
        }
        s = rest;
    }
    s
}

/// `Math.round`: halves round towards +∞.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

fn charge(used: &mut usize, bytes: usize) -> Result<(), DecodeError> {
    *used = used.checked_add(bytes).filter(|&n| n <= MAX_DECODED_BYTES).ok_or(DecodeError::TooLarge)?;
    Ok(())
}

/// Makes room for `len` values, reserving `hint` on first use (a sweep's expected size, so rows are not
/// over-allocated by doubling). Moment memory is charged by capacity.
fn reserve<T>(buf: &mut Vec<T>, len: usize, hint: usize, used: &mut usize) -> Result<(), DecodeError> {
    let cap = buf.capacity();
    if len <= cap {
        return Ok(());
    }
    let mut want = if cap == 0 { len.max(hint) } else { len.max(cap + cap / 2) };
    if charge(used, (want - cap) * size_of::<T>()).is_err() {
        want = len;
        charge(used, (want - cap) * size_of::<T>())?;
    }
    buf.try_reserve_exact(want - buf.len()).map_err(|_| DecodeError::OutOfMemory)
}

/// Grows a radial-major buffer of `rows × stride` codes to `rows × gates` (wider rows, zero padded).
fn widen<T: Copy + Default>(
    buf: &mut Vec<T>,
    stride: usize,
    rows: usize,
    gates: usize,
    hint_rows: usize,
    used: &mut usize,
) -> Result<(), DecodeError> {
    let len = rows.checked_mul(gates).ok_or(DecodeError::TooLarge)?;
    let mut wide = Vec::new();
    reserve(&mut wide, len, hint_rows.saturating_mul(gates), used)?;
    for row in buf.chunks_exact(stride.max(1)).take(rows) {
        wide.extend_from_slice(row);
        wide.resize(wide.len() + gates - row.len(), T::default());
    }
    wide.resize(len, T::default());
    *used = used.saturating_sub(buf.capacity() * size_of::<T>());
    *buf = wide;
    Ok(())
}

/// Sets radial `r` of a radial-major buffer to `len` codes written by `fill` (the rest of the row zero), adding zero
/// rows for radials without data and widening the rows when this one is longer. `hint_rows`: the radials a sweep
/// of its azimuth spacing has.
#[allow(clippy::too_many_arguments)]
fn put_row<T: Copy + Default>(
    buf: &mut Vec<T>,
    stride: &mut usize,
    rows: &mut usize,
    r: usize,
    len: usize,
    hint_rows: usize,
    used: &mut usize,
    fill: impl FnOnce(&mut [T]),
) -> Result<(), DecodeError> {
    if len > *stride {
        widen(buf, *stride, *rows, len, hint_rows, used)?;
        *stride = len;
    }
    if r >= *rows {
        let total = (r + 1).checked_mul(*stride).ok_or(DecodeError::TooLarge)?;
        reserve(buf, total, hint_rows.saturating_mul(*stride), used)?;
        buf.resize(total, T::default());
        *rows = r + 1;
    }
    let row = buf.get_mut(r * *stride..(r + 1) * *stride).ok_or(DecodeError::TooLarge)?;
    row.fill(T::default());
    fill(row.get_mut(..len).ok_or(DecodeError::TooLarge)?);
    Ok(())
}

/// The moment of a sweep by name, created with `make` when the sweep has none yet.
fn moment_mut(moments: &mut Vec<Moment>, name: usize, make: impl FnOnce() -> Moment) -> Option<&mut Moment> {
    let at = match moments.iter().position(|m| m.name == name) {
        Some(at) => at,
        None => {
            moments.push(make());
            moments.len() - 1
        }
    };
    moments.get_mut(at)
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn failed(&self) -> bool {
        self.failed
    }

    /// Feeds a whole Archive II file (optionally whole-file bzip2) or a real-time chunk (S chunks carry the 24-byte
    /// volume header). A refused feed leaves the decoder failed: discard it.
    pub fn feed(&mut self, buf: &[u8]) -> Result<(), DecodeError> {
        if self.failed {
            return Err(DecodeError::Failed);
        }
        let r = if buf.starts_with(b"BZh") {
            let mut plain = Vec::new();
            bunzip(buf, MAX_FILE_BYTES, &mut plain).and_then(|()| self.feed_records(&plain))
        } else {
            self.feed_records(buf)
        };
        if r.is_err() {
            self.failed = true;
        }
        r
    }

    fn feed_records(&mut self, buf: &[u8]) -> Result<(), DecodeError> {
        let be = Be(buf);
        let mut p = 0;
        if buf.len() >= 24 && (buf.starts_with(b"AR2V") || buf.starts_with(b"ARCHIVE2")) {
            if let (Some(mjd), Some(ms)) = (be.u32(12), be.u32(16)) {
                self.volume_time_ms = Some(date_ms(mjd, ms));
            }
            self.site = be
                .bytes(20, 4)
                .unwrap_or_default()
                .iter()
                .copied()
                .filter(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                .collect();
            p = 24;
        }
        // Archive volumes before mid-2016 have no compressed records: the messages follow the volume header directly
        // (a zero where the first record length would be).
        if p == 24 && buf.len() > 28 && be.i32(24) == Some(0) {
            return self.parse_messages(buf.get(24..).unwrap_or_default());
        }
        let mut scratch = std::mem::take(&mut self.scratch);
        while let Some(size) = be.i32(p) {
            p += 4;
            let size = size.unsigned_abs() as usize;
            let end = match p.checked_add(size) {
                Some(end) if size > 0 && end <= buf.len() => end,
                _ => break,
            };
            let rec = buf.get(p..end).unwrap_or_default();
            p = end;
            if rec.starts_with(b"BZh") {
                bunzip(rec, MAX_RECORD_BYTES, &mut scratch)?;
                self.parse_messages(&scratch)?;
            } else {
                self.parse_messages(rec)?;
            }
        }
        scratch.clear();
        self.scratch = scratch;
        Ok(())
    }

    fn parse_messages(&mut self, d: &[u8]) -> Result<(), DecodeError> {
        let be = Be(d);
        let mut p = 0usize;
        while p + 28 <= d.len() {
            let size_hw = usize::from(be.u16(p + 12).unwrap_or(0));
            let kind = be.u8(p + 15).unwrap_or(0);
            if kind == 31 && size_hw > 8 {
                let Some(msg) = be.bytes(p + 28, size_hw * 2 - 16) else { break };
                self.msg31(Be(msg))?;
                p += 12 + size_hw * 2;
                continue;
            }
            let rest = d.len() - p - 28;
            if kind == 1 && size_hw > 50 && rest >= 100 {
                self.msg1(Be(be.bytes(p + 28, (size_hw * 2 - 16).min(2404).min(rest)).unwrap_or_default()))?;
            }
            if kind == 5 && size_hw > 0 && rest >= 22 {
                self.msg5(Be(be.bytes(p + 28, rest.min(2404)).unwrap_or_default()));
            }
            p += 2432;
        }
        Ok(())
    }

    fn msg5(&mut self, v: Be) {
        if self.vcp.is_some() {
            return; // the metadata record carries the volume's VCP; keep the first valid one
        }
        let angle = |raw: u16| f64::from(raw & 0xfff8) * 180.0 / 32768.0;
        let (Some(kind), Some(pattern), Some(n_cuts), Some(supp)) = (v.u16(2), v.u16(4), v.u16(6), v.u16(18)) else {
            return;
        };
        if !(1..=32).contains(&n_cuts) || !(1..=999).contains(&pattern) || kind > 7 {
            return;
        }
        let mut cuts = Vec::new();
        for i in 0..usize::from(n_cuts) {
            let o = 22 + i * 46;
            if o + 46 > v.len() {
                break;
            }
            let (Some(el), Some(waveform), Some(super_res), Some(s)) =
                (v.u16(o), v.u8(o + 3), v.u8(o + 4), v.u16(o + 28))
            else {
                break;
            };
            cuts.push(VcpCut {
                elevation: angle(el),
                waveform,
                super_res,
                sails: s & 1 != 0,
                sails_seq: ((s >> 1) & 7) as u8,
                mrle: s & 16 != 0,
                mrle_seq: ((s >> 5) & 7) as u8,
                mpda: s & 0x200 != 0,
                base_tilt: s & 0x400 != 0,
            });
        }
        if cuts.len() != usize::from(n_cuts) || cuts.iter().any(|c| c.elevation < -1.0 || c.elevation > 45.0) {
            return;
        }
        self.vcp = Some(Vcp {
            pattern,
            sails: supp & 1 != 0,
            sails_cuts: ((supp >> 1) & 7) as u8,
            mrle: supp & 16 != 0,
            mrle_cuts: ((supp >> 5) & 7) as u8,
            mpda: supp & 0x800 != 0,
            base_tilt: supp & 0x1000 != 0,
            base_tilts: ((supp >> 13) & 7) as u8,
            cuts,
        });
        for s in self.sweeps.values_mut() {
            s.version = s.version.wrapping_add(1); // cut and nominal elevation come from the VCP
        }
    }

    /// Message 1 ("digital radar data"): one 1° radial with reflectivity (1 km gates) and/or velocity and spectrum
    /// width (250 m gates) at 0.5 dB / 0.5 or 1 m/s steps; split cuts are a reflectivity-only and a Doppler-only
    /// elevation. The caller guarantees at least 100 bytes.
    fn msg1(&mut self, v: Be) -> Result<(), DecodeError> {
        let u16 = |o: usize| v.u16(o).unwrap_or(0);
        let i16 = |o: usize| v.i16(o).unwrap_or(0);
        let angle = |o: usize| f64::from(u16(o)) * 180.0 / 32768.0;
        let (az, el, el_num, status) = (angle(8), ((angle(14) + 180.0) % 360.0) - 180.0, u16(16), u16(12) & 0xf);
        if !(-10.0..=90.0).contains(&el) || az >= 360.0 || !(1..=32).contains(&el_num) {
            return Ok(());
        }
        self.legacy = true;
        let vcp = u16(44);
        if self.vcp_number.is_none() && (1..=999).contains(&vcp) {
            self.vcp_number = Some(vcp);
        }
        let acc = self.sweeps.entry(el_num as u8).or_insert_with(|| Sweep::new(1.0));
        acc.version = acc.version.wrapping_add(1);
        // A turn of radials at the sweep's spacing, plus the few a sweep may overrun by.
        let hint_rows = (360.0 / acc.az_spacing) as usize + 8;
        if status == 2 || status == 4 {
            acc.complete = true;
        }
        // Legacy sweeps run a few radials past one revolution; the overlap repeats the first azimuths and is
        // dropped, so a sweep is one turn like a message 31 sweep.
        let n = acc.azimuths.len();
        if let Some(&last) = acc.azimuths.last() {
            let step = (((az - f64::from(last)) % 360.0) + 540.0) % 360.0 - 180.0;
            if acc.turned + step >= 359.5 {
                return Ok(());
            }
            acc.turned += step;
        }
        if n >= MAX_RADIALS {
            return Err(DecodeError::TooLarge);
        }
        acc.azimuths.push(az as f32);
        acc.elevations.push(el as f32);
        acc.times_ms.push(date_ms(u32::from(u16(4)), v.u32(0).unwrap_or(0)));
        let doppler = u16(28) > 0;
        if doppler {
            let nyq = f64::from(i16(60)) / 100.0;
            if nyq > 0.0 {
                acc.nyquist = Some(nyq);
            }
        }
        if u16(6) != 0 {
            acc.unamb_km = Some(f64::from(i16(6)) / 10.0);
        }
        let used = &mut self.decoded_bytes;
        let mut add = |name: usize,
                       ptr: u16,
                       gates: u16,
                       first: i16,
                       spacing: u16,
                       scale: f64,
                       offset: f64|
         -> Result<(), DecodeError> {
            let (ptr, gates, first, spacing) =
                (usize::from(ptr), usize::from(gates), i32::from(first), i32::from(spacing));
            if ptr == 0 || spacing == 0 {
                return Ok(());
            }
            // Legacy RDA Doppler ranges start before the antenna (first gate at -375 m): gates centred behind it are
            // skipped.
            let skip = (if first < 0 { (-first + spacing - 1) / spacing } else { 0 }) as usize;
            if gates <= skip || ptr + gates > v.len() {
                return Ok(());
            }
            let Some(row) = v.bytes(ptr + skip, gates - skip) else { return Ok(()) };
            let make = || Moment {
                name,
                gates: 0,
                rows: 0,
                first_m: first + skip as i32 * spacing,
                spacing_m: spacing,
                scale,
                offset,
                raw: Raw::U8(Vec::new()),
            };
            let Some(Moment { raw: Raw::U8(buf), gates: stride, rows, .. }) = moment_mut(&mut acc.moments, name, make)
            else {
                return Ok(());
            };
            put_row(buf, stride, rows, n, row.len(), hint_rows, used, |dst| {
                dst.iter_mut().zip(row).for_each(|(d, s)| *d = *s)
            })
        };
        add(0, u16(36), u16(26), i16(18), u16(22), 2.0, 66.0)?;
        if doppler {
            let (first, spacing) = (i16(20), u16(24));
            add(1, u16(38), u16(28), first, spacing, if u16(42) == 4 { 1.0 } else { 2.0 }, 129.0)?;
            add(2, u16(40), u16(28), first, spacing, 2.0, 129.0)?;
        }
        Ok(())
    }

    fn msg31(&mut self, v: Be) -> Result<(), DecodeError> {
        let (
            Some(site),
            Some(mjd),
            Some(ms),
            Some(az),
            Some(spacing_code),
            Some(status),
            Some(el_num),
            Some(el),
            Some(n_blocks),
        ) = (v.bytes(0, 4), v.u16(8), v.u32(4), v.f32(12), v.u8(20), v.u8(21), v.u8(22), v.f32(24), v.u16(30))
        else {
            return Ok(()); // a truncated radial header
        };
        if self.site.is_empty() {
            self.site = js_trim(site).to_vec();
        }
        // A corrupt radial header (seen in real-time chunk streams) must not create a bogus tilt.
        if !(-10.0..=90.0).contains(&el) || !(0.0..=360.0).contains(&az) || !(1..=32).contains(&el_num) {
            return Ok(());
        }
        let acc = self.sweeps.entry(el_num).or_insert_with(|| Sweep::new(if spacing_code == 1 { 0.5 } else { 1.0 }));
        acc.version = acc.version.wrapping_add(1);
        // A turn of radials at the sweep's spacing, plus the few a sweep may overrun by.
        let hint_rows = (360.0 / acc.az_spacing) as usize + 8;
        let r = acc.azimuths.len();
        if r >= MAX_RADIALS {
            return Err(DecodeError::TooLarge);
        }
        acc.azimuths.push(az);
        acc.elevations.push(el);
        acc.times_ms.push(date_ms(u32::from(mjd), ms));
        if status == 2 || status == 4 {
            acc.complete = true;
        }
        for b in 0..usize::from(n_blocks.min(10)) {
            let Some(ptr) = v.u32(32 + b * 4) else { break };
            let ptr = ptr as usize;
            let Some(head) = v.bytes(ptr, 4).filter(|_| ptr != 0) else { continue };
            let (kind, name) = (head.first().copied(), js_trim(head.get(1..).unwrap_or_default()));
            if kind == Some(b'R') {
                if name == b"VOL" {
                    if let (Some(lat), Some(lon), Some(h), Some(feed), Some(vcp)) =
                        (v.f32(ptr + 8), v.f32(ptr + 12), v.i16(ptr + 16), v.u16(ptr + 18), v.u16(ptr + 40))
                    {
                        (self.lat, self.lon, self.height_m, self.vcp_number) =
                            (Some(lat), Some(lon), Some(i32::from(h) + i32::from(feed)), Some(vcp));
                    }
                } else if name == b"RAD" {
                    if let (Some(unamb), Some(nyq)) = (v.i16(ptr + 6), v.i16(ptr + 16)) {
                        acc.unamb_km = Some(f64::from(unamb) / 10.0);
                        acc.nyquist = Some(f64::from(nyq) / 100.0);
                    }
                }
                continue;
            }
            let Some(name) = MOMENT_NAMES.iter().position(|n| *n == name).filter(|_| kind == Some(b'D')) else {
                continue;
            };
            let (Some(gates), Some(word), Some(first), Some(spacing), Some(scale), Some(offset)) =
                (v.u16(ptr + 8), v.u8(ptr + 19), v.i16(ptr + 10), v.i16(ptr + 12), v.f32(ptr + 20), v.f32(ptr + 24))
            else {
                continue;
            };
            let gates = usize::from(gates);
            let width = match word {
                8 => 1,
                16 => 2,
                _ => continue,
            };
            let Some(data) = v.bytes(ptr + 28, gates * width) else { continue };
            let Some(m) = moment_mut(&mut acc.moments, name, || Moment {
                name,
                gates,
                rows: 0,
                first_m: i32::from(first),
                spacing_m: i32::from(spacing),
                scale: f64::from(scale),
                offset: f64::from(offset),
                raw: if word == 16 { Raw::U16(Vec::new()) } else { Raw::U8(Vec::new()) },
            }) else {
                continue;
            };
            let used = &mut self.decoded_bytes;
            match &mut m.raw {
                Raw::U8(buf) if word == 8 => {
                    put_row(buf, &mut m.gates, &mut m.rows, r, gates, hint_rows, used, |dst| {
                        dst.iter_mut().zip(data).for_each(|(d, s)| *d = *s)
                    })?
                }
                Raw::U16(buf) if word == 16 => {
                    put_row(buf, &mut m.gates, &mut m.rows, r, gates, hint_rows, used, |dst| {
                        for (d, s) in dst.iter_mut().zip(data.chunks_exact(2)) {
                            if let &[hi, lo] = s {
                                *d = u16::from_be_bytes([hi, lo]);
                            }
                        }
                    })?
                }
                _ => {} // a word size other than the sweep's first block of this moment
            }
        }
        Ok(())
    }

    /// Pads every moment of a sweep to one row per radial (radials after the moment's last are zeros), so its
    /// buffers are the `radials × gates` arrays of the built sweep.
    pub fn finish_sweep(&mut self, el_num: u8) -> Result<Option<&Sweep>, DecodeError> {
        let Some(s) = self.sweeps.get_mut(&el_num) else { return Ok(None) };
        let radials = s.azimuths.len();
        for m in &mut s.moments {
            if m.rows >= radials {
                continue;
            }
            let len = radials.checked_mul(m.gates).ok_or(DecodeError::TooLarge)?;
            let used = &mut self.decoded_bytes;
            match &mut m.raw {
                Raw::U8(b) => {
                    reserve(b, len, 0, used)?;
                    b.resize(len, 0);
                }
                Raw::U16(b) => {
                    reserve(b, len, 0, used)?;
                    b.resize(len, 0);
                }
            }
            m.rows = radials;
        }
        Ok(self.sweeps.get(&el_num))
    }

    /// The cut of a message 1 sweep when the volume has no VCP record (archived only from about 2005): the cut of
    /// the VCP's definition when the sweep's angle and moments agree with it, otherwise inferred from the moments (a
    /// reflectivity-only sweep is the surveillance half of a split cut, a Doppler-only sweep right after one its
    /// Doppler half at the same angle, anything else a batch cut at its most frequent measured angle). `None` unless
    /// the volume is a message 1 volume without a VCP. Returns (elevation, waveform).
    pub fn legacy_cut(&self, el_num: u8) -> Option<(f64, u8)> {
        if !self.legacy || self.vcp.is_some() {
            return None;
        }
        let a = self.sweeps.get(&el_num)?;
        let def = LEGACY_VCPS.iter().find(|(n, _)| Some(*n) == self.vcp_number).and_then(|(_, cuts)| {
            let cut = cuts.split(' ').nth(usize::from(el_num).checked_sub(1)?)?;
            let (angle, waveform) = cut.split_once('/')?;
            Some((angle.parse::<f64>().ok()?, waveform.parse::<u8>().ok()?))
        });
        if let Some((angle, waveform)) = def {
            if (most_frequent(&a.elevations) - angle).abs() < 0.25 && a.kind() == waveform.min(3) {
                return Some((angle, waveform));
            }
        }
        let prev = el_num.checked_sub(1).and_then(|n| self.sweeps.get(&n));
        let pair = prev.filter(|p| {
            a.kind() == 2 && p.kind() == 1 && (most_frequent(&a.elevations) - most_frequent(&p.elevations)).abs() < 0.5
        });
        let angle = most_frequent(&pair.unwrap_or(a).elevations);
        Some((
            js_round(angle * 100.0) / 100.0,
            if pair.is_some() {
                2
            } else if a.kind() == 1 {
                1
            } else {
                4
            },
        ))
    }
}

/// The most frequent value (the first seen of equally frequent ones), 0 for none.
fn most_frequent(values: &[f32]) -> f64 {
    // Sorted by value (−0 counted with +0) then position, so each run is one value in order of appearance.
    let mut order: Vec<(f32, usize)> = values.iter().enumerate().map(|(i, &v)| (v + 0.0, i)).collect();
    order.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut best: Option<(usize, usize)> = None; // (count, first position)
    for run in order.chunk_by(|a, b| a.0 == b.0) {
        let first = run.first().map_or(0, |r| r.1);
        if best.is_none_or(|(count, at)| run.len() > count || (run.len() == count && first < at)) {
            best = Some((run.len(), first));
        }
    }
    // A Map key of −0 is +0.
    best.and_then(|(_, at)| values.get(at)).map_or(0.0, |&v| f64::from(v + 0.0))
}
