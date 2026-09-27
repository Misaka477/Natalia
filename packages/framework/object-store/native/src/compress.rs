//! Slice 4a — the zero-dependency compression core: a full RFC1950
//! inflater (stored / fixed-Huffman / dynamic-Huffman blocks, RFC1951)
//! and a zlib-WRAPPING stored-block deflater. Node's `zlib` is the
//! oracle in both directions: our inflate must decode its `deflateSync`
//! output (all block types), and node's `inflateSync` must decode ours.
//!
//! Why hand-written: the environment's cargo home is fresh per
//! invocation — a registry dependency would re-download every build
//! (the same law that gave the store its own SHA-256). The decoder is
//! the only untrusted-input body in the crate, so its style is
//! Result-only with checked reads — and the FFI wraps it in
//! `catch_unwind`, because a Rust panic across `extern "C"` aborts the
//! host process.

// ---------------------------------------------------------------------------
// Adler-32 (RFC1950's checksum): the wrapper the pack's `deflateSync`
// frames its streams with, verified on decode so a rotted record is an
// error, never silently wrong bytes.
// ---------------------------------------------------------------------------

const ADLER_MOD: u32 = 65_521;

pub fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for byte in data {
        a = (a + *byte as u32) % ADLER_MOD;
        b = (b + a) % ADLER_MOD;
    }
    (b << 16) | a
}

// ---------------------------------------------------------------------------
// The bit reader: DEFLATE is LSB-first within bytes (RFC1951 §3.1.1).
// ---------------------------------------------------------------------------

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit: u32,     // bit accumulator
    nbits: u32,   // bits in the accumulator
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, pos: 0, bit: 0, nbits: 0 }
    }

    fn need(&mut self, n: u32) -> Result<(), ()> {
        while self.nbits < n {
            if self.pos >= self.data.len() {
                return Err(());
            }
            self.bit |= (self.data[self.pos] as u32) << self.nbits;
            self.pos += 1;
            self.nbits += 8;
            if self.nbits > 24 {
                // keep the accumulator bounded
                break;
            }
        }
        if self.nbits < n {
            return Err(());
        }
        Ok(())
    }

    fn bits(&mut self, n: u32) -> Result<u32, ()> {
        if n == 0 {
            return Ok(0);
        }
        self.need(n)?;
        let value = self.bit & ((1u32 << n) - 1);
        self.bit >>= n;
        self.nbits -= n;
        Ok(value)
    }

    /// Align to the next byte boundary (stored blocks: RFC1951 §3.2.4).
    fn align(&mut self) {
        let drop = self.nbits % 8;
        self.bit >>= drop;
        self.nbits -= drop;
    }


    fn take_raw(&mut self, n: usize) -> Result<Vec<u8>, ()> {
        self.align();
        let buffered = (self.nbits / 8) as usize;
        if buffered >= n {
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                out.push((self.bit & 0xff) as u8);
                self.bit >>= 8;
                self.nbits -= 8;
            }
            return Ok(out);
        }
        if self.pos + (n - buffered) > self.data.len() {
            return Err(());
        }
        let start = self.pos - buffered;
        let out = self.data[start..start + n].to_vec();
        self.pos = start + n;
        self.nbits = 0;
        self.bit = 0;
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Canonical Huffman (RFC1951 §3.2.2): codes arrive MSB-packed per the
// spec's canonical order; we decode one bit at a time against the
// per-length code ranges. Correctness-first — a flat lookup table is a
// later optimization, not a correctness need.
// ---------------------------------------------------------------------------

struct Huff {
    counts: [u16; 16], // counts[len]
    symbols: Vec<u16>,  // symbols ordered by (length, symbol)
}

impl Huff {
    fn new(lengths: &[u8]) -> Result<Huff, ()> {
        let mut counts = [0u16; 16];
        for &len in lengths {
            if len as usize >= 16 {
                return Err(());
            }
            counts[len as usize] += 1;
        }
        counts[0] = 0;
        let mut offsets = [0u16; 16];
        for len in 1..16 {
            offsets[len] = offsets[len - 1] + counts[len - 1];
        }
        let total: u32 = counts[1..].iter().map(|c| *c as u32).sum();
        if total > 288 + 32 {
            return Err(());
        }
        let mut symbols = vec![0u16; total as usize];
        for (symbol, &len) in lengths.iter().enumerate() {
            if len != 0 {
                symbols[offsets[len as usize] as usize] = symbol as u16;
                offsets[len as usize] += 1;
            }
        }
        Ok(Huff { counts, symbols })
    }

