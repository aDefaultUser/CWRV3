// Untrusted input: corrupt, truncated and oversized records fail with their error and leave the decoder failed;
// limits hold before memory is committed; random and mutated input never panics. Value parity with the TypeScript
// reference is tested from JavaScript on the WebAssembly build (tests/archive2-wasm.test.ts).
#![allow(clippy::indexing_slicing, clippy::unwrap_used)]
use bzip2::Compression;
use bzip2::write::BzEncoder;
use cwrv3_archive2::{DecodeError, Decoder, Raw};
use std::io::Write;
use std::time::{Duration, Instant};

/// A message 31 radial (CTM + message header + payload) with one REF block of `gates` codes of `word` bits.
fn radial(el_num: u8, az: f32, status: u8, gates: u16) -> Vec<u8> {
    radial_of(el_num, az, status, gates, 8)
}

fn radial_of(el_num: u8, az: f32, status: u8, gates: u16, word: u8) -> Vec<u8> {
    let mut p = vec![0u8; 32 + 4];
    p[0..4].copy_from_slice(b"KTST");
    p[4..8].copy_from_slice(&3_600_000u32.to_be_bytes());
    p[8..10].copy_from_slice(&20_000u16.to_be_bytes());
    p[12..16].copy_from_slice(&az.to_be_bytes());
    p[20] = 1;
    p[21] = status;
    p[22] = el_num;
    p[24..28].copy_from_slice(&0.5f32.to_be_bytes());
    p[30..32].copy_from_slice(&1u16.to_be_bytes());
    p[32..36].copy_from_slice(&36u32.to_be_bytes());
    let mut block = vec![0u8; 28];
    block[0..4].copy_from_slice(b"DREF");
    block[8..10].copy_from_slice(&gates.to_be_bytes());
    block[10..12].copy_from_slice(&2125i16.to_be_bytes());
    block[12..14].copy_from_slice(&250i16.to_be_bytes());
    block[19] = word;
    block[20..24].copy_from_slice(&2.0f32.to_be_bytes());
    block[24..28].copy_from_slice(&66.0f32.to_be_bytes());
    p.extend(block);
    for g in 0..gates {
        let code = g % 250 + 2;
        if word == 16 {
            p.extend(code.to_be_bytes());
        } else {
            p.push(code as u8);
        }
    }
    if p.len() % 2 == 1 {
        p.push(0);
    }
    let mut m = vec![0u8; 28];
    m[12..14].copy_from_slice(&(((16 + p.len()) / 2) as u16).to_be_bytes());
    m[15] = 31;
    m.extend(p);
    m
}

fn record(body: &[u8]) -> Vec<u8> {
    let mut r = (body.len() as i32).to_be_bytes().to_vec();
    r.extend_from_slice(body);
    r
}

