use imara_diff::{Algorithm, BasicLineDiffPrinter, Diff, InternedInput, UnifiedDiffConfig};
use std::alloc::{alloc, dealloc, Layout};
use std::ptr;
use std::slice;


const WORD_RANGE_LINE_BUDGET: u32 = 2000;
const DIFF_CONTEXT_LINES: u32 = 3;


#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    let layout = Layout::from_size_align(len.max(1), 1).unwrap();
    unsafe { alloc(layout) }
}

#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let layout = Layout::from_size_align(len.max(1), 1).unwrap();
    unsafe { dealloc(ptr, layout) }
}

fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(ptr, len) }
    }
}

#[no_mangle]
pub unsafe extern "C" fn wasm_diff(
    old_ptr: *const u8,
    old_len: usize,
    new_ptr: *const u8,
    new_len: usize,
    out_len_ptr: *mut usize,
) -> *const u8 {
    let old_bytes = bytes(old_ptr, old_len);
    let new_bytes = bytes(new_ptr, new_len);
    let old_text = String::from_utf8_lossy(old_bytes);
    let new_text = String::from_utf8_lossy(new_bytes);
    let input = InternedInput::new(old_text.as_ref(), new_text.as_ref());
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    let config = UnifiedDiffConfig::default();
    let printer = BasicLineDiffPrinter(&input.interner);
    let body: String = diff.unified_diff(&printer, config, &input).to_string();
    let out = body.into_bytes();
    write_output(&out, out_len_ptr)
}

fn write_output(out: &[u8], out_len_ptr: *mut usize) -> *const u8 {
    let len = out.len();
    let ptr = wasm_alloc(len);
    if !ptr.is_null() {
        unsafe { ptr::copy_nonoverlapping(out.as_ptr(), ptr, len) };
    }
    if !out_len_ptr.is_null() {
        unsafe { *out_len_ptr = len };
    }
    ptr
}

const LINE_NONE: u32 = u32::MAX;
const WORD_RANGE_RECORD_SIZE: usize = 16;

#[repr(C)]
struct HunkMeta {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
    line_count: u32,
}

#[derive(Clone, Copy)]
struct LineItem {
    kind: u32,
    old_line: u32,
    new_line: u32,
}

#[derive(Clone, Copy)]
struct WordRange {
    line_index: u32,
    kind: u8,
    start: u32,
    end: u32,
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_line(
    out: &mut Vec<u8>,
    kind: u32,
    old_line: u32,
    new_line: u32,
    text: &str,
    texts: &mut Vec<u8>,
) {
    push_u32(out, kind);
    push_u32(out, old_line);
    push_u32(out, new_line);
    push_u32(out, texts.len() as u32);
    let text_bytes = text.as_bytes();
    push_u32(out, text_bytes.len() as u32);
    texts.extend_from_slice(text_bytes);
}

fn old_new_start(start: u32, count: u32) -> u32 {
    if count == 0 {
        start
    } else {
        start + 1
    }
}

#[derive(Clone, Copy)]
struct Token {
    utf16_start: u32,
    utf16_end: u32,
    byte_start: usize,
    byte_end: usize,
    is_word: bool,
}

fn tokenize_line(line: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut utf16 = 0u32;
    let mut word_start: Option<(u32, usize)> = None; // (utf16_start, byte_start)
    let mut bytes_iter = line.char_indices().peekable();
    while let Some((byte, ch)) = bytes_iter.next() {
        let len_utf16 = ch.len_utf16() as u32;
        if ch.is_alphanumeric() || ch == '_' {
            if word_start.is_none() {
                word_start = Some((utf16, byte));
            }
        } else {
            if let Some((start_utf16, start_byte)) = word_start.take() {
                tokens.push(Token {
                    utf16_start: start_utf16,
                    utf16_end: utf16,
                    byte_start: start_byte,
                    byte_end: byte,
                    is_word: true,
                });
            }
            tokens.push(Token {
                utf16_start: utf16,
                utf16_end: utf16 + len_utf16,
                byte_start: byte,
                byte_end: byte + ch.len_utf8(),
                is_word: false,
            });
        }
        utf16 += len_utf16;
    }
    if let Some((start_utf16, _start_byte)) = word_start.take() {
        tokens.push(Token {
            utf16_start: start_utf16,
            utf16_end: utf16,
            byte_start: _start_byte,
            byte_end: line.len(),
            is_word: true,
        });
    }
    tokens
}

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    starts.extend(text.match_indices('\n').map(|(idx, _)| idx + 1));
    starts
}

fn line_at<'a>(starts: &[usize], text: &'a str, line_number: u32) -> &'a str {
    if line_number == 0 {
        return "";
    }
    let idx = line_number as usize - 1;
    let Some(&start) = starts.get(idx) else {
        return "";
    };
    let end = match starts.get(idx + 1) {
        Some(&next) => next - 1, // drop the newline
        None => text.len(),
    };
    if start > end {
        return "";
    }
    &text[start..end]
}

