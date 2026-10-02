/// Prefix cap for similarity scoring (keeps the LCS matrix bounded).
const SCORE_PREFIX_BYTES: usize = 4096;

/// Byte-cap for scoring inputs, ending on a CHAR boundary (a mid-character
/// slice panics — non-ASCII strings are real input here).
fn bounded_prefix(s: &str) -> &str {
    let mut end = s.len().min(SCORE_PREFIX_BYTES);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

use tree_sitter::{Node, Parser};

#[derive(Debug, Clone)]
pub struct AstChange {
    pub kind: u8, // 0 = modified, 1 = added, 2 = removed, 3 = moved/renamed
    pub node_kind: String,
    pub node_text: String,
    pub old_start: u32,
    pub old_end: u32,
    pub new_start: u32,
    pub new_end: u32,
}

fn node_text<'a>(node: Node, source: &'a str) -> &'a str {
    node.utf8_text(source.as_bytes()).unwrap_or("")
}

fn parse(language: &tree_sitter::Language, source: &str) -> Option<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser.set_language(language).ok()?;
    parser.parse(source, None)
}

#[derive(Debug, Clone)]
pub struct AstIndexNode {
    pub node_kind: String,
    pub text: String,
    pub start: u32,
    pub end: u32,
}

fn indexable_kind(kind: &str) -> bool {
    const MARKERS: &[&str] = &[
        "function",
        "method",
        "class",
        "interface",
        "struct",
        "enum",
        "type",
        "variable",
        "const",
        "let",
        "field",
        "property",
        "identifier",
        "import",
        "export",
        "module",
        "namespace",
        "call",
        "assignment",
        "definition",
    ];
    MARKERS.iter().any(|marker| kind.contains(marker)) || kind == "identifier"
}

