use crate::DecodeError;
use bzip2::{Decompress, Status};

/// Decompresses the bzip2 stream at the start of `input` into `out` (replacing its contents), refusing to produce
/// more than `limit` bytes. Block and stream CRCs are verified; data after the end of the stream is ignored.
pub fn bunzip(input: &[u8], limit: usize, out: &mut Vec<u8>) -> Result<(), DecodeError> {
    out.clear();
    let mut d = Decompress::new(false);
    loop {
        if out.len() == out.capacity() {
            if out.len() >= limit {
                return Err(DecodeError::TooLarge);
            }
            let grow = out.capacity().max(1 << 16).min(limit - out.len());
            out.try_reserve_exact(grow).map_err(|_| DecodeError::OutOfMemory)?;
        }
        let (read, written) = (d.total_in(), d.total_out());
        let rest = usize::try_from(read).ok().and_then(|n| input.get(n..)).ok_or(DecodeError::Bzip2)?;
        let status = d.decompress_vec(rest, out).map_err(|_| DecodeError::Bzip2)?;
        if out.len() > limit {
            return Err(DecodeError::TooLarge);
        }
        if status == Status::StreamEnd {
            return Ok(());
        }
        // Without progress and with output space left, the input ended inside the stream.
        if d.total_in() == read && d.total_out() == written && out.len() < out.capacity() {
            return Err(DecodeError::Truncated);
        }
    }
}
