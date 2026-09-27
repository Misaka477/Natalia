//! The Phase B acceptance-2 probe: the mmap'd index load against the
//! fs::read path it replaced, over a large synthetic index. Run with
//! `cargo run --release --example bench_load`; the numbers are recorded
//! in the phase's landing doc (an instrument, not a gate).

use std::ffi::CString;
use std::time::Instant;

fn write_index(count: usize) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"NDX1");
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for index in 0..count {
        let id = format!("obj:{:016x}", index);
        out.extend_from_slice(&(id.len() as u32).to_le_bytes());
        out.extend_from_slice(id.as_bytes());
        out.extend_from_slice(&((index * 64) as u32).to_le_bytes());
        out.extend_from_slice(&1024u32.to_le_bytes());
        out.extend_from_slice(&10u32.to_le_bytes());
        out.extend_from_slice(&4u32.to_le_bytes());
        out.push(0);
    }
    out
}

fn main() {
    let count = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(100_000);
    let bytes = write_index(count);
    let dir = std::env::temp_dir().join("ndx-bench");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bench.idx");
    std::fs::write(&path, &bytes).unwrap();
    let cpath = CString::new(path.to_str().unwrap()).unwrap();

    // The OLD path: a full read + the same parse.
    let started = Instant::now();
    let read = std::fs::read(&path).unwrap();
    let read_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let parsed_read = unsafe { super_like_parse(&read) };
    let parse_read_ms = started.elapsed().as_secs_f64() * 1000.0;

    // The NEW path: the mapping + the parse over the mapped bytes.
    let started = Instant::now();
    let handle = unsafe { natalia_index_native::native_index_load(cpath.as_ptr()) };
    let mmap_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(!handle.is_null(), "the mmap load must succeed");

    let mut out = natalia_index_native::NativeIndexEntry {
        offset: 0,
        data_offset: 0,
        orig_len: 0,
        comp_len: 0,
        kind: 0,
        delta_len: 0,
    };

    // The find's latency at scale: the linear scan was 0.181ms at 100k;
    // the sorted binary search answers the same question in microseconds.
    let probes = [count / 2, count - 1, 0, count / 4];
    let mut total_ns = 0u128;
    let mut hits = 0;
    for probe in probes {
        let cid = CString::new(format!("obj:{:016x}", probe)).unwrap();
        let started = Instant::now();
        let found = unsafe {
            natalia_index_native::native_index_find(handle, cid.as_ptr(), &mut out)
        };
        total_ns += started.elapsed().as_nanos();
        assert_eq!(found, 1);
        hits += 1;
    }
    println!("binary find ({hits}):   {} ns each (avg)", total_ns / probes.len() as u128);
    println!("entries:            {count}");
    println!("index bytes:        {}", bytes.len());
    println!(
        "old read:           {read_ms:.2} ms (copy) + {parse_read_ms:.2} ms parse = {:.2} ms",
        read_ms + parse_read_ms
    );
    println!("new mmap load:      {mmap_ms:.2} ms (entries: {parsed_read})");
    unsafe { natalia_index_native::native_index_free(handle) };
    std::fs::remove_file(&path).ok();
}

/// The example's mirror of the crate's private parse (crate-internal), so
/// the comparison pays the same walk on the read path.
unsafe fn super_like_parse(bytes: &[u8]) -> usize {
    if bytes.len() < 12 || &bytes[..4] != b"NDX1" {
        return 0;
    }
    u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize
}
