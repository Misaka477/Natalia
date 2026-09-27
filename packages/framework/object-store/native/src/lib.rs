//! T2 Phase A, slice 1 — the content-addressed STORE core:
//! `put`/`get`/`has` over the same loose-object layout the TS store
//! writes (`objects/<first2>/<64-hex>`, mode 600 under a 700 dir),
//! verify-on-read with the TS store's exact contract, plus a thin FFI
//! surface for bun:ffi. The chunked (>32 KiB, meta in SQLite), pack,
//! delta and GC paths are later slices per the plan's own module
//! layout (chunk.rs/pack.rs/gc.rs) — this slice is the whole loose
//! CAS, working end-to-end against the TS implementation.

mod compress;
mod pack;

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4). Written from the standard: the environment's
// CARGO_HOME is fresh per invocation, so a registry dependency would be
// re-downloaded every build — and the oracle for correctness exists anyway
// (node:crypto's sha256 + the NIST vectors, both asserted in tests).
// ---------------------------------------------------------------------------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H_INIT: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

#[inline]
fn rotr(x: u32, n: u32) -> u32 {
    x.rotate_right(n)
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = H_INIT;

    let mut padded_len = data.len() + 1;
    let rem = padded_len % 64;
    padded_len += if rem <= 56 { 56 - rem } else { 120 - rem };
    let mut message = Vec::with_capacity(padded_len + 8);
    message.extend_from_slice(data);
    message.push(0x80);
    message.resize(padded_len, 0);
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.extend_from_slice(&bit_len.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[4 * i],
                block[4 * i + 1],
                block[4 * i + 2],
                block[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];
        for i in 0..64 {
            let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn sha256_hex(data: &[u8]) -> String {
    let digest = sha256(data);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((byte & 0xf) as u32, 16).unwrap());
    }
    out
}

// ---------------------------------------------------------------------------
// The loose CAS — the TS store's exact layout and contract:
//   put  = sha256 id, dedup by existence, dir 700 / file 600;
//   get  = read THEN re-hash (verify-on-read: the address is the integrity
//          check — a rot is an error, never returned content);
//   has  = the file exists.
// The >32 KiB chunked branch lives in the TS store's metaDb (SQLite) and
// belongs to slice 3 with chunk.rs; packs/delta/GC follow the plan's own
// module list.
// ---------------------------------------------------------------------------

/// `root` is the ObjectStore's own root — the dir whose shards are the
/// first two hex chars (exactly what the TS `ObjectStore(root)` writes
/// at `root/<2>/<id>`), so both implementations address the same path.
fn object_path(root: &Path, id_hex: &str) -> PathBuf {
    root.join(&id_hex[..2]).join(id_hex)
}

fn validate_id(id_hex: &str) -> Result<(), String> {
    if id_hex.len() != 64 || !id_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invalid object id: {id_hex}"));
    }
    Ok(())
}

pub fn put(root: &Path, data: &[u8]) -> Result<String, String> {
    let id_hex = sha256_hex(data);
    let path = object_path(root, &id_hex);
    if path.exists() {
        return Ok(id_hex);
    }
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir)
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod {}: {e}", dir.display()))?;
    let tmp = path.with_extension("tmp-write");
    {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("create {}: {e}", tmp.display()))?;
        file.write_all(data)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), path.display()))?;
    Ok(id_hex)
}

pub fn has(root: &Path, id_hex: &str) -> bool {
    validate_id(id_hex).is_ok() && object_path(root, id_hex).is_file()
}

pub fn get(root: &Path, id_hex: &str) -> Result<Vec<u8>, String> {
    validate_id(id_hex)?;
    let path = object_path(root, id_hex);
    let data = fs::read(&path)
        .map_err(|e| format!("object {id_hex} unreadable at {}: {e}", path.display()))?;
    let actual = sha256_hex(&data);
    if actual != id_hex {
        return Err(format!(
            "object {id_hex} is corrupt: content hashes to {actual}"
        ));
    }
    Ok(data)
}

