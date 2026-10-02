//! The pack READER — the half of the pack format Phase A left in TS.
//!
//! Phase A landed the pack/delta WRITERS here (pack.rs's `pack_frame`, the
//! delta chain in one call) while the TS stayed the reader. That was the
//! honest shape when the writer set the format, but it left every
//! read-side path — and the GC's pack fallback most of all — crossing
//! back into TS per object, which is exactly the cost this module
//! removes. The reader is std-only like the rest of the crate: the mmap
//! is the same three libc calls native-index uses, and the delta format
//! is the two-op one the writer emits (op 0 = copy from the base, op 1 =
//! literal).
//!
//! Wire compatibility is the contract, not an aspiration: the NDX1 parse
//! below is the same layout `pack_frame` writes and `native-index`
//! reads, and the reads are byte-identical to the TS `readPackEntry`
//! + `applyDelta` pair (pinned by the GC tests, which run the same
//! objects through both sides).

use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

#[cfg(unix)]
extern "C" {
    fn mmap(
        addr: *mut std::ffi::c_void,
        length: usize,
        prot: i32,
        flags: i32,
        fd: i32,
        offset: i64,
    ) -> *mut std::ffi::c_void;
    fn munmap(addr: *mut std::ffi::c_void, length: usize) -> i32;
}

#[cfg(windows)]
extern "system" {
    fn CreateFileMappingW(
        file: *mut std::ffi::c_void,
        attributes: *mut std::ffi::c_void,
        protect: u32,
        maximum_size_high: u32,
        maximum_size_low: u32,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn MapViewOfFile(
        section: *mut std::ffi::c_void,
        desired_access: u32,
        file_offset_high: u32,
        file_offset_low: u32,
        number_of_bytes: usize,
    ) -> *mut std::ffi::c_void;
    fn UnmapViewOfFile(base: *mut std::ffi::c_void) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

/// A read-only private mapping of one file; `Drop` unmaps. The bytes are
/// the file's, faulted in on demand — a pack read pays a page table
/// entry, not a copy.
struct Mmap {
    ptr: *mut std::ffi::c_void,
    len: usize,
    /// The section object the view was carved from; closed on drop
    /// (POSIX closes with the fd alone, so it is Windows-only).
    #[cfg(windows)]
    section: *mut std::ffi::c_void,
}

impl Mmap {
    fn map(path: &Path) -> Option<Mmap> {
        let file = std::fs::File::open(path).ok()?;
        let len = file.metadata().ok()?.len() as usize;
        if len == 0 {
            return None;
        }
        #[cfg(unix)]
        {
            const PROT_READ: i32 = 1;
            const MAP_PRIVATE: i32 = 2;
            let ptr = unsafe {
                mmap(
                    std::ptr::null_mut(),
                    len,
                    PROT_READ,
                    MAP_PRIVATE,
                    file.as_raw_fd(),
                    0,
                )
            };
            if ptr.is_null() || ptr as isize == -1 {
                return None;
            }
            Some(Mmap {
                ptr,
                len,
                #[cfg(windows)]
                section: std::ptr::null_mut(),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            const PAGE_READONLY: u32 = 0x02;
            const FILE_MAP_READ: u32 = 0x04;
            let section = unsafe {
                CreateFileMappingW(
                    file.as_raw_handle(),
                    std::ptr::null_mut(),
                    PAGE_READONLY,
                    0,
                    0,
                    std::ptr::null(),
                )
            };
            if section.is_null() {
                return None;
            }
            let ptr = unsafe { MapViewOfFile(section, FILE_MAP_READ, 0, 0, len) };
            if ptr.is_null() {
                unsafe { CloseHandle(section) };
                return None;
            }
            Some(Mmap { ptr, len, section })
        }
    }

    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr as *const u8, self.len) }
    }
}

impl Drop for Mmap {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            munmap(self.ptr, self.len);
        }
        #[cfg(windows)]
        unsafe {
            UnmapViewOfFile(self.ptr);
            if !self.section.is_null() {
                CloseHandle(self.section);
            }
        }
    }
}

