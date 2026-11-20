//! NEXRAD Archive II (Level 2) decoder of the CWRV3 decode worker, compiled to wasm32. It mirrors the TypeScript
//! reference `src/decode/archive2.ts` value for value; `src/decode/archive2-wasm.ts` is its JavaScript side.
mod be;
mod bunzip;
pub mod decoder;
#[cfg(target_arch = "wasm32")]
mod ffi;

pub use decoder::{Decoder, MOMENT_NAMES, Moment, Raw, Sweep, Vcp, VcpCut};

/// Why a feed was refused. The decoder is unusable afterwards (`Failed`): its state may hold part of the input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// A bzip2 record is corrupt (bad structure or CRC).
    Bzip2 = 1,
    /// A bzip2 record ends inside its stream.
    Truncated = 2,
    /// A record, sweep or the decoded volume exceeds the decoder's limits.
    TooLarge = 3,
    OutOfMemory = 4,
    /// An earlier feed failed.
    Failed = 5,
}
