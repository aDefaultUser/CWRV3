// WebAssembly exports used by src/decode/archive2-wasm.ts. Decoders live in a registry under numeric handles, so a
// stale or forged handle is refused instead of dereferenced. Results are flat f64 descriptors in decoder-owned
// memory, read by JavaScript before its next call; code arrays are copied out once, never boxed per value.
// The JavaScript side opens one decoder per instance, so dropping the instance releases its memory. The only unsafe
// construct here is the `no_mangle` export attribute.
#![allow(unsafe_code)]

use crate::decoder::{Decoder, Raw};
use std::cell::RefCell;
use std::collections::BTreeMap;

/// Input buffers above this are released after their feed (live chunks are much smaller).
const KEEP_INPUT: usize = 4 << 20;

struct Slot {
    decoder: Decoder,
    input: Vec<u8>,
    out: Vec<f64>,
}

#[derive(Default)]
struct Registry {
    next: u32,
    slots: BTreeMap<u32, Slot>,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

fn registry<R>(f: impl FnOnce(&mut Registry) -> R) -> Option<R> {
    REGISTRY.with(|r| r.try_borrow_mut().ok().map(|mut r| f(&mut r)))
}

fn slot<R>(h: u32, f: impl FnOnce(&mut Slot) -> R) -> Option<R> {
    registry(|r| r.slots.get_mut(&h).map(f)).flatten()
}

fn addr<T>(v: &[T]) -> f64 {
    v.as_ptr() as usize as f64
}

/// Writes a descriptor (its first value is its length) and returns its address.
fn publish(out: &mut Vec<f64>, fill: impl FnOnce(&mut Vec<f64>)) -> u32 {
    out.clear();
    out.push(0.0);
    fill(out);
    let len = out.len() as f64;
    if let Some(first) = out.first_mut() {
        *first = len;
    }
    out.as_ptr() as usize as u32
}

/// A new decoder's handle (the JavaScript side opens one decoder per instance).
#[unsafe(no_mangle)]
pub extern "C" fn a2_create() -> u32 {
    registry(|r| {
        r.next = r.next.wrapping_add(1).max(1);
        while r.slots.contains_key(&r.next) {
            r.next = r.next.wrapping_add(1).max(1);
        }
        r.slots.insert(r.next, Slot { decoder: Decoder::new(), input: Vec::new(), out: Vec::new() });
        r.next
    })
    .unwrap_or(0)
}

/// Address of a `len`-byte input buffer for the next feed, 0 when it cannot be allocated.
#[unsafe(no_mangle)]
pub extern "C" fn a2_input(h: u32, len: u32) -> u32 {
    slot(h, |s| {
        s.input.clear();
        let len = len as usize;
        if s.input.try_reserve_exact(len).is_err() {
            return 0;
        }
        s.input.resize(len, 0);
        s.input.as_ptr() as usize as u32
    })
    .unwrap_or(0)
}

/// Feeds the input buffer: 0, or the `DecodeError` code (−1 for an unknown handle).
#[unsafe(no_mangle)]
pub extern "C" fn a2_feed(h: u32) -> i32 {
    slot(h, |s| {
        let r = s.decoder.feed(&s.input);
        s.input.clear();
        if s.input.capacity() > KEEP_INPUT {
            s.input = Vec::new();
        }
        r.err().map_or(0, |e| e as i32)
    })
    .unwrap_or(-1)
}

/// Volume descriptor: [len, time?, time, lat?, lat, lon?, lon, height?, height, vcpNumber?, vcpNumber, legacy,
/// site length, site bytes…, vcp?, (pattern, sails, sailsCuts, mrle, mrleCuts, mpda, baseTilt, baseTilts, cut count,
/// cuts × (elevation, waveform, superRes, sails, sailsSeq, mrle, mrleSeq, mpda, baseTilt)), sweep count,
/// sweeps × (elevation number, version)]. 0 for an unknown or failed decoder.
#[unsafe(no_mangle)]
pub extern "C" fn a2_volume(h: u32) -> u32 {
    slot(h, |s| {
        let d = &s.decoder;
        if d.failed() {
            return 0;
        }
        publish(&mut s.out, |o| {
            let opt = |o: &mut Vec<f64>, v: Option<f64>| o.extend([f64::from(u8::from(v.is_some())), v.unwrap_or(0.0)]);
            opt(o, d.volume_time_ms);
            opt(o, d.lat.map(f64::from));
            opt(o, d.lon.map(f64::from));
            opt(o, d.height_m.map(f64::from));
            opt(o, d.vcp_number.map(f64::from));
            o.push(f64::from(u8::from(d.legacy)));
            o.push(d.site.len() as f64);
            o.extend(d.site.iter().map(|&b| f64::from(b)));
            let flag = |b: bool| f64::from(u8::from(b));
            match &d.vcp {
                None => o.push(0.0),
                Some(v) => {
                    o.extend([
                        1.0,
                        f64::from(v.pattern),
                        flag(v.sails),
                        f64::from(v.sails_cuts),
                        flag(v.mrle),
                        f64::from(v.mrle_cuts),
                    ]);
                    o.extend([flag(v.mpda), flag(v.base_tilt), f64::from(v.base_tilts), v.cuts.len() as f64]);
                    for c in &v.cuts {
                        o.extend([
                            c.elevation,
                            f64::from(c.waveform),
                            f64::from(c.super_res),
                            flag(c.sails),
                            f64::from(c.sails_seq),
                        ]);
                        o.extend([flag(c.mrle), f64::from(c.mrle_seq), flag(c.mpda), flag(c.base_tilt)]);
                    }
                }
            }
            o.push(d.sweeps.len() as f64);
            for (&n, sweep) in &d.sweeps {
                o.extend([f64::from(n), f64::from(sweep.version)]);
            }
        })
    })
    .unwrap_or(0)
}

/// Sweep descriptor: [len, elevation number, mean elevation, legacy cut?, cut elevation, cut waveform, azimuth
/// spacing, nyquist?, nyquist, unambiguous range?, range, radials, complete, azimuths address (f32), elevations
/// address (f32), times address (f64), moment count, moments × (name index, gates, first gate m, gate spacing m,
/// scale, offset, word size, codes address)]. Each moment's codes are `radials × gates` u8 or u16 values. 0 for an
/// unknown sweep or a failed decoder (padding the moments can fail on the size limit, which fails the decoder).
#[unsafe(no_mangle)]
pub extern "C" fn a2_sweep(h: u32, el_num: u32) -> u32 {
    slot(h, |s| {
        let Ok(n) = u8::try_from(el_num) else { return 0 };
        if s.decoder.failed() {
            return 0;
        }
        let cut = s.decoder.legacy_cut(n);
        let sweep = match s.decoder.finish_sweep(n) {
            Ok(Some(sweep)) => sweep,
            _ => return 0,
        };
        publish(&mut s.out, |o| {
            let opt = |o: &mut Vec<f64>, v: Option<f64>| o.extend([f64::from(u8::from(v.is_some())), v.unwrap_or(0.0)]);
            o.extend([f64::from(n), sweep.mean_elevation()]);
            let (cut_el, cut_wave) = cut.unwrap_or((0.0, 0));
            o.extend([f64::from(u8::from(cut.is_some())), cut_el, f64::from(cut_wave), sweep.az_spacing]);
            opt(o, sweep.nyquist);
            opt(o, sweep.unamb_km);
            o.extend([sweep.azimuths.len() as f64, f64::from(u8::from(sweep.complete))]);
            o.extend([
                addr(&sweep.azimuths),
                addr(&sweep.elevations),
                addr(&sweep.times_ms),
                sweep.moments.len() as f64,
            ]);
            for m in &sweep.moments {
                let codes = match &m.raw {
                    Raw::U8(b) => addr(b),
                    Raw::U16(b) => addr(b),
                };
                o.extend([
                    m.name as f64,
                    m.gates as f64,
                    f64::from(m.first_m),
                    f64::from(m.spacing_m),
                    m.scale,
                    m.offset,
                    f64::from(m.word()),
                    codes,
                ]);
            }
        })
    })
    .unwrap_or(0)
}