    fn decode(&self, reader: &mut BitReader) -> Result<u16, ()> {
        let mut code: i32 = 0;
        let mut first: i32 = 0;
        let mut index: i32 = 0;
        for len in 1..16 {
            code |= reader.bits(1)? as i32;
            let count = self.counts[len] as i32;
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err(())
    }
}

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn fixed_tables() -> (Huff, Huff) {
    let mut lit = [0u8; 288];
    for (i, slot) in lit.iter_mut().enumerate() {
        *slot = if i < 144 {
            8
        } else if i < 256 {
            9
        } else if i < 280 {
            7
        } else {
            8
        };
    }
    let dist = [5u8; 30];
    (
        Huff::new(&lit).expect("fixed literal lengths are well-formed"),
        Huff::new(&dist).expect("fixed distance lengths are well-formed"),
    )
}

fn dynamic_tables(
    reader: &mut BitReader,
) -> Result<(Huff, Huff), ()> {
    const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let hlit = reader.bits(5)? as usize + 257;
    let hdist = reader.bits(5)? as usize + 1;
    let hclen = reader.bits(4)? as usize + 4;
    if hlit > 286 || hdist > 30 {
        return Err(());
    }
    let mut code_lengths = [0u8; 19];
    for i in 0..hclen {
        code_lengths[ORDER[i]] = reader.bits(3)? as u8;
    }
    let code_table = Huff::new(&code_lengths)?;
    let mut lengths = vec![0u8; hlit + hdist];
    let mut i = 0usize;
    while i < lengths.len() {
        let symbol = code_table.decode(reader)?;
        match symbol {
            0..=15 => {
                lengths[i] = symbol as u8;
                i += 1;
            }
            16 => {
                if i == 0 {
                    return Err(());
                }
                let prev = lengths[i - 1];
                let repeat = 3 + reader.bits(2)? as usize;
                for _ in 0..repeat {
                    if i >= lengths.len() {
                        return Err(());
                    }
                    lengths[i] = prev;
                    i += 1;
                }
            }
            17 => {
                let repeat = 3 + reader.bits(3)? as usize;
                i = (i + repeat).min(lengths.len());
            }
            18 => {
                let repeat = 11 + reader.bits(7)? as usize;
                i = (i + repeat).min(lengths.len());
            }
            _ => return Err(()),
        }
    }
    if i > lengths.len() {
        return Err(());
    }
    let lit = Huff::new(&lengths[..hlit])?;
    let dist = Huff::new(&lengths[hlit..])?;
    Ok((lit, dist))
}

fn inflate_blocks(
    reader: &mut BitReader,
    out: &mut Vec<u8>,
) -> Result<(), ()> {
    loop {
        let final_block = reader.bits(1)? == 1;
        let block_type = reader.bits(2)?;
        match block_type {
            0 => {
                // Stored (RFC1951 §3.2.4): DROP the remaining bits of the
                // current byte first — LEN/NLEN arrive as aligned little-
                // endian BYTES, not as a continuation of the bit stream.
                reader.align();
                let header = reader.take_raw(4)?;
                let len = u16::from_le_bytes([header[0], header[1]]) as usize;
                let nlen = u16::from_le_bytes([header[2], header[3]]) as usize;
                if len ^ 0xffff != nlen {
                    return Err(());
                }
                let raw = reader.take_raw(len)?;
                out.extend_from_slice(&raw);
            }
            1 | 2 => {
                let (lit, dist) = if block_type == 1 {
                    fixed_tables()
                } else {
                    dynamic_tables(reader)?
                };
                loop {
                    let symbol = lit.decode(reader)?;
                    if symbol == 256 {
                        break;
                    }
                    if symbol < 256 {
                        out.push(symbol as u8);
                        continue;
                    }
                    let idx = symbol as usize - 257;
                    if idx >= LENGTH_BASE.len() {
                        return Err(());
                    }
                    let length =
                        LENGTH_BASE[idx] as usize + reader.bits(LENGTH_EXTRA[idx] as u32)? as usize;
                    let dsym = dist.decode(reader)? as usize;
                    if dsym >= DIST_BASE.len() {
                        return Err(());
                    }
                    let distance =
                        DIST_BASE[dsym] as usize + reader.bits(DIST_EXTRA[dsym] as u32)? as usize;
                    if distance == 0 || distance > out.len() {
                        return Err(());
                    }
                    let start = out.len() - distance;
                    for offset in 0..length {
                        let byte = out[start + offset];
                        out.push(byte);
                    }
                }
            }
            _ => return Err(()),
        }
        if final_block {
            return Ok(());
        }
    }
}

/// RFC1950 zlib stream -> raw bytes. Every failure is an Err: the FFI
/// layer turns it into a negative code (a panic across `extern "C"`
/// would abort the host).
pub fn inflate(stream: &[u8]) -> Result<Vec<u8>, ()> {
    if stream.len() < 6 {
        return Err(());
    }
    let cmf = stream[0];
    if cmf & 0x0f != 8 {
        return Err(()); // CM = deflate
    }
    if ((cmf as u16) << 8 | stream[1] as u16) % 31 != 0 {
        return Err(()); // FCHECK
    }
    if stream[1] & 0x20 != 0 {
        return Err(()); // FDICT: preset dictionaries are not our stream
    }
    let body = &stream[2..stream.len() - 4];
    let mut reader = BitReader::new(body);
    let mut out = Vec::new();
    inflate_blocks(&mut reader, &mut out)?;
    let expected = u32::from_be_bytes([
        stream[stream.len() - 4],
        stream[stream.len() - 3],
        stream[stream.len() - 2],
        stream[stream.len() - 1],
    ]);
    if adler32(&out) != expected {
        return Err(());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The deflater: zlib-wrapped STORED blocks. A valid RFC1950 stream any
// reader accepts — node's `inflateSync` is the oracle — chosen because a
// correct-now, format-compatible encoder is honest engineering while a
// dynamic-Huffman encoder is an optimization the FORMAT NEEDS NO SIGNATURE
// FOR (the upgrade is byte-transparent to every reader). The delta record
// choice (slice 4b) is what carries most of a pack's size win anyway.
// ---------------------------------------------------------------------------

pub fn deflate_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 65_535 * 5 + 16);
    out.push(0x78);
    out.push(0x01);
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    } else {
        for (i, chunk) in data.chunks(65_535).enumerate() {
            let is_last = (i + 1) * 65_535 >= data.len();
            let len = chunk.len() as u16;
            out.push(if is_last { 0x01 } else { 0x00 });
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(chunk);
        }
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

/// The closed-form capacity a stored-block zlib stream can never
/// exceed: the caller allocates once, the encoder fills it.
pub fn deflate_bound(data_len: usize) -> usize {
    data_len + data_len / 65_535 * 5 + 16
}