/// One object's place in one pack. `base_id` is carried only for the
/// delta kind (kind 1) — the same optional the TS entry shape has.
pub struct IndexEntry {
    pub data_offset: u32,
    pub orig_len: u32,
    pub comp_len: u32,
    pub kind: u8,
    pub delta_len: u32,
    pub base_id: Option<String>,
}

/// The NDX1 records of one index, in payload order. The parse is the
/// layout `pack_frame` writes; the id's bytes are returned so the caller
/// can search without a second mapping.
pub struct IndexRecord {
    pub id: String,
    pub data_offset: u32,
    pub orig_len: u32,
    pub comp_len: u32,
    pub kind: u8,
    pub delta_len: u32,
    pub base_id: Option<String>,
}

/// Parses an NDX1 index. A malformed or foreign index yields no records
/// rather than an error: the caller treats a pack whose index cannot be
/// read as absent (the same tolerance the TS loader has — a half-written
/// pack is ignored, and its `.idx` is the commit).
pub fn parse_ndx1(bytes: &[u8]) -> Vec<IndexRecord> {
    let mut out = Vec::new();
    if bytes.len() < 12 || &bytes[..4] != b"NDX1" {
        return out;
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let mut offset = 12;
    for _ in 0..count {
        if offset + 4 > bytes.len() {
            break;
        }
        let id_len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if offset + id_len > bytes.len() {
            break;
        }
        let id = String::from_utf8_lossy(&bytes[offset..offset + id_len]).into_owned();
        offset += id_len;
        if offset + 17 > bytes.len() {
            break;
        }
        let data_offset = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap());
        let orig_len = u32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap());
        let comp_len = u32::from_le_bytes(bytes[offset + 12..offset + 16].try_into().unwrap());
        let kind = bytes[offset + 16];
        offset += 17;
        let (delta_len, base_id) = if kind == 1 {
            if offset + 4 > bytes.len() {
                break;
            }
            let base_len =
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            if offset + base_len + 4 > bytes.len() {
                break;
            }
            let base =
                String::from_utf8_lossy(&bytes[offset..offset + base_len]).into_owned();
            offset += base_len;
            let dlen = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            offset += 4;
            (dlen, Some(base))
        } else {
            (0, None)
        };
        out.push(IndexRecord {
            id,
            data_offset,
            orig_len,
            comp_len,
            kind,
            delta_len,
            base_id,
        });
    }
    out
}