// ---------------------------------------------------------------------------
// Slice 3: content-defined chunking (the TS splitIntoChunks, ported
// bit-exactly): a u32 rolling hash with wrapping shifts — JS `<<` is
// 32-bit and `>>>0` re-unsigned, which is exactly u32 wrapping
// arithmetic, and the boundary test (>= chunkMin && hash&mask==0 &&
// not last byte) plus the chunkMax ceiling follow the same clause for
// clause. The chunked META row (SQLite) stays TS: zero-dep is the
// environment's law and the TS metaDb remains the store of record for
// chunk maps — this side owns content: split, chunk objects, manifest.
// ---------------------------------------------------------------------------

const CHUNK_MIN: usize = 32 * 1024;
const CHUNK_MAX: usize = 1024 * 1024;
const CHUNK_MASK: u32 = 0x3ffff;

pub fn split_into_chunks(data: &[u8]) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    while start < data.len() {
        let mut end = (start + CHUNK_MAX).min(data.len());
        let mut hash: u32 = 0;
        for i in start..end {
            hash = hash
                .wrapping_shl(1)
                .wrapping_add(hash.wrapping_shl(7))
                .wrapping_add(hash.wrapping_shl(15))
                .wrapping_add(data[i] as u32)
                ^ (data[i] as u32);
            if i - start >= CHUNK_MIN && (hash & CHUNK_MASK) == 0 && i + 1 < data.len() {
                end = i + 1;
                break;
            }
        }
        spans.push((start, end));
        start = end;
    }
    spans
}

/// Splits and WRITES (chunks, then the manifest) — mirroring the TS
/// operation order so a crash lands the same way: orphan chunks with no
/// meta row (harmless, GC's material later), never a meta row without
/// its manifest. Returns the chunk count: >1 means the manifest id sits
/// in `out64`; 0 means a single chunk (nothing written — the caller
/// falls through to the plain put, exactly like the TS path).
pub fn put_chunked(root: &Path, data: &[u8], out64: *mut u8) -> Result<i64, String> {
    let spans = split_into_chunks(data);
    if spans.len() <= 1 {
        return Ok(0);
    }
    let mut ids: Vec<String> = Vec::with_capacity(spans.len());
    for (start, end) in &spans {
        ids.push(put(root, &data[*start..*end])?);
    }
    // The manifest is exactly the TS store's JSON.stringify({version:1,
    // chunks}) — hex ids need no escaping, so the bytes match by shape.
    let mut manifest = String::from(r#"{"version":1,"chunks":["#);
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            manifest.push(',');
        }
        manifest.push('"');
        manifest.push_str(id);
        manifest.push('"');
    }
    manifest.push_str("]}");
    let manifest_id = put(root, manifest.as_bytes())?;
    if !out64.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(manifest_id.as_ptr(), out64, 64);
        }
    }
    Ok(ids.len() as i64)
}

// ---------------------------------------------------------------------------
// FFI for bun:ffi — strings arrive as (ptr, len) so ids and roots never
// depend on NUL termination; byte buffers are (ptr, len) with the caller's
// own capacity for results. Return codes: 0 ok, 1 corrupt, 2 unreadable,
// 3 invalid id/capacity; i64 results use -1 for "missing".
// ---------------------------------------------------------------------------

fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

fn root_from(ptr: *const u8, len: usize) -> Result<PathBuf, ()> {
    let bytes = slice(ptr, len);
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.is_empty() => Ok(PathBuf::from(text)),
        _ => Err(()),
    }
}

fn id_from(ptr: *const u8, len: usize) -> Result<String, ()> {
    let bytes = slice(ptr, len);
    match std::str::from_utf8(bytes) {
        Ok(text) if validate_id(text).is_ok() => Ok(text.to_string()),
        _ => Err(()),
    }
}

#[no_mangle]
pub extern "C" fn cas_put_chunked(
    root: *const u8,
    root_len: usize,
    data: *const u8,
    data_len: usize,
    out64: *mut u8,
) -> i64 {
    let root = match root_from(root, root_len) {
        Ok(root) => root,
        Err(()) => return -3,
    };
    match put_chunked(&root, slice(data, data_len), out64) {
        Ok(count) => count,
        Err(_) => -2,
    }
}

