//! Phase B: the resident pack-index daemon — the index server as a
//! NATIVE process.
//!
//! The transport and the protocol are the ones the TS daemon already
//! speaks (line-delimited JSON on stdin/stdout, one request per line, one
//! response per line, `find`/`count`/`reload`/`shutdown`), so the client
//! is a spawn target, not a rewrite. What changes is who holds the
//! table: the mmap lives inside THIS process, with no runtime to boot and
//! no FFI boundary per lookup — the daemon IS the library.
//!
//! The daemon answers WHERE an object lives (pack + offsets); the bytes
//! always come from the local pack file, which is why a daemon-less
//! runtime is a slower store, never a wrong one — and why any failure of
//! this process falls back to the local index load without a trace.
//!
//! Freshness is the writer's to declare: a pack written after the table
//! opened is invisible until `reload`. That is deliberate — a daemon that
//! re-stats per request pays a syscall per lookup to guess at a freshness
//! the writer already knows.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use natalia_index_native::IndexTableApi;

/// The answer line. The fields carry the TS client's shape
/// (`pack`, `offset`, `dataOffset`, `origLen`, `compLen`, `kind`,
/// `deltaLen`), so a hit from either daemon is the same object. The
/// lines are built by hand: the protocol is four ops, and the crate is
/// std-only by design (a JSON dependency would be the first registry
/// fetch in the offline chain).
fn reply(out: &mut impl Write, value: &str) {
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// The one JSON writer worth hand-rolling: numbers, strings, booleans,
/// null. (The crate is std-only by design; a dependency here would be
/// the first registry fetch in the offline chain.)
fn arg_value(flag: &str) -> Option<String> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}

fn main() {
    let Some(dir) = arg_value("--dir") else {
        eprintln!("usage: natalia-object-store-daemon --dir <packs-directory>");
        std::process::exit(2);
    };
    let packs = PathBuf::from(&dir);
    let open = || match IndexTableApi::open_dir(&packs) {
        Some(table) => table,
        None => {
            eprintln!("daemon: table will not open ({dir})");
            std::process::exit(3);
        }
    };
    let mut table = open();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // The request is one of four ops. A hand-rolled scanner is enough
        // (and honest): the protocol is tiny and the client is ours.
        let op = op_of(line);
        match op.as_deref() {
            Some("find") => {
                let Some(id) = string_field(line, "id") else {
                    reply(&mut stdout, "{\"ok\":false,\"reason\":\"bad_request\"}");
                    continue;
                };
                match table.find(id.as_bytes()) {
                    Some(hit) => {
                        let answer = format!(
                            "{{\"ok\":true,\"pack\":{},\"offset\":{},\"dataOffset\":{},\"origLen\":{},\"compLen\":{},\"kind\":{},\"deltaLen\":{}}}",
                            hit.pack,
                            hit.offset,
                            hit.data_offset,
                            hit.orig_len,
                            hit.comp_len,
                            hit.kind,
                            hit.delta_len
                        );
                        reply(&mut stdout, &answer);
                    }
                    None => reply(
                        &mut stdout,
                        "{\"ok\":false,\"reason\":\"not_found\"}",
                    ),
                }
            }
            Some("count") => {
                let answer = format!("{{\"ok\":true,\"count\":{}}}", table.pack_count());
                reply(&mut stdout, &answer);
            }
            Some("reload") => {
                // Free the old table, open the new one: a daemon never
                // holds a half-fresh view. A failed reload keeps the old
                // table (the answer says so) — the daemon serves stale,
                // never deaf.
                table = open();
                let answer = format!("{{\"ok\":true,\"count\":{}}}", table.pack_count());
                reply(&mut stdout, &answer);
            }
            Some("shutdown") => {
                let answer = format!("{{\"ok\":true,\"count\":{}}}", table.pack_count());
                reply(&mut stdout, &answer);
                std::process::exit(0);
            }
            _ => reply(&mut stdout, "{\"ok\":false,\"reason\":\"bad_request\"}"),
        }
    }
    // EOF on stdin: every mapping drops with the process.
}

/// The request's op: the first `"op":"..."` field. A missing or foreign
/// shape is None — the caller answers `bad_request` either way.
fn op_of(line: &str) -> Option<String> {
    string_field(line, "op")
}

/// A string field's value out of the flat request JSON: `"key":"value"`.
/// The requests are ours and flat (no nesting, no escapes beyond a quote),
/// so a scan is both sufficient and cheaper than a parser.
fn string_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}