fn bz(data: &[u8]) -> Vec<u8> {
    let mut e = BzEncoder::new(Vec::new(), Compression::best());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn header() -> Vec<u8> {
    let mut h = b"AR2V0006.001".to_vec();
    h.extend(20_000u32.to_be_bytes());
    h.extend(3_600_000u32.to_be_bytes());
    h.extend(b"KTST");
    h
}

/// A sweep of `n` radials of `gates` gates, the last ending the elevation.
fn sweep(n: usize, gates: u16) -> Vec<u8> {
    (0..n).flat_map(|r| radial(1, r as f32 * 360.0 / n as f32, if r + 1 == n { 2 } else { 1 }, gates)).collect()
}

fn volume_with(records: &[Vec<u8>]) -> Vec<u8> {
    let mut v = header();
    for r in records {
        v.extend(record(r));
    }
    v
}

fn codes(d: &Decoder) -> Vec<u8> {
    match &d.sweeps.get(&1).unwrap().moments[0].raw {
        Raw::U8(b) => b.clone(),
        Raw::U16(_) => unreachable!(),
    }
}

#[test]
fn bzip2_records_decode_like_plain_records() {
    let body = sweep(360, 100);
    let (mut plain, mut packed) = (Decoder::new(), Decoder::new());
    plain.feed(&volume_with(std::slice::from_ref(&body))).unwrap();
    packed.feed(&volume_with(&[bz(&body)])).unwrap();
    assert_eq!(packed.sweeps.get(&1).unwrap().azimuths.len(), 360);
    assert_eq!(codes(&plain), codes(&packed));
    // A whole-file bzip2 volume (tgftp .bz2) is the same volume.
    let mut whole = Decoder::new();
    whole.feed(&bz(&volume_with(&[bz(&body)]))).unwrap();
    assert_eq!(codes(&whole), codes(&plain));
}

#[test]
fn corrupt_bzip2_fails_and_the_decoder_stays_failed() {
    let mut rec = bz(&sweep(360, 100));
    let mid = rec.len() / 2;
    rec[mid] ^= 0x55;
    let mut d = Decoder::new();
    d.feed(&volume_with(&[bz(&sweep(10, 10))])).unwrap();
    assert_eq!(d.feed(&record(&rec)), Err(DecodeError::Bzip2));
    assert!(d.failed());
    assert_eq!(d.feed(&record(&bz(&sweep(10, 10)))), Err(DecodeError::Failed));
}

#[test]
fn truncated_bzip2_fails() {
    let rec = bz(&sweep(360, 100));
    let cut = &rec[..rec.len() - 40];
    assert_eq!(Decoder::new().feed(&volume_with(&[cut.to_vec()])), Err(DecodeError::Truncated));
    // A whole-file bzip2 volume cut short.
    let whole = bz(&volume_with(&[sweep(20, 20)]));
    assert_eq!(Decoder::new().feed(&whole[..whole.len() / 2]), Err(DecodeError::Truncated));
}

#[test]
fn a_bzip2_bomb_stops_at_the_record_limit() {
    let t = Instant::now();
    let bomb = bz(&vec![0u8; 80 << 20]);
    assert!(bomb.len() < 4096);
    let t = t.elapsed();
    let t0 = Instant::now();
    assert_eq!(Decoder::new().feed(&volume_with(&[bomb])), Err(DecodeError::TooLarge));
    assert!(t0.elapsed() < Duration::from_secs(5) + t);
}

#[test]
fn sweeps_are_limited_in_radials_and_bytes() {
    // Radials beyond the per-sweep limit.
    let many = sweep(8193, 1);
    assert_eq!(Decoder::new().feed(&volume_with(&[many])), Err(DecodeError::TooLarge));
    // One wide 16-bit radial after thousands of empty ones would need 8100 × 50000 × 2 bytes: refused before
    // allocating.
    let mut body: Vec<u8> = (0..8100).flat_map(|r| radial_of(1, r as f32 / 30.0, 1, 0, 16)).collect();
    body.extend(radial_of(1, 1.0, 1, 50_000, 16));
    let mut d = Decoder::new();
    assert_eq!(d.feed(&volume_with(&[body])), Err(DecodeError::TooLarge));
    assert!(d.decoded_bytes <= 768 << 20);
}

#[test]
fn a_short_moment_row_is_zero_padded_and_a_wider_one_widens_the_sweep() {
    let mut body = radial(1, 0.0, 1, 4);
    body.extend(radial(1, 1.0, 1, 2));
    body.extend(radial(1, 2.0, 2, 6));
    let mut d = Decoder::new();
    d.feed(&volume_with(&[body])).unwrap();
    d.finish_sweep(1).unwrap();
    let m = &d.sweeps.get(&1).unwrap().moments[0];
    assert_eq!((m.gates, m.rows), (6, 3));
    assert_eq!(codes(&d), [2, 3, 4, 5, 0, 0, 2, 3, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7]);
}

/// xorshift64*: deterministic noise for mutation runs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

#[test]
fn random_and_mutated_input_never_panics() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let plain = volume_with(&[sweep(40, 30), sweep(40, 30)]);
    let packed = volume_with(&[bz(&sweep(40, 30))]);
    let t = Instant::now();
    for round in 0..3000 {
        let mut buf = if round % 3 == 0 {
            (0..(rng.next() % 4096) as usize).map(|_| rng.next() as u8).collect()
        } else if round % 3 == 1 {
            plain.clone()
        } else {
            packed.clone()
        };
        if round % 3 != 0 {
            for _ in 0..1 + rng.next() % 8 {
                let at = (rng.next() as usize) % buf.len();
                buf[at] = rng.next() as u8;
            }
            if rng.next() % 4 == 0 {
                buf.truncate((rng.next() as usize) % buf.len());
            }
        }
        let mut d = Decoder::new();
        if d.feed(&buf).is_ok() {
            for n in d.sweeps.keys().copied().collect::<Vec<_>>() {
                let _ = d.legacy_cut(n);
                let _ = d.finish_sweep(n);
            }
        }
    }
    assert!(t.elapsed() < Duration::from_secs(60));
}
