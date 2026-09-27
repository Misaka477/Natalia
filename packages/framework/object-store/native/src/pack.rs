//! Slice 4b-α — the pack frame writer: delta records, full records,
//! and the NDX1 binary index, as PURE FUNCTIONS over an ordered entry
//! list. The TS store stays the fs/order side (listLoose's readdir
//! order passes through untouched) and, crucially, stays the READER:
//! its `applyDelta` and `inflateSync` consume these bytes — so the
//! cross-acceptance test feeds our output straight into the live read
//! path, with the original code as the oracle.
//!
//! The formats, studied clause for clause from the TS writer:
//! pack = "NPAC" + version u8, then per entry either
//!   kind 0: {kind:0, idLen:u32, id, origLen:u32, compLen:u32} + zlib bytes
//!   kind 1: {kind:1, baseLen:u32, baseId, origLen:u32, deltaLen:u32} + RAW delta
//! idx  = "NDX1" + {version u32, count u32} + per entry the TS writer's
//!        header order (the native-index reader's twin).

use crate::compress::{deflate_bound, deflate_stored};
use std::collections::HashMap;

/// The TS `deltaSize` gate, ported: both sides >=64 bytes and the
/// instruction stream meaningfully smaller than the full original.
pub fn delta_worthwhile(original: &[u8], base: &[u8]) -> bool {
    if original.len() < 64 || base.len() < 64 {
        return false;
    }
    let delta = compute_delta(base, original);
    (delta.len() as f64) < (original.len() as f64) * 0.7
}

/// The TS `computeDelta`, ported instruction for instruction: a16-byte
/// window map over the base (FORWARD insertion = the LAST position
/// wins, exactly as the TS Map does), min match8, literals flushed as
/// {1, len:u32, bytes} and matches as {0, pos:u32, len:u32}.
pub fn compute_delta(base: &[u8], current: &[u8]) -> Vec<u8> {
    const MIN_MATCH: usize = 8;
    const WINDOW: usize = 16;
    let mut out: Vec<u8> = Vec::with_capacity(current.len() / 2 + 16);
    let mut literal: Vec<u8> = Vec::new();
    let mut base_windows: HashMap<&[u8], usize> = HashMap::new();
    if base.len() >= WINDOW {
        for pos in 0..=(base.len() - WINDOW) {
            base_windows.insert(&base[pos..pos + WINDOW], pos);
        }
    }
    let flush_literal = |literal: &mut Vec<u8>, out: &mut Vec<u8>| {
        if literal.is_empty() {
            return;
        }
        out.push(1);
        out.extend_from_slice(&(literal.len() as u32).to_le_bytes());
        out.extend_from_slice(literal);
        literal.clear();
    };
    let mut i = 0usize;
    while i < current.len() {
        let mut best_len = 0usize;
        let mut best_pos = 0usize;
        if i + WINDOW <= current.len() {
            if let Some(&pos) = base_windows.get(&current[i..i + WINDOW]) {
                let mut len = WINDOW;
                while i + len < current.len()
                    && pos + len < base.len()
                    && base[pos + len] == current[i + len]
                {
                    len += 1;
                }
                best_len = len;
                best_pos = pos;
            }
        }
        if best_len >= MIN_MATCH {
            flush_literal(&mut literal, &mut out);
            out.push(0);
            out.extend_from_slice(&(best_pos as u32).to_le_bytes());
            out.extend_from_slice(&(best_len as u32).to_le_bytes());
            i += best_len;
        } else {
            literal.push(current[i]);
            i += 1;
        }
    }
    flush_literal(&mut literal, &mut out);
    out
}

pub struct PackEntry<'a> {
    pub id: &'a str,
    pub data: &'a [u8],
}