fn collect_index(node: Node, source: &str, nodes: &mut Vec<AstIndexNode>) {
    if node.is_named() && indexable_kind(node.kind()) {
        let text = node_text(node, source);
        let text: String = text.chars().take(512).collect();
        nodes.push(AstIndexNode {
            node_kind: node.kind().to_string(),
            text,
            start: node.start_byte() as u32,
            end: node.end_byte() as u32,
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_index(child, source, nodes);
    }
}

pub fn index(language_id: &str, source: &str) -> Vec<AstIndexNode> {
    let Some(language) = crate::ast_langs::grammar(language_id) else {
        return Vec::new();
    };
    let Some(tree) = parse(&language, source) else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    collect_index(tree.root_node(), source, &mut nodes);
    nodes
}


fn add_change(
    changes: &mut Vec<AstChange>,
    kind: u8,
    node_kind: &str,
    old: Option<Node>,
    new: Option<Node>,
    old_source: &str,
    new_source: &str,
) {
    let old_text = old
        .map(|n| node_text(n, old_source).to_string())
        .unwrap_or_default();
    let new_text = new
        .map(|n| node_text(n, new_source).to_string())
        .unwrap_or_default();
    let text = if kind == 1 { new_text } else { old_text };
    changes.push(AstChange {
        kind,
        node_kind: node_kind.to_string(),
        node_text: text,
        old_start: old.map(|n| n.start_byte() as u32).unwrap_or(0),
        old_end: old.map(|n| n.end_byte() as u32).unwrap_or(0),
        new_start: new.map(|n| n.start_byte() as u32).unwrap_or(0),
        new_end: new.map(|n| n.end_byte() as u32).unwrap_or(0),
    });
}

fn node_match_score(
    old: Node,
    new: Node,
    old_source: &str,
    new_source: &str,
) -> f64 {
    if old.kind() != new.kind() || !old.is_named() || !new.is_named() {
        return 0.0;
    }
    let a = node_text(old, old_source);
    let b = node_text(new, new_source);
    if a == b {
        return 1.0;
    }
    let norm = text_similar_norm(a, b);
    let old_len = (old.end_byte() - old.start_byte()).max(1) as f64;
    let new_len = (new.end_byte() - new.start_byte()).max(1) as f64;
    let ratio = old_len / new_len;
    let size_bonus = if (0.7..=1.4).contains(&ratio) { 0.15 } else { 0.0 };
    (norm * 0.85 + size_bonus).min(1.0)
}

fn match_children<'a>(
    old_children: &[Node<'a>],
    new_children: &[Node<'a>],
    old_source: &'a str,
    new_source: &'a str,
) -> Vec<(usize, usize, Node<'a>, Node<'a>)> {
    let mut candidates = Vec::<(f64, usize, usize, Node, Node)>::new();
    for (i, old_child) in old_children.iter().enumerate() {
        if !old_child.is_named() { continue; }
        for (j, new_child) in new_children.iter().enumerate() {
            if !new_child.is_named() { continue; }
            let score = node_match_score(*old_child, *new_child, old_source, new_source);
            if score >= 0.45 {
                candidates.push((score, i, j, *old_child, *new_child));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut used_old = vec![false; old_children.len()];
    let mut used_new = vec![false; new_children.len()];
    let mut matched = Vec::new();
    for (_, i, j, old_child, new_child) in candidates {
        if used_old[i] || used_new[j] { continue; }
        used_old[i] = true;
        used_new[j] = true;
        matched.push((i, j, old_child, new_child));
    }
    matched
}

fn diff_nodes(
    old: Node,
    new: Node,
    old_source: &str,
    new_source: &str,
    changes: &mut Vec<AstChange>,
) {
    let old_text = node_text(old, old_source);
    let new_text = node_text(new, new_source);
    if old.kind() != new.kind() {
        add_change(changes, 0, old.kind(), Some(old), Some(new), old_source, new_source);
        return;
    }
    if old_text == new_text {
        return;
    }
    let mut old_cursor = old.walk();
    let mut new_cursor = new.walk();
    let old_children: Vec<_> = old.children(&mut old_cursor).collect();
    let new_children: Vec<_> = new.children(&mut new_cursor).collect();
    let n = old_children.len();
    let m = new_children.len();
    // Budget: the scoring matcher materializes every qualifying pair — on
    // 32-bit wasm a flat 8k-statement program (n*m = 64M candidates × ~56B)
    // overflowed Vec capacity outright (the bench crash). Huge child lists
    // take index pairing instead: linear, no candidate materialization.
    if n * m > 20_000 {
        let paired = n.min(m);
        for k in 0..paired {
            let old_child = old_children[k];
            let new_child = new_children[k];
            if old_child.is_named() && new_child.is_named() {
                diff_nodes(old_child, new_child, old_source, new_source, changes);
            }
        }
        for child in old_children.iter().skip(paired) {
            if child.is_named() {
                add_change(changes, 2, child.kind(), Some(*child), None, old_source, new_source);
            }
        }
        for child in new_children.iter().skip(paired) {
            if child.is_named() {
                add_change(changes, 1, child.kind(), None, Some(*child), old_source, new_source);
            }
        }
        if changes.is_empty() {
            add_change(changes, 0, old.kind(), Some(old), Some(new), old_source, new_source);
        }
        return;
    }
    let matched = match_children(&old_children, &new_children, old_source, new_source);
    let mut matched_old = vec![false; old_children.len()];
    let mut matched_new = vec![false; new_children.len()];
    for (i, j, _, _) in &matched {
        matched_old[*i] = true;
        matched_new[*j] = true;
    }
    for (i, j, old_child, new_child) in matched {
        let old_child_text = node_text(old_child, old_source);
        let new_child_text = node_text(new_child, new_source);
        if old_child_text == new_child_text && i != j {
            changes.push(AstChange {
                kind: 3,
                node_kind: old_child.kind().to_string(),
                node_text: new_child_text.to_string(),
                old_start: old_child.start_byte() as u32,
                old_end: old_child.end_byte() as u32,
                new_start: new_child.start_byte() as u32,
                new_end: new_child.end_byte() as u32,
            });
            continue;
        }
        diff_nodes(old_child, new_child, old_source, new_source, changes);
    }
    for (i, old_child) in old_children.iter().enumerate() {
        if !matched_old[i] && old_child.is_named() {
            add_change(changes, 2, old_child.kind(), Some(*old_child), None, old_source, new_source);
        }
    }
    for (j, new_child) in new_children.iter().enumerate() {
        if !matched_new[j] && new_child.is_named() {
            add_change(changes, 1, new_child.kind(), None, Some(*new_child), old_source, new_source);
        }
    }
    if changes.is_empty() {
        add_change(changes, 0, old.kind(), Some(old), Some(new), old_source, new_source);
    }
}

fn text_similar(a: &str, b: &str) -> f64 {
    // Cell budget: the LCS matrix is len² usize cells — two 50KB nodes
    // would ask for ~25G and overflow a 32-bit wasm outright. Score a
    // bounded prefix instead; beyond it the kind/length heuristics carry
    // the decision (they were already the tiebreakers).
    let a = bounded_prefix(a);
    let b = bounded_prefix(b);
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        return 0.0;
    }
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if a[i - 1] == b[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }
    dp[n][m] as f64 / n.max(m) as f64
}

fn text_similar_norm(a: &str, b: &str) -> f64 {
    // Cell budget: the LCS matrix is len² usize cells — two 50KB nodes
    // would ask for ~25G and overflow a 32-bit wasm outright. Score a
    // bounded prefix instead; beyond it the kind/length heuristics carry
    // the decision (they were already the tiebreakers).
    let a = bounded_prefix(a);
    let b = bounded_prefix(b);
    let a: Vec<char> = a.chars().filter(|c| !c.is_whitespace()).collect();
    let b: Vec<char> = b.chars().filter(|c| !c.is_whitespace()).collect();
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        return 0.0;
    }
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if a[i - 1] == b[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }
    dp[n][m] as f64 / n.max(m) as f64
}

/// Recursive AST diff. This is stronger than the first multiset skeleton and
/// will be extended with slider correction from difftastic next.
pub fn diff(language_id: &str, old_source: &str, new_source: &str) -> Vec<AstChange> {
    let Some(language) = crate::ast_langs::grammar(language_id) else {
        return Vec::new();
    };
    let Some(old_tree) = parse(&language, old_source) else {
        return Vec::new();
    };
    let Some(new_tree) = parse(&language, new_source) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    diff_nodes(
        old_tree.root_node(),
        new_tree.root_node(),
        old_source,
        new_source,
        &mut changes,
    );
    // Move/rename detection. We use a multi-pass matcher so moved blocks are
    // paired even when whitespace or small text differences are present:
    //   1) exact text match
    //   2) whitespace-normalized similarity
    //   3) original text similarity
    let mut i = 0;
    while i < changes.len() {
        if changes[i].kind != 2 {
            i += 1;
            continue;
        }
        let removed_kind = changes[i].node_kind.clone();
        let removed_len = changes[i].old_end - changes[i].old_start;
        let removed_old_start = changes[i].old_start;
        let removed_old_end = changes[i].old_end;
        let removed_text = changes[i].node_text.clone();
        let mut found = None;
        for (j, candidate) in changes.iter().enumerate().skip(i + 1) {
            if candidate.kind != 1 || candidate.node_kind != removed_kind {
                continue;
            }
            let added_len = candidate.new_end - candidate.new_start;
            let exact = candidate.node_text == removed_text;
            let norm = text_similar_norm(&removed_text, &candidate.node_text);
            let raw = text_similar(&removed_text, &candidate.node_text);
            if exact
                || (removed_text.len() <= 500
                    && candidate.node_text.len() <= 500
                    && norm >= 0.75)
                || (removed_text.len() <= 500
                    && candidate.node_text.len() <= 500
                    && raw >= 0.5
                    && (added_len as f64 / removed_len.max(1) as f64) >= 0.6
                    && (added_len as f64 / removed_len.max(1) as f64) <= 1.6)
            {
                found = Some(j);
                break;
            }
        }
        if let Some(j) = found {
            let added = changes.remove(j);
            changes[i] = AstChange {
                kind: 3,
                node_kind: removed_kind,
                node_text: added.node_text,
                old_start: removed_old_start,
                old_end: removed_old_end,
                new_start: added.new_start,
                new_end: added.new_end,
            };
            i += 1;
        } else {
            i += 1;
        }
    }
    changes
}