/// Returns (deleted_ranges, added_ranges) for a single modified line pair.
fn word_ranges_for_pair(
    old_line: &str,
    new_line: &str,
    ignore_whitespace: bool,
) -> (Vec<(u32, u32)>, Vec<(u32, u32)>) {
    let a = tokenize_line(old_line);
    let b = tokenize_line(new_line);
    let n = a.len();
    let m = b.len();
    // dp[i][j] = minimal cost to align a[0..i] with b[0..j]
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 0..=n {
        dp[i][0] = i * 2;
    }
    for j in 0..=m {
        dp[0][j] = j * 2;
    }
    for i in 1..=n {
        for j in 1..=m {
            let (a_tok, b_tok) = (&a[i - 1], &b[j - 1]);
            if a_tok.byte_start + (a_tok.byte_end - a_tok.byte_start)
                == b_tok.byte_start + (b_tok.byte_end - b_tok.byte_start)
                && old_line[a_tok.byte_start..a_tok.byte_end]
                    == new_line[b_tok.byte_start..b_tok.byte_end]
            {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                let del = dp[i - 1][j] + 2;
                let ins = dp[i][j - 1] + 2;
                // Prefer grouping changes: extra penalty when starting a new
                // run is approximated by ordering deletions/insertions first.
                dp[i][j] = del.min(ins);
            }
        }
    }
    // Backtrack.
    let mut deleted = Vec::<Token>::new();
    let mut added = Vec::<Token>::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        if i > 0 && j > 0
            && old_line[a[i - 1].byte_start..a[i - 1].byte_end]
                == new_line[b[j - 1].byte_start..b[j - 1].byte_end]
        {
            i -= 1;
            j -= 1;
        } else if i > 0 && (j == 0 || dp[i - 1][j] + 2 <= dp[i][j - 1] + 2) {
            let tok = a[i - 1];
            deleted.push(tok);
            i -= 1;
        } else {
            let tok = b[j - 1];
            added.push(tok);
            j -= 1;
        }
    }
    deleted.reverse();
    added.reverse();
    if ignore_whitespace {
        deleted.retain(|tok| !old_line[tok.byte_start..tok.byte_end].trim().is_empty());
        added.retain(|tok| !new_line[tok.byte_start..tok.byte_end].trim().is_empty());
    }
    let mut deleted_ranges = deleted
        .iter()
        .map(|tok| (tok.utf16_start, tok.utf16_end))
        .collect::<Vec<_>>();
    let mut added_ranges = added
        .iter()
        .map(|tok| (tok.utf16_start, tok.utf16_end))
        .collect::<Vec<_>>();
    coalesce(&mut deleted_ranges);
    coalesce(&mut added_ranges);
    (deleted_ranges, added_ranges)
}

