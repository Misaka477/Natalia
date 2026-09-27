//! The store's GC as ONE call — `collectGarbage`'s tail, moved.
//!
//! The TS shape was: extend the reachable set through the metadata
//! (which stays TS — it owns the SQLite connection), delete the
//! unreachable loose objects, read every kept object's original bytes
//! (loose first, pack fallback), build the replacement pack, write it,
//! remove the old packs, reload. Every one of those steps is here now,
//! so a GC over a hundred thousand objects is one FFI call instead of a
//! per-object round trip.
//!
//! The keep ORDER is part of the contract: `pack_frame` builds its delta
//! chain over the order it is given, so the caller passes the same order
//! the TS did and the resulting pack bytes are identical (Phase D's
//! dual-run compares them byte for byte).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::packread::{load_pack_set, read_from_pack, Resolved};

pub struct GcOutcome {
    pub unreachable_objects: usize,
    pub bytes: u64,
    pub kept: usize,
    /// The new pack's file name (None when the keep set was empty and
    /// every pack was removed).
    pub pack_file: Option<String>,
    /// How many of the kept originals were read from packs rather than
    /// loose files — Phase D's dual-run compares this against the TS GC.
    pub from_packs: usize,
    /// The ids deleted from disk, in deletion order. The caller cleans
    /// the chunked manifests among them (SQLite is the TS's own).
    pub deleted: Vec<String>,
}

/// Every loose object id in the store: the two-hex-char shard walk. The
/// same shape `listLoose` walks — a name that does not start with its
/// shard prefix is not an object, and non-two-character entries (the
/// `.meta` directory, the packs directory) are skipped whole.
pub fn list_loose(root: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    let Ok(shards) = std::fs::read_dir(root) else {
        return ids;
    };
    let mut names: Vec<PathBuf> = shards
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.len() == 2 && name.bytes().all(|b| b.is_ascii_hexdigit()))
                .unwrap_or(false)
        })
        .collect();
    names.sort();
    for shard in names {
        let prefix = shard
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let Ok(entries) = std::fs::read_dir(&shard) else {
            continue;
        };
        let mut members: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(&prefix))
            .collect();
        members.sort();
        ids.extend(members);
    }
    ids
}

/// One object's path: `<root>/<id[:2]>/<id>`, the same layout the store
/// writes.
pub fn object_path(root: &Path, id: &str) -> PathBuf {
    root.join(&id[..2.min(id.len())]).join(id)
}

/// One object's bytes: the loose file first, then the pack set. The pack
/// read resolves ITS deltas through this same function one level down —
/// a delta's base may be a loose file, and its base's base packed, and
/// the chain is as deep as the pack is (the TS's read path recurses the
/// same way).
fn resolve_object(
    root: &Path,
    pack_files: &[(PathBuf, Vec<crate::packread::IndexRecord>)],
    id: &str,
) -> Result<Resolved, String> {
    let path = object_path(root, id);
    if let Ok(data) = std::fs::read(&path) {
        return Ok(Resolved {
            data,
            from_pack: false,
        });
    }
    read_from_pack(pack_files, id, &|base_id| {
        resolve_object(root, pack_files, base_id)
    })
}