/// Builds the two files' BYTES for one pack: the delta-vs-previous
/// chain (the TS walks its loose list in order), then NDX1. Returns
/// (pack bytes, index bytes).
pub fn pack_frame(entries: &[PackEntry]) -> (Vec<u8>, Vec<u8>) {
    let mut pack: Vec<u8> = Vec::new();
    pack.extend_from_slice(b"NPAC");
    pack.push(1); // packVersion

    // id -> the NDX1 record's fields, in listLoose's order
    let mut records: Vec<Record> = Vec::with_capacity(entries.len());
    let mut offset = 5usize; // magic + version
    let mut last: Option<(String, Vec<u8>)> = None;
    for entry in entries {
        let worthwhile = last
            .as_ref()
            .map(|(_, base)| delta_worthwhile(entry.data, base))
            .unwrap_or(false);
        if worthwhile {
            let (_, base) = last.as_ref().unwrap();
            let delta = compute_delta(base, entry.data);
            let base_id = last.as_ref().unwrap().0.as_bytes();
            let header_len = 1 + 4 + base_id.len() + 4 + 4;
            pack.push(1);
            pack.extend_from_slice(&(base_id.len() as u32).to_le_bytes());
            pack.extend_from_slice(base_id);
            pack.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
            pack.extend_from_slice(&(delta.len() as u32).to_le_bytes());
            let data_offset = offset + header_len;
            pack.extend_from_slice(&delta);
            records.push(Record {
                id: entry.id.to_string(),
                offset,
                data_offset,
                orig_len: entry.data.len() as u32,
                comp_len: 0,
                kind: 1,
                base_id: Some(last.as_ref().unwrap().0.clone()),
                delta_len: delta.len() as u32,
            });
            offset += header_len + delta.len();
        } else {
            let compressed = deflate_stored(entry.data);
            let id_bytes = entry.id.as_bytes();
            let header_len = 1 + 4 + id_bytes.len() + 4 + 4;
            pack.push(0);
            pack.extend_from_slice(&(id_bytes.len() as u32).to_le_bytes());
            pack.extend_from_slice(id_bytes);
            pack.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
            pack.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            let data_offset = offset + header_len;
            pack.extend_from_slice(&compressed);
            records.push(Record {
                id: entry.id.to_string(),
                offset,
                data_offset,
                orig_len: entry.data.len() as u32,
                comp_len: compressed.len() as u32,
                kind: 0,
                base_id: None,
                delta_len: 0,
            });
            offset += header_len + compressed.len();
        }
        last = Some((entry.id.to_string(), entry.data.to_vec()));
    }
    let idx = index_bytes(&records);
    (pack, idx)
}

pub struct Record {
    pub id: String,
    pub offset: usize,
    pub data_offset: usize,
    pub orig_len: u32,
    pub comp_len: u32,
    pub kind: u8,
    pub base_id: Option<String>,
    pub delta_len: u32,
}

/// The TS `writeBinaryIndex` layout: NDX1 + {version u32, count u32}
/// + per entry {idLen, id, offset, dataOffset, origLen, compLen, kind}
/// and, for kind 1, {deltaLen, baseLen, base} — matching the native
/// index reader's consumption (its parse is the standing witness).
fn index_bytes(records: &[Record]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"NDX1");
    out.extend_from_slice(&1u32.to_le_bytes()); // version
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for record in records {
        let id = record.id.as_bytes();
        out.extend_from_slice(&(id.len() as u32).to_le_bytes());
        out.extend_from_slice(id);
        out.extend_from_slice(&(record.offset as u32).to_le_bytes());
        out.extend_from_slice(&(record.data_offset as u32).to_le_bytes());
        out.extend_from_slice(&record.orig_len.to_le_bytes());
        out.extend_from_slice(&record.comp_len.to_le_bytes());
        out.push(record.kind);
        if record.kind == 1 {
            // Length first: the reader takes u32 as the BASE's length
            // (it must know where the id ends), then the base, then the
            // delta length — the native-index parse is the authority.
            let base = record.base_id.as_deref().unwrap_or("").as_bytes();
            out.extend_from_slice(&(base.len() as u32).to_le_bytes());
            out.extend_from_slice(base);
            out.extend_from_slice(&record.delta_len.to_le_bytes());
        }
    }
    out
}

/// A closed-form upper bound for `pack_frame`'s combined output: the
/// input plus per-entry framing (a stored zlib never expands beyond
/// `deflate_bound`, and headers are fixed-size per id).
pub fn frame_bound(input_total: usize, entries: usize, max_id_len: usize) -> usize {
    input_total
        + entries * (deflate_bound(input_total.max(1)) - input_total + 64 + max_id_len * 2 + 64)
            .max(0)
        + 4096
}