/// Inflates an RFC1950 stream into `out` (capacity from the caller's
/// `.idx`-known origLen). Returns bytes written; -1 = malformed or
/// capacity too small, -2 = adler mismatch (rotted record). The decode
/// runs under catch_unwind: a panic across `extern "C"` aborts the
/// host process, and this is the crate's only untrusted-input body.
#[no_mangle]
pub extern "C" fn zlib_inflate(
    z: *const u8,
    z_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> i64 {
    let stream = slice(z, z_len);
    let result = std::panic::catch_unwind(|| compress::inflate(stream));
    match result {
        Ok(Ok(bytes)) => {
            // A zero-length output is a legal success: the caller's
            // exact-cap buffer has no address (bun:ffi hands null for
            // empty) — same lesson as the store's empty puts.
            if bytes.is_empty() {
                return 0;
            }
            if out.is_null() || out_cap < bytes.len() {
                return -1;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
            }
            bytes.len() as i64
        }
        Ok(Err(())) => -1,
        Err(_) => -2,
    }
}

/// Deflates into a zlib-wrapped stored-block stream (node's
/// inflateSync is the oracle for its validity). Returns bytes written;
/// -1 = capacity too small, -2 = panic (belt over a body that cannot
/// currently fail — an encoder over our own bytes, not untrusted
/// input).
#[no_mangle]
pub extern "C" fn zlib_deflate(
    data: *const u8,
    data_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> i64 {
    let bytes = slice(data, data_len);
    let result = std::panic::catch_unwind(|| compress::deflate_stored(bytes));
    match result {
        Ok(stream) => {
            if out.is_null() || out_cap < stream.len() {
                return -1;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(stream.as_ptr(), out, stream.len());
            }
            stream.len() as i64
        }
        Err(_) => -2,
    }
}

#[no_mangle]
pub extern "C" fn zlib_deflate_bound(data_len: usize) -> i64 {
    compress::deflate_bound(data_len) as i64
}

#[no_mangle]
pub extern "C" fn zlib_inflate_max(z_len: usize) -> i64 {
    // A stored-block zlib stream can never expand past its input by
    // more than the framing per 64 KiB; a dynamic stream's worst-case
    // expansion is bounded too — callers that KNOW the original length
    // (the .idx records it) should pass it instead of trusting this.
    (z_len + z_len / 65_535 * 5 + 64) as i64
}

/// Slice 4b-α: the pack frame as ONE call (the slice-4a sizing lesson
/// — no work done twice). Input is flat: u32 count, then per entry
/// {idLen:u32, id, dataLen:u32, data}. Output: {packLen:u32, pack,
/// idxLen:u32, idx}. Returns bytes written; -1 = capacity, -2 = bad
/// input, -3 = panic belt (our own bytes, not untrusted input).
#[no_mangle]
pub extern "C" fn pack_frame(
    input: *const u8,
    input_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> i64 {
    let bytes = slice(input, input_len);
    let result = std::panic::catch_unwind(|| {
        let mut cursor = 0usize;
        let need = |cursor: &mut usize, n: usize| -> Result<(), ()> {
            if *cursor + n > bytes.len() {
                return Err(());
            }
            Ok(())
        };
        need(&mut cursor, 4)?;
        let count = u32::from_le_bytes(
            bytes[cursor..cursor + 4].try_into().unwrap(),
        ) as usize;
        cursor += 4;
        let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(count);
        for _ in 0..count {
            need(&mut cursor, 4)?;
            let id_len =
                u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
            cursor += 4;
            need(&mut cursor, id_len)?;
            let id = String::from_utf8(bytes[cursor..cursor + id_len].to_vec()).map_err(|_| ())?;
            cursor += id_len;
            need(&mut cursor, 4)?;
            let data_len =
                u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
            cursor += 4;
            need(&mut cursor, data_len)?;
            entries.push((id, bytes[cursor..cursor + data_len].to_vec()));
            cursor += data_len;
        }
        let borrowed: Vec<pack::PackEntry> = entries
            .iter()
            .map(|(id, data)| pack::PackEntry { id, data })
            .collect();
        Ok(pack::pack_frame(&borrowed))
    });
    match result {
        Ok(Ok((pack, idx))) => {
            let needed = 4 + pack.len() + 4 + idx.len();
            if out.is_null() || out_cap < needed {
                return -1;
            }
            // Lengths as locals: no address-of-a-pointer, no temporary
            // array outliving its use.
            let pack_len = (pack.len() as u32).to_le_bytes();
            let idx_len = (idx.len() as u32).to_le_bytes();
            unsafe {
                let mut at = out;
                std::ptr::copy_nonoverlapping(pack_len.as_ptr(), at, 4);
                at = at.add(4);
                std::ptr::copy_nonoverlapping(pack.as_ptr(), at, pack.len());
                at = at.add(pack.len());
                std::ptr::copy_nonoverlapping(idx_len.as_ptr(), at, 4);
                at = at.add(4);
                std::ptr::copy_nonoverlapping(idx.as_ptr(), at, idx.len());
            }
            needed as i64
        }
        Ok(Err(())) => -2,
        Err(_) => -3,
    }
}

#[no_mangle]
pub extern "C" fn pack_frame_bound(input_len: usize) -> i64 {
    // input + the per-entry framing worst case + the index records: a
    // closed form from what the caller already knows.
    (input_len + 4096 + (input_len / 64 + 64) * 64 + input_len / 4) as i64
}

#[no_mangle]
pub extern "C" fn cas_sha256_hex(data: *const u8, data_len: usize, out64: *mut u8) -> i32 {
    if out64.is_null() {
        return 3;
    }
    let hex = sha256_hex(slice(data, data_len));
    unsafe {
        std::ptr::copy_nonoverlapping(hex.as_ptr(), out64, 64);
    }
    0
}

#[no_mangle]
pub extern "C" fn cas_put(
    root: *const u8,
    root_len: usize,
    data: *const u8,
    data_len: usize,
    out64: *mut u8,
) -> i32 {
    if out64.is_null() {
        return 3;
    }
    let root = match root_from(root, root_len) {
        Ok(root) => root,
        Err(()) => return 3,
    };
    match put(&root, slice(data, data_len)) {
        Ok(hex) => {
            unsafe {
                std::ptr::copy_nonoverlapping(hex.as_ptr(), out64, 64);
            }
            0
        }
        Err(_) => 2,
    }
}

#[no_mangle]
pub extern "C" fn cas_has(root: *const u8, root_len: usize, id: *const u8, id_len: usize) -> i32 {
    let root = match root_from(root, root_len) {
        Ok(root) => root,
        Err(()) => return 3,
    };
    match id_from(id, id_len) {
        Ok(id_hex) => {
            if has(&root, &id_hex) {
                1
            } else {
                0
            }
        }
        Err(()) => 3,
    }
}

#[no_mangle]
pub extern "C" fn cas_get_size(
    root: *const u8,
    root_len: usize,
    id: *const u8,
    id_len: usize,
) -> i64 {
    let (root, id_hex) = match (root_from(root, root_len), id_from(id, id_len)) {
        (Ok(root), Ok(id_hex)) => (root, id_hex),
        _ => return -2,
    };
    match fs::metadata(object_path(&root, &id_hex)) {
        Ok(meta) => meta.len() as i64,
        Err(_) => -1,
    }
}

/// Reads and VERIFIES. Returns bytes written; 1 = corrupt (the TS
/// store's exact failure), 2 = unreadable/invalid, 3 = capacity too
/// small. Verification happens here so a truncation can never be
/// delivered as content over the boundary.
#[no_mangle]
pub extern "C" fn cas_get(
    root: *const u8,
    root_len: usize,
    id: *const u8,
    id_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> i64 {
    let (root, id_hex) = match (root_from(root, root_len), id_from(id, id_len)) {
        (Ok(root), Ok(id_hex)) => (root, id_hex),
        _ => return 2,
    };
    match get(&root, &id_hex) {
        Ok(data) => {
            if out.is_null() || out_cap < data.len() {
                return 3;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(data.as_ptr(), out, data.len());
            }
            data.len() as i64
        }
        Err(message) => {
            if message.contains("is corrupt") {
                1
            } else {
                2
            }
        }
    }
}