/// The GC. `keep` is the caller's extended reachable set, in the order
/// the replacement pack should carry (the TS passes its Set's insertion
/// order, which is what `pack_frame` was fed before this module existed).
pub fn gc(root: &Path, keep: &[String]) -> Result<GcOutcome, String> {
    let keep_set: HashSet<&str> = keep.iter().map(String::as_str).collect();
    let loose = list_loose(root);

    // 1. The unreachable loose objects: their bytes are accounted and the
    //    files go. Objects that live inside packs are dropped by the
    //    rebuild below (they are simply not carried into the new pack).
    let mut unreachable_objects = 0usize;
    let mut bytes = 0u64;
    let mut deleted: Vec<String> = Vec::new();
    for id in &loose {
        if keep_set.contains(id.as_str()) {
            continue;
        }
        let path = object_path(root, id);
        match std::fs::metadata(&path) {
            Ok(meta) => bytes += meta.len(),
            Err(_) => continue,
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                unreachable_objects += 1;
                deleted.push(id.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot remove {}: {error}", path.display())),
        }
    }

    let packs_dir = root.join("packs");
    let old_pack_files: Vec<PathBuf> = list_pack_files(&packs_dir);

    // 2. Nothing to keep: every pack and index goes, and there is no
    //    replacement. (An empty store is a valid state, not an error.)
    if keep.is_empty() {
        for file in &old_pack_files {
            let _ = std::fs::remove_file(file);
        }
        for file in list_index_files(&packs_dir) {
            let _ = std::fs::remove_file(file);
        }
        return Ok(GcOutcome {
            unreachable_objects,
            bytes,
            kept: 0,
            pack_file: None,
            from_packs: 0,
            deleted,
        });
    }

    // 3. Every kept object's ORIGINAL bytes, in the keep order: the loose
    //    file first, then the pack set (delta chains resolved against the
    //    same rule one level down — a base may be loose, a base's base
    //    packed).
    let pack_files = load_pack_set(&packs_dir);
    // THE INCREMENTAL RULE: a pack whose every object is kept SURVIVES
    // whole — its bytes are already on disk in the format every reader
    // speaks, so re-reading and re-writing them is pure waste. The
    // full-rebuild shape read every reachable byte (a gigabyte of live
    // chunked data to collect a megabyte of garbage); this skips it.
    let mut survivors: Vec<PathBuf> = Vec::new();
    let mut surviving_ids: HashSet<&str> = HashSet::new();
    for (pack_path, records) in &pack_files {
        if records
            .iter()
            .all(|record| keep_set.contains(record.id.as_str()))
        {
            survivors.push(pack_path.clone());
            for record in records {
                surviving_ids.insert(record.id.as_str());
            }
        }
    }
    // What still needs a home: the kept ids no surviving pack carries.
    // Everything else is either loose already or rides a survivor.
    let mut originals: Vec<(&str, Vec<u8>)> = Vec::with_capacity(keep.len());
    let mut from_packs = 0usize;
    for id in keep {
        if surviving_ids.contains(id.as_str()) {
            continue;
        }
        let resolved = resolve_object(root, &pack_files, id)?;
        from_packs += usize::from(resolved.from_pack);
        originals.push((id.as_str(), resolved.data));
    }

    // 4. The replacement pack: frame first, then write pack-then-index
    //    (the index IS the commit — a pack without one is ignored), and
    //    only then do the old files go.
    // Nothing to re-pack: the survivors carry every kept object, and the
    // dead packs (the ones that held an unreachable byte) retire. No new
    // pack is written, so the store's pack set only shrinks.
    if originals.is_empty() {
        for file in &old_pack_files {
            if survivors.contains(file) {
                continue;
            }
            let _ = std::fs::remove_file(file);
        }
        for file in list_index_files(&packs_dir) {
            let survives = survivors
                .iter()
                .any(|pack| pack.with_extension("idx") == file);
            if !survives {
                let _ = std::fs::remove_file(file);
            }
        }
        return Ok(GcOutcome {
            unreachable_objects,
            bytes,
            kept: keep.len(),
            pack_file: None,
            from_packs,
            deleted,
        });
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let pack_name = format!("pack-{stamp:x}.pack");
    let pack_path = packs_dir.join(&pack_name);
    let index_path = packs_dir.join(pack_name.replace(".pack", ".idx"));
    let entries: Vec<crate::pack::PackEntry> = originals
        .iter()
        .map(|(id, data)| crate::pack::PackEntry { id, data })
        .collect();
    let (frame_pack, frame_index) = crate::pack::pack_frame(&entries);
    if let Err(error) = std::fs::create_dir_all(&packs_dir) {
        return Err(format!("cannot create {}: {error}", packs_dir.display()));
    }
    if let Err(error) = std::fs::write(&pack_path, &frame_pack) {
        return Err(format!("cannot write {}: {error}", pack_path.display()));
    }
    if let Err(error) = std::fs::write(&index_path, &frame_index) {
        let _ = std::fs::remove_file(&pack_path);
        return Err(format!("cannot write {}: {error}", index_path.display()));
    }
    for file in &old_pack_files {
        if file == &pack_path || survivors.contains(file) {
            continue;
        }
        let _ = std::fs::remove_file(file);
    }
    for file in list_index_files(&packs_dir) {
        if file == index_path {
            continue;
        }
        let survives = survivors
            .iter()
            .any(|pack| pack.with_extension("idx") == file);
        if survives {
            continue;
        }
        let _ = std::fs::remove_file(file);
    }

    Ok(GcOutcome {
        unreachable_objects,
        bytes,
        kept: originals.len(),
        pack_file: Some(pack_name),
        from_packs,
        deleted,
    })
}

/// The pack files in a directory, sorted — the set the rebuild removes
/// after its replacement is committed.
fn list_pack_files(packs_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(packs_dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("pack"))
        .collect();
    out.sort();
    out
}

/// The index files in a directory, sorted — the other half of the commit
/// pair, removed with their packs.
fn list_index_files(packs_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(packs_dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("idx"))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::deflate_stored;
    use std::fs;

    fn id_of(data: &[u8]) -> String {
        let hash = crate::sha256_hex(data);
        hash
    }

    fn put_loose(root: &Path, data: &[u8]) -> String {
        let id = id_of(data);
        let path = object_path(root, &id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, data).unwrap();
        id
    }

    #[test]
    fn gc_deletes_the_unreachable_and_keeps_the_rest() {
        let root = std::env::temp_dir().join(format!("gc-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let keep = put_loose(&root, b"keep me");
        let drop = put_loose(&root, b"drop me");
        let outcome = gc(&root, &[keep.clone()]).unwrap();
        assert_eq!(outcome.unreachable_objects, 1);
        assert_eq!(outcome.deleted, vec![drop.clone()]);
        assert_eq!(outcome.kept, 1);
        assert!(fs::metadata(object_path(&root, &keep)).is_ok());
        assert!(fs::metadata(object_path(&root, &drop)).is_err());
        // The rebuild packed the survivor, and the object still reads back.
        let pack_files = load_pack_set(&root.join("packs"));
        assert_eq!(pack_files.len(), 1);
        let resolved = resolve_object(&root, &pack_files, &keep).unwrap();
        assert_eq!(resolved.data, b"keep me");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_reads_a_packed_original_and_its_delta_chain() {
        let root = std::env::temp_dir().join(format!("gc-pack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let packs = root.join("packs");
        fs::create_dir_all(&packs).unwrap();
        // A pack with two similar objects: the second is a delta of the first.
        let a = b"the shared prefix that makes a delta worthwhile".repeat(4);
        let mut b = a.clone();
        b.extend_from_slice(b" and a different tail");
        let (pack, index) = crate::pack::pack_frame(&[
            crate::pack::PackEntry { id: &id_of(&a), data: &a },
            crate::pack::PackEntry { id: &id_of(&b), data: &b },
        ]);
        fs::write(packs.join("pack-test.pack"), &pack).unwrap();
        fs::write(packs.join("pack-test.idx"), &index).unwrap();
        let pack_files = load_pack_set(&packs);
        let first = resolve_object(&root, &pack_files, &id_of(&a)).unwrap();
        assert_eq!(first.data, a);
        assert!(first.from_pack);
        let second = resolve_object(&root, &pack_files, &id_of(&b)).unwrap();
        assert_eq!(second.data, b);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_pack_whose_every_object_is_kept_survives_the_rebuild() {
        let root = std::env::temp_dir().join(format!("gc-survivor-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let packs = root.join("packs");
        fs::create_dir_all(&packs).unwrap();
        let a = b"survivor-alpha".repeat(8);
        let b = b"survivor-beta".repeat(8);
        let (pack, index) = crate::pack::pack_frame(&[
            crate::pack::PackEntry { id: &id_of(&a), data: &a },
            crate::pack::PackEntry { id: &id_of(&b), data: &b },
        ]);
        let pack_path = packs.join("pack-survivor.pack");
        fs::write(&pack_path, &pack).unwrap();
        fs::write(packs.join("pack-survivor.idx"), &index).unwrap();
        let stamp_before = fs::metadata(&pack_path).unwrap().modified().unwrap();
        // A second pack holding one dead object: it retires, and the
        // survivor's objects are not re-written into a replacement.
        let dead = b"gone".repeat(8);
        let (dead_pack, dead_index) = crate::pack::pack_frame(&[
            crate::pack::PackEntry { id: &id_of(&dead), data: &dead },
        ]);
        fs::write(packs.join("pack-dead.pack"), &dead_pack).unwrap();
        fs::write(packs.join("pack-dead.idx"), &dead_index).unwrap();

        let outcome = gc(&root, &[id_of(&a), id_of(&b)]).unwrap();
        // No new pack: the survivor carries everything kept.
        assert!(outcome.pack_file.is_none());
        assert!(pack_path.exists(), "the survivor pack stays");
        assert!(!packs.join("pack-dead.pack").exists(), "the dead pack retires");
        assert!(!packs.join("pack-dead.idx").exists(), "and its index");
        let stamp_after = fs::metadata(&pack_path).unwrap().modified().unwrap();
        assert_eq!(stamp_before, stamp_after, "the survivor was not rewritten");
        // And the reads are intact through the survivor.
        let pack_files = load_pack_set(&packs);
        assert_eq!(resolve_object(&root, &pack_files, &id_of(&a)).unwrap().data, a);
        assert_eq!(resolve_object(&root, &pack_files, &id_of(&b)).unwrap().data, b);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_pack_with_one_unreachable_object_is_rebuilt_not_survived() {
        let root = std::env::temp_dir().join(format!("gc-partial-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let packs = root.join("packs");
        fs::create_dir_all(&packs).unwrap();
        let a = b"partial-alpha".repeat(8);
        let dead = b"partial-dead".repeat(8);
        let (pack, index) = crate::pack::pack_frame(&[
            crate::pack::PackEntry { id: &id_of(&a), data: &a },
            crate::pack::PackEntry { id: &id_of(&dead), data: &dead },
        ]);
        fs::write(packs.join("pack-mixed.pack"), &pack).unwrap();
        fs::write(packs.join("pack-mixed.idx"), &index).unwrap();

        let outcome = gc(&root, &[id_of(&a)]).unwrap();
        // A replacement WAS written (the survivor rule could not apply),
        // the mixed pack retired, and only the kept object reads back.
        assert!(outcome.pack_file.is_some());
        assert!(!packs.join("pack-mixed.pack").exists());
        assert_eq!(outcome.kept, 1);
        let pack_files = load_pack_set(&packs);
        assert_eq!(pack_files.len(), 1);
        assert_eq!(resolve_object(&root, &pack_files, &id_of(&a)).unwrap().data, a);
        assert!(resolve_object(&root, &pack_files, &id_of(&dead)).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_with_an_empty_keep_set_removes_every_pack() {
        let root = std::env::temp_dir().join(format!("gc-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        put_loose(&root, b"gone");
        let packs = root.join("packs");
        fs::create_dir_all(&packs).unwrap();
        fs::write(packs.join("pack-old.pack"), b"NPAC\x01").unwrap();
        fs::write(packs.join("pack-old.idx"), b"NDX1").unwrap();
        let outcome = gc(&root, &[]).unwrap();
        assert_eq!(outcome.unreachable_objects, 1);
        assert!(outcome.pack_file.is_none());
        assert!(!packs.join("pack-old.pack").exists());
        assert!(!packs.join("pack-old.idx").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_keep_id_that_exists_nowhere_is_an_error_not_a_silent_skip() {
        let root = std::env::temp_dir().join(format!("gc-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let missing = "a".repeat(64);
        assert!(gc(&root, &[missing]).is_err());
        let _ = fs::remove_dir_all(&root);
    }

}
