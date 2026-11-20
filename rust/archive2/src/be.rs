/// Big-endian reads of untrusted bytes: every read past the end is `None`.
#[derive(Clone, Copy)]
pub struct Be<'a>(pub &'a [u8]);

impl<'a> Be<'a> {
    pub fn len(self) -> usize {
        self.0.len()
    }

    pub fn bytes(self, at: usize, len: usize) -> Option<&'a [u8]> {
        self.0.get(at..at.checked_add(len)?)
    }

    fn array<const N: usize>(self, at: usize) -> Option<[u8; N]> {
        self.bytes(at, N)?.try_into().ok()
    }

    pub fn u8(self, at: usize) -> Option<u8> {
        self.0.get(at).copied()
    }
    pub fn u16(self, at: usize) -> Option<u16> {
        self.array(at).map(u16::from_be_bytes)
    }
    pub fn i16(self, at: usize) -> Option<i16> {
        self.array(at).map(i16::from_be_bytes)
    }
    pub fn u32(self, at: usize) -> Option<u32> {
        self.array(at).map(u32::from_be_bytes)
    }
    pub fn i32(self, at: usize) -> Option<i32> {
        self.array(at).map(i32::from_be_bytes)
    }
    pub fn f32(self, at: usize) -> Option<f32> {
        self.array(at).map(f32::from_be_bytes)
    }
}