/// Applies one delta to its base: op 0 copies `len` bytes from the base
/// at `pos`, op 1 takes `len` literal bytes from the delta. This is the
/// TS `applyDelta` byte for byte — an unknown op or a length mismatch is
/// an error, not a truncation.
pub fn apply_delta(base: &[u8], delta: &[u8], expected_len: usize) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(expected_len);
    let mut offset = 0usize;
    while offset < delta.len() {
        let op = delta[offset];
        offset += 1;
        if op == 0 {
            if offset + 8 > delta.len() {
                return Err("truncated delta copy header".to_string());
            }
            let pos = u32::from_le_bytes(delta[offset..offset + 4].try_into().unwrap()) as usize;
            let len =
                u32::from_le_bytes(delta[offset + 4..offset + 8].try_into().unwrap()) as usize;
            offset += 8;
            let end = pos
                .checked_add(len)
                .ok_or_else(|| "delta copy range overflow".to_string())?;
            if end > base.len() {
                return Err("delta copy past the base".to_string());
            }
            out.extend_from_slice(&base[pos..end]);
        } else if op == 1 {
            if offset + 4 > delta.len() {
                return Err("truncated delta literal header".to_string());
            }
            let len =
                u32::from_le_bytes(delta[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            if offset + len > delta.len() {
                return Err("truncated delta literal".to_string());
            }
            out.extend_from_slice(&delta[offset..offset + len]);
            offset += len;
        } else {
            return Err(format!("unknown delta op {op}"));
        }
    }
    if out.len() != expected_len {
        return Err(format!(
            "delta result length mismatch: {} != {expected_len}",
            out.len()
        ));
    }
    Ok(out)
}

/// A resolved object: its bytes and where they came from (loose or a
/// pack). The GC reads every kept object through this, and the reader
/// reports the source so the caller can account for it.
pub struct Resolved {
    pub data: Vec<u8>,
    pub from_pack: bool,
}

/// Reads one object by id from a pack set, resolving delta chains
/// against `resolve_base` (which is the same reader one level up: a
/// delta's base may itself be packed, and its base's base — the chain is
/// as deep as the pack is).
pub fn read_from_pack<F>(
    pack_files: &[(PathBuf, Vec<IndexRecord>)],
    id: &str,
    resolve_base: &F,
) -> Result<Resolved, String>
where
    F: Fn(&str) -> Result<Resolved, String>,
{
    for (pack_path, records) in pack_files {
        let Some(record) = records.iter().find(|record| record.id == id) else {
            continue;
        };
        let map = Mmap::map(pack_path).ok_or_else(|| format!("cannot map {}", pack_path.display()))?;
        let bytes = map.bytes();
        let entry = IndexEntry {
            data_offset: record.data_offset,
            orig_len: record.orig_len,
            comp_len: record.comp_len,
            kind: record.kind,
            delta_len: record.delta_len,
            base_id: record.base_id.clone(),
        };
        let data = read_entry(bytes, &entry, resolve_base)?;
        return Ok(Resolved { data, from_pack: true });
    }
    Err(format!("object not found: {id}"))
}

/// Reads one entry's bytes out of its pack image. Kind 0 inflates;
/// kind 1 applies the delta to its base.
fn read_entry<F>(pack_bytes: &[u8], entry: &IndexEntry, resolve_base: &F) -> Result<Vec<u8>, String>
where
    F: Fn(&str) -> Result<Resolved, String>,
{
    match entry.kind {
        0 => {
            let start = entry.data_offset as usize;
            let end = start
                .checked_add(entry.comp_len as usize)
                .ok_or_else(|| "pack entry range overflow".to_string())?;
            if end > pack_bytes.len() {
                return Err("pack entry past the pack".to_string());
            }
            let original = crate::compress::inflate(&pack_bytes[start..end])
                .map_err(|_| "pack entry inflate failed".to_string())?;
            if original.len() != entry.orig_len as usize {
                return Err("pack object size mismatch".to_string());
            }
            Ok(original)
        }
        1 => {
            let start = entry.data_offset as usize;
            let end = start
                .checked_add(entry.delta_len as usize)
                .ok_or_else(|| "pack entry range overflow".to_string())?;
            if end > pack_bytes.len() {
                return Err("pack delta past the pack".to_string());
            }
            let base_id = entry
                .base_id
                .as_deref()
                .ok_or_else(|| "delta entry without a base".to_string())?;
            let base = resolve_base(base_id)?;
            apply_delta(&base.data, &pack_bytes[start..end], entry.orig_len as usize)
        }
        other => Err(format!("unknown pack entry kind {other}")),
    }
}

/// Loads one pack set: every `*.idx` in the pack directory, parsed. A
/// directory that does not exist is an empty set (a store that has never
/// packed), not an error.
pub fn load_pack_set(packs_dir: &Path) -> Vec<(PathBuf, Vec<IndexRecord>)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(packs_dir) else {
        return out;
    };
    let mut names: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("idx"))
        .collect();
    names.sort();
    for path in names {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let records = parse_ndx1(&bytes);
        if records.is_empty() {
            continue;
        }
        // The pack's own path: `<stem>.idx` -> `<stem>.pack`.
        let pack_path = path.with_extension("pack");
        if !pack_path.exists() {
            continue;
        }
        out.push((pack_path, records));
    }
    out
}