fn coalesce(ranges: &mut Vec<(u32, u32)>) {
    if ranges.is_empty() {
        return;
    }
    ranges.sort_by_key(|(s, _)| *s);
    let mut merged: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
    for &(start, end) in ranges.iter() {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    *ranges = merged;
}

unsafe fn build_structured_binary(
    old_bytes: &[u8],
    new_bytes: &[u8],
    old_text: &str,
    new_text: &str,
    ignore_whitespace: bool,
) -> Vec<u8> {
    let input = InternedInput::new(old_text, new_text);
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    let enable_word_ranges =
        diff.count_additions() + diff.count_removals() <= WORD_RANGE_LINE_BUDGET;

    let old_starts = line_starts(old_text);
    let new_starts = line_starts(new_text);
    let mut line_records = Vec::<u8>::new();
    let mut texts = Vec::<u8>::new();
    let mut line_items = Vec::<LineItem>::new();
    let mut hunk_metas = Vec::<HunkMeta>::new();
    let mut word_ranges = Vec::<WordRange>::new();
    let mut old_i: u32 = 0;
    let mut new_i: u32 = 0;

    for hunk in diff.hunks() {
        let before_start = hunk.before.start as u32;
        let before_end = hunk.before.end as u32;
        let after_start = hunk.after.start as u32;
        let after_end = hunk.after.end as u32;
        let mut hunk_line_count: u32 = 0;
        let mut remove_indexes = Vec::<u32>::new();
        let mut add_indexes = Vec::<u32>::new();

        // Context before this hunk, limited to a small window.
        let context_before = before_start.saturating_sub(DIFF_CONTEXT_LINES);
        let context_before_new = after_start.saturating_sub(DIFF_CONTEXT_LINES);
        old_i = old_i.max(context_before);
        new_i = new_i.max(context_before_new);
        while old_i < before_start && new_i < after_start {
            let text = line_at(&old_starts, old_text, old_i + 1);
            push_line(&mut line_records, 0, old_i + 1, new_i + 1, text, &mut texts);
            line_items.push(LineItem { kind: 0, old_line: old_i + 1, new_line: new_i + 1 });
            hunk_line_count += 1;
            old_i += 1;
            new_i += 1;
        }

        // Removed lines.
        for line in hunk.before.clone() {
            let line_no = line + 1;
            let idx = line_items.len() as u32;
            let text = line_at(&old_starts, old_text, line_no);
            push_line(&mut line_records, 2, line_no, LINE_NONE, text, &mut texts);
            line_items.push(LineItem { kind: 2, old_line: line_no, new_line: LINE_NONE });
            remove_indexes.push(idx);
            hunk_line_count += 1;
        }

        // Added lines.
        for line in hunk.after.clone() {
            let line_no = line + 1;
            let idx = line_items.len() as u32;
            let text = line_at(&new_starts, new_text, line_no);
            push_line(&mut line_records, 1, LINE_NONE, line_no, text, &mut texts);
            line_items.push(LineItem { kind: 1, old_line: LINE_NONE, new_line: line_no });
            add_indexes.push(idx);
            hunk_line_count += 1;
        }

        // Word-level highlighting for paired delete/add lines. Skipped for very
        // large diffs to keep structured diff generation fast; line-level output
        // remains exact.
        if enable_word_ranges {
        for pair in 0..remove_indexes.len().min(add_indexes.len()) {
            let old_idx = remove_indexes[pair];
            let new_idx = add_indexes[pair];
            let old_line_no = line_items[old_idx as usize].old_line;
            let new_line_no = line_items[new_idx as usize].new_line;
            let old_line_text = line_at(&old_starts, old_text, old_line_no);
            let new_line_text = line_at(&new_starts, new_text, new_line_no);
            let (mut deleted, mut added) =
                word_ranges_for_pair(old_line_text, new_line_text, ignore_whitespace);
            for (start, end) in deleted {
                word_ranges.push(WordRange { line_index: old_idx, kind: 0, start, end });
            }
            for (start, end) in added {
                word_ranges.push(WordRange { line_index: new_idx, kind: 1, start, end });
            }
        }
        }

        hunk_metas.push(HunkMeta {
            old_start: old_new_start(before_start, hunk.before.len() as u32),
            old_count: before_end - before_start,
            new_start: old_new_start(after_start, hunk.after.len() as u32),
            new_count: after_end - after_start,
            line_count: hunk_line_count,
        });

        old_i = before_end;
        new_i = after_end;
    }

    // Trailing context after the final hunk, limited to the window.
    let tail_end_old = (old_i + DIFF_CONTEXT_LINES).min(input.before.len() as u32);
    let tail_end_new = (new_i + DIFF_CONTEXT_LINES).min(input.after.len() as u32);
    while old_i < tail_end_old && new_i < tail_end_new {
        let text = line_at(&old_starts, old_text, old_i + 1);
        push_line(&mut line_records, 0, old_i + 1, new_i + 1, text, &mut texts);
        line_items.push(LineItem { kind: 0, old_line: old_i + 1, new_line: new_i + 1 });
        old_i += 1;
        new_i += 1;
    }

    let hunk_count = hunk_metas.len() as u32;
    let line_count = line_records.len() as u32 / 20;
    let word_range_count = word_ranges.len() as u32;
    let line_ops_offset: u32 = 48 + hunk_count * 20;
    let texts_offset = line_ops_offset + line_count * 20;
    let word_ranges_offset = texts_offset + texts.len() as u32;

    let mut out = Vec::<u8>::with_capacity(
        48 + hunk_metas.len() * 20
            + line_records.len()
            + texts.len()
            + word_ranges.len() * WORD_RANGE_RECORD_SIZE,
    );

    // Header (12 u32)
    push_u32(&mut out, 0x4e444946); // "NDIF"
    push_u32(&mut out, 2);
    push_u32(&mut out, hunk_count);
    push_u32(&mut out, line_count);
    push_u32(&mut out, diff.count_additions());
    push_u32(&mut out, diff.count_removals());
    push_u32(&mut out, word_range_count);
    push_u32(&mut out, line_ops_offset);
    push_u32(&mut out, texts_offset);
    push_u32(&mut out, texts.len() as u32);
    push_u32(&mut out, word_ranges_offset);
    push_u32(&mut out, 0);

    for meta in &hunk_metas {
        push_u32(&mut out, meta.old_start);
        push_u32(&mut out, meta.old_count);
        push_u32(&mut out, meta.new_start);
        push_u32(&mut out, meta.new_count);
        push_u32(&mut out, meta.line_count);
    }

    out.extend_from_slice(&line_records);
    out.extend_from_slice(&texts);

    for word_range in &word_ranges {
        push_u32(&mut out, word_range.line_index);
        out.push(word_range.kind);
        push_u32(&mut out, word_range.start);
        push_u32(&mut out, word_range.end);
        out.extend_from_slice(&[0, 0, 0]);
    }
    out
}

#[no_mangle]
pub unsafe extern "C" fn wasm_diff_structured(
    old_ptr: *const u8,
    old_len: usize,
    new_ptr: *const u8,
    new_len: usize,
    ignore_whitespace: u32,
    out_len_ptr: *mut usize,
) -> *const u8 {
    let old_bytes = bytes(old_ptr, old_len);
    let new_bytes = bytes(new_ptr, new_len);
    let old_text = String::from_utf8_lossy(old_bytes);
    let new_text = String::from_utf8_lossy(new_bytes);
    let out = build_structured_binary(
        old_bytes,
        new_bytes,
        old_text.as_ref(),
        new_text.as_ref(),
        ignore_whitespace != 0,
    );
    write_output(&out, out_len_ptr)
}
