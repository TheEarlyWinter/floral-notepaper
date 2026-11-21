use crate::services::notes::{AppError, Note, NoteStore};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const DEFAULT_RELATED_LIMIT: usize = 5;
const TITLE_TERM_WEIGHT: usize = 3;
const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
const MAX_MATCHED_TERMS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelatedNoteSuggestion {
    pub id: String,
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    pub score: f64,
    pub matched_terms: Vec<String>,
    pub already_linked: bool,
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{3040}'..='\u{30FF}' // Hiragana & Katakana
            | '\u{3400}'..='\u{4DBF}' // CJK Unified Ideographs Extension A
            | '\u{4E00}'..='\u{9FFF}' // CJK Unified Ideographs
            | '\u{AC00}'..='\u{D7AF}' // Hangul Syllables
            | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
            | '\u{20000}'..='\u{2EBEF}' // CJK Extensions B-F
    )
}

fn is_english_stopword(word: &str) -> bool {
    matches!(
        word,
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "but"
            | "by"
            | "did"
            | "do"
            | "does"
            | "for"
            | "from"
            | "had"
            | "has"
            | "have"
            | "if"
            | "in"
            | "into"
            | "is"
            | "it"
            | "its"
            | "of"
            | "on"
            | "or"
            | "that"
            | "the"
            | "their"
            | "them"
            | "there"
            | "these"
            | "this"
            | "those"
            | "to"
            | "was"
            | "were"
            | "with"
    )
}

fn is_cjk_single_stopword(ch: char) -> bool {
    matches!(
        ch,
        '的' | '了'
            | '在'
            | '是'
            | '我'
            | '有'
            | '和'
            | '与'
            | '或'
            | '及'
            | '就'
            | '不'
            | '人'
            | '都'
            | '一'
            | '上'
            | '下'
            | '也'
            | '很'
            | '到'
            | '说'
            | '要'
            | '去'
            | '你'
            | '他'
            | '她'
            | '它'
            | '会'
            | '着'
            | '过'
            | '看'
            | '好'
            | '这'
            | '那'
            | '吗'
            | '呢'
            | '吧'
            | '啊'
    )
}

fn is_cjk_token(token: &str) -> bool {
    token.chars().any(is_cjk_char)
}

/// Strip wiki-link target IDs (`[[note:uuid|Label]]` -> `Label`) and image asset
/// paths (`images/<note_id>/<uuid>.ext`) so internal IDs do not create spurious matches.
fn clean_markdown_for_tokens(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(open_idx) = rest.find("[[") {
        output.push_str(&rest[..open_idx]);
        let after_open = &rest[open_idx + 2..];
        if let Some(close_idx) = after_open.find("]]") {
            let inner = after_open[..close_idx].trim();
            if let Some(pipe_idx) = inner.find('|') {
                let target = inner[..pipe_idx].trim();
                let label = inner[pipe_idx + 1..].trim();
                if target.starts_with("note:") {
                    output.push(' ');
                    output.push_str(label);
                    output.push(' ');
                } else {
                    output.push(' ');
                    output.push_str(target);
                    output.push(' ');
                    output.push_str(label);
                    output.push(' ');
                }
            } else if !inner.starts_with("note:") {
                output.push(' ');
                output.push_str(inner);
                output.push(' ');
            }
            rest = &after_open[close_idx + 2..];
        } else {
            output.push_str("[[");
            rest = after_open;
        }
    }
    output.push_str(rest);
    output
}

fn flush_word_run(run: &mut String, out: &mut Vec<String>) {
    if run.is_empty() {
        return;
    }
    let lowered = run.to_lowercase();
    run.clear();
    if lowered.chars().count() == 1 && lowered.chars().all(|ch| ch.is_ascii_digit()) {
        return;
    }
    if !is_english_stopword(&lowered) {
        out.push(lowered);
    }
}

fn flush_cjk_run(run: &mut Vec<char>, out: &mut Vec<String>) {
    if run.is_empty() {
        return;
    }
    if run.len() == 1 {
        let ch = run[0];
        if !is_cjk_single_stopword(ch) {
            out.push(ch.to_string());
        }
        run.clear();
        return;
    }

    for window in run.windows(2) {
        let bigram: String = window.iter().collect();
        out.push(bigram);
    }
    for window in run.windows(3) {
        let trigram: String = window.iter().collect();
        out.push(trigram);
    }
    run.clear();
}

/// Tokenize text into lowercase ASCII/Unicode words and CJK character bigrams/trigrams.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let cleaned = clean_markdown_for_tokens(text);
    let mut tokens = Vec::new();
    let mut word_run = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    for ch in cleaned.chars() {
        if is_cjk_char(ch) {
            flush_word_run(&mut word_run, &mut tokens);
            cjk_run.push(ch);
        } else if ch.is_alphanumeric() {
            flush_cjk_run(&mut cjk_run, &mut tokens);
            word_run.push(ch);
        } else {
            flush_word_run(&mut word_run, &mut tokens);
            flush_cjk_run(&mut cjk_run, &mut tokens);
        }
    }

    flush_word_run(&mut word_run, &mut tokens);
    flush_cjk_run(&mut cjk_run, &mut tokens);
    tokens
}

fn extract_wiki_link_targets(content: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut rest = content;

    while let Some(open_idx) = rest.find("[[") {
        let after_open = &rest[open_idx + 2..];
        let Some(close_idx) = after_open.find("]]") else {
            break;
        };
        let candidate_raw = &after_open[..close_idx];
        if let Some(single_close) = candidate_raw.find(']') {
            rest = &after_open[single_close + 1..];
            continue;
        }
        let raw = candidate_raw.trim();
        if !raw.is_empty() {
            let (target, label) = match raw.find('|') {
                Some(sep) => (raw[..sep].trim(), raw[sep + 1..].trim()),
                None => (raw, raw),
            };
            if !target.is_empty() && !label.is_empty() {
                targets.push(target.to_string());
            }
        }
        rest = &after_open[close_idx + 2..];
    }

    targets
}

fn collect_linked_note_ids(source_content: &str, notes: &[Note]) -> HashSet<String> {
    let valid_ids: HashSet<&str> = notes.iter().map(|note| note.id.as_str()).collect();
    let mut title_to_ids: HashMap<String, Vec<&str>> = HashMap::new();
    for note in notes {
        let normalized_title = note.title.trim().to_lowercase();
        if !normalized_title.is_empty() {
            title_to_ids
                .entry(normalized_title)
                .or_default()
                .push(note.id.as_str());
        }
    }

    let mut linked = HashSet::new();
    for target in extract_wiki_link_targets(source_content) {
        if let Some(id) = target.strip_prefix("note:") {
            if valid_ids.contains(id) {
                linked.insert(id.to_string());
            }
            continue;
        }
        let normalized_target = target.trim().to_lowercase();
        if let Some(matches) = title_to_ids.get(&normalized_target) {
            if matches.len() == 1 {
                linked.insert(matches[0].to_string());
            }
        }
    }
    linked
}

struct NoteTokenStats {
    tf: HashMap<String, usize>,
    doc_len: usize,
    tags_lower: HashMap<String, String>,
}

fn build_note_stats(note: &Note) -> NoteTokenStats {
    let mut tf: HashMap<String, usize> = HashMap::new();
    let mut doc_len = 0usize;

    for token in tokenize(&note.title) {
        *tf.entry(token).or_insert(0) += TITLE_TERM_WEIGHT;
        doc_len += TITLE_TERM_WEIGHT;
    }
    for token in tokenize(&note.content) {
        *tf.entry(token).or_insert(0) += 1;
        doc_len += 1;
    }

    let mut tags_lower = HashMap::new();
    for tag in &note.tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        tags_lower
            .entry(trimmed.to_lowercase())
            .or_insert_with(|| trimmed.to_string());
    }

    NoteTokenStats {
        tf,
        doc_len,
        tags_lower,
    }
}

fn build_bm25_vector(
    stats: &NoteTokenStats,
    df: &HashMap<String, usize>,
    n_docs: f64,
    avgdl: f64,
) -> (HashMap<String, f64>, f64) {
    let mut weights = HashMap::with_capacity(stats.tf.len());
    let mut norm_sq = 0.0f64;
    let dl = stats.doc_len as f64;
    let len_norm = 1.0 - BM25_B + BM25_B * (dl / avgdl.max(1.0));

    for (term, &count) in &stats.tf {
        let doc_freq = *df.get(term).unwrap_or(&1) as f64;
        // Positive Robertson-Sparck Jones IDF ensures small corpora (e.g. 2 notes) still yield > 0.
        let idf = (1.0 + (n_docs - doc_freq + 0.5) / (doc_freq + 0.5)).ln();
        let tf = count as f64;
        let tf_sat = (tf * (BM25_K1 + 1.0)) / (tf + BM25_K1 * len_norm);
        let weight = tf_sat * idf;
        if weight > 0.0 {
            norm_sq += weight * weight;
            weights.insert(term.clone(), weight);
        }
    }

    (weights, norm_sq.sqrt())
}

fn select_matched_terms(
    shared_tags: &[String],
    mut term_contributions: Vec<(String, f64)>,
) -> Vec<String> {
    term_contributions.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| b.0.chars().count().cmp(&a.0.chars().count()))
            .then_with(|| a.0.cmp(&b.0))
    });

    let mut selected = Vec::new();
    let mut seen_lower = HashSet::new();

    for tag in shared_tags {
        let lower = tag.to_lowercase();
        if seen_lower.insert(lower) {
            selected.push(tag.clone());
            if selected.len() >= MAX_MATCHED_TERMS {
                return selected;
            }
        }
    }

    let mut selected_cjk: Vec<String> = Vec::new();
    for (term, _) in term_contributions {
        if seen_lower.contains(&term) {
            continue;
        }
        if is_cjk_token(&term)
            && selected_cjk.iter().any(|existing| {
                existing.chars().count() > term.chars().count() && existing.contains(&term)
            })
        {
            continue;
        }
        seen_lower.insert(term.clone());
        if is_cjk_token(&term) {
            selected_cjk.push(term.clone());
        }
        selected.push(term);
        if selected.len() >= MAX_MATCHED_TERMS {
            break;
        }
    }

    selected
}

/// Compute top related note suggestions purely locally from an in-memory slice of notes.
pub fn compute_related_notes(
    source_id: &str,
    notes: &[Note],
    limit: usize,
) -> Vec<RelatedNoteSuggestion> {
    if limit == 0 || notes.len() <= 1 {
        return Vec::new();
    }

    let Some(source_index) = notes.iter().position(|note| note.id == source_id) else {
        return Vec::new();
    };

    let stats: Vec<NoteTokenStats> = notes.iter().map(build_note_stats).collect();
    let n_docs = notes.len() as f64;
    let total_len: usize = stats.iter().map(|s| s.doc_len).sum();
    let avgdl = (total_len as f64 / n_docs).max(1.0);

    let mut df: HashMap<String, usize> = HashMap::new();
    for stat in &stats {
        for term in stat.tf.keys() {
            *df.entry(term.clone()).or_insert(0) += 1;
        }
    }

    let vectors: Vec<(HashMap<String, f64>, f64)> = stats
        .iter()
        .map(|stat| build_bm25_vector(stat, &df, n_docs, avgdl))
        .collect();

    let (source_vec, source_norm) = &vectors[source_index];
    let source_stats = &stats[source_index];
    let source_note = &notes[source_index];
    let linked_ids = collect_linked_note_ids(&source_note.content, notes);

    let mut scored: Vec<(RelatedNoteSuggestion, chrono::DateTime<chrono::Utc>)> = Vec::new();

    for (idx, candidate) in notes.iter().enumerate() {
        if idx == source_index {
            continue;
        }

        let (cand_vec, cand_norm) = &vectors[idx];
        let mut dot = 0.0f64;
        let mut term_contributions = Vec::new();

        if *source_norm > 0.0 && *cand_norm > 0.0 {
            for (term, &w_q) in source_vec {
                if let Some(&w_d) = cand_vec.get(term) {
                    let contrib = w_q * w_d;
                    dot += contrib;
                    term_contributions.push((term.clone(), contrib));
                }
            }
        }

        let text_sim = if *source_norm > 0.0 && *cand_norm > 0.0 {
            (dot / (source_norm * cand_norm)).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let cand_stats = &stats[idx];
        let mut shared_tags = Vec::new();
        for (lower, display) in &source_stats.tags_lower {
            if cand_stats.tags_lower.contains_key(lower) {
                shared_tags.push(display.clone());
            }
        }
        shared_tags.sort();

        let union_tags = source_stats
            .tags_lower
            .keys()
            .chain(cand_stats.tags_lower.keys())
            .collect::<HashSet<_>>()
            .len();

        let tag_score = if shared_tags.is_empty() || union_tags == 0 {
            0.0
        } else {
            let jaccard = shared_tags.len() as f64 / union_tags as f64;
            let count_bonus = (shared_tags.len().min(3) as f64) / 3.0;
            0.5 * jaccard + 0.1 * count_bonus
        };

        if text_sim <= 0.0 && tag_score <= 0.0 {
            continue;
        }

        let score = (1.0 - (1.0 - text_sim) * (1.0 - tag_score)).clamp(0.0, 1.0);
        let matched_terms = select_matched_terms(&shared_tags, term_contributions);
        let already_linked = linked_ids.contains(&candidate.id);

        scored.push((
            RelatedNoteSuggestion {
                id: candidate.id.clone(),
                title: candidate.title.clone(),
                category: candidate.category.clone(),
                tags: candidate.tags.clone(),
                score,
                matched_terms,
                already_linked,
            },
            candidate.updated_at,
        ));
    }

    scored.sort_by(|a, b| {
        b.0.score
            .total_cmp(&a.0.score)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.0.id.cmp(&b.0.id))
    });

    scored
        .into_iter()
        .take(limit)
        .map(|(suggestion, _)| suggestion)
        .collect()
}

pub fn related_notes_for_store(
    store: &NoteStore,
    note_id: &str,
    limit: usize,
) -> Result<Vec<RelatedNoteSuggestion>, AppError> {
    let notes = store.all_notes_for_index()?;
    Ok(compute_related_notes(note_id, &notes, limit))
}

pub fn default_related_limit() -> usize {
    DEFAULT_RELATED_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::notes::SaveNoteRequest;
    use chrono::Utc;
    use std::{fs, path::PathBuf};

    fn make_note(id: &str, title: &str, content: &str, tags: Vec<&str>) -> Note {
        Note {
            id: id.into(),
            title: title.into(),
            file_name: format!("{id}.md"),
            category: "随笔".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            word_count: content.chars().filter(|c| !c.is_whitespace()).count(),
            content: content.into(),
            tags: tags.into_iter().map(String::from).collect(),
            pinned: false,
        }
    }

    #[test]
    fn empty_single_and_missing_target_edge_cases() {
        assert!(compute_related_notes("a", &[], 5).is_empty());

        let single = vec![make_note("a", "单独笔记", "只有这一篇笔记", vec!["rust"])];
        assert!(compute_related_notes("a", &single, 5).is_empty());
        assert!(compute_related_notes("missing", &single, 5).is_empty());

        let two = vec![
            make_note("a", "Rust", "Async programming", vec![]),
            make_note("b", "Rust", "Async runtime", vec![]),
        ];
        assert!(compute_related_notes("a", &two, 0).is_empty());
    }

    #[test]
    fn matches_cjk_and_english_terms_and_excludes_unrelated_notes() {
        let notes = vec![
            make_note(
                "target",
                "Rust 异步运行时学习",
                "深入探讨 Tokio 任务调度与异步编程模型。",
                vec![],
            ),
            make_note(
                "cjk-match",
                "异步编程笔记",
                "在 Rust 中理解任务调度和并发模型。",
                vec![],
            ),
            make_note(
                "eng-match",
                "Tokio Runtime",
                "Async scheduling details in tokio.",
                vec![],
            ),
            make_note(
                "unrelated",
                "番茄炒蛋食谱",
                "准备两个鸡蛋和新鲜西红柿。",
                vec![],
            ),
        ];

        let suggestions = compute_related_notes("target", &notes, 5);
        assert_eq!(suggestions.len(), 2);
        assert!(suggestions.iter().all(|s| s.id != "target"));
        assert!(suggestions.iter().all(|s| s.id != "unrelated"));
        assert!(suggestions.iter().all(|s| s.score > 0.0 && s.score <= 1.0));
        assert!(suggestions.iter().all(|s| !s.matched_terms.is_empty()));

        let cjk = suggestions
            .iter()
            .find(|s| s.id == "cjk-match")
            .expect("cjk match");
        assert!(cjk
            .matched_terms
            .iter()
            .any(|t| t == "rust" || t.contains("异步")));

        let eng = suggestions
            .iter()
            .find(|s| s.id == "eng-match")
            .expect("english match");
        assert!(eng.matched_terms.iter().any(|t| t == "tokio"));
    }

    #[test]
    fn shared_tag_overlap_boosts_ranking_and_connects_tag_only_notes() {
        let notes = vec![
            make_note(
                "src",
                "知识管理方法",
                "卡片盒笔记法强调原子化记录。",
                vec!["PKM", "Zettelkasten"],
            ),
            make_note(
                "no-tag",
                "知识管理总结",
                "卡片盒笔记法强调原子化记录。",
                vec![],
            ),
            make_note(
                "with-tag",
                "知识管理总结",
                "卡片盒笔记法强调原子化记录。",
                vec!["pkm", "zettelkasten"],
            ),
            make_note(
                "tag-only",
                "完全不同的标题",
                "正文没有任何重合词。",
                vec!["pkm"],
            ),
        ];

        let suggestions = compute_related_notes("src", &notes, 5);
        assert_eq!(suggestions.len(), 3);
        assert_eq!(suggestions[0].id, "with-tag");
        assert_eq!(suggestions[1].id, "no-tag");
        assert!(suggestions[0].score > suggestions[1].score);

        let tag_only = suggestions
            .iter()
            .find(|s| s.id == "tag-only")
            .expect("tag-only match");
        assert!(tag_only.score > 0.0);
        assert!(tag_only
            .matched_terms
            .iter()
            .any(|t| t.eq_ignore_ascii_case("pkm")));
    }

    #[test]
    fn detects_already_linked_via_id_and_unique_title_only() {
        let notes = vec![
            make_note(
                "src",
                "主笔记",
                "参考 [[note:linked-id|稳定链接]] 以及 [[唯一标题]]，还有别名 [[别名目标|显示名]]、未闭合 [[broken] [[note:valid-after-bracket|OK]] 与歧义链接 [[重复标题]]。",
                vec!["study"],
            ),
            make_note("linked-id", "任意标题", "正文", vec!["study"]),
            make_note("linked-title", "唯一标题", "正文", vec!["study"]),
            make_note("aliased-title", "别名目标", "正文", vec!["study"]),
            make_note("valid-after-bracket", "有效链接", "正文", vec!["study"]),
            make_note("dup-1", "重复标题", "正文", vec!["study"]),
            make_note("dup-2", "重复标题", "正文", vec!["study"]),
            make_note("unlinked", "未链接笔记", "正文", vec!["study"]),
        ];

        let suggestions = compute_related_notes("src", &notes, 10);
        let by_id: HashMap<String, RelatedNoteSuggestion> = suggestions
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect();

        assert!(by_id["linked-id"].already_linked);
        assert!(by_id["linked-title"].already_linked);
        assert!(by_id["aliased-title"].already_linked);
        assert!(by_id["valid-after-bracket"].already_linked);
        assert!(!by_id["dup-1"].already_linked);
        assert!(!by_id["dup-2"].already_linked);
        assert!(!by_id["unlinked"].already_linked);
    }

    #[test]
    fn respects_limit_and_camel_case_json_serialization() {
        let notes = vec![
            make_note("src", "主题", "alpha beta gamma", vec!["t1"]),
            make_note("c1", "c1", "alpha beta gamma", vec!["t1"]),
            make_note("c2", "c2", "alpha beta", vec!["t1"]),
            make_note("c3", "c3", "alpha", vec![]),
        ];

        let top2 = compute_related_notes("src", &notes, 2);
        assert_eq!(top2.len(), 2);
        assert_eq!(top2[0].id, "c1");
        assert_eq!(top2[1].id, "c2");

        let json = serde_json::to_string(&top2[0]).expect("serialize suggestion");
        assert!(json.contains("\"matchedTerms\""));
        assert!(json.contains("\"alreadyLinked\""));
        assert!(!json.contains("\"matched_terms\""));
        assert!(!json.contains("\"already_linked\""));
    }

    #[test]
    fn computes_related_notes_from_note_store() {
        let root = std::env::temp_dir()
            .join("floral-notepaper-related-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create test dir");
        let store = NoteStore::new(root.clone(), root.clone());
        fs::write(
            store.config_path(),
            r#"{"globalShortcut":"Ctrl+Space","closeToTray":true,"autostart":false,"defaultViewMode":"split"}"#,
        )
        .expect("write isolated config");

        let n1 = store
            .create_note(SaveNoteRequest {
                title: "编译器设计".into(),
                content: "词法分析与语法分析基础".into(),
                category: String::new(),
                tags: vec!["cs".into()],
                pinned: false,
            })
            .expect("create n1");
        let n2 = store
            .create_note(SaveNoteRequest {
                title: "词法分析实现".into(),
                content: "状态机与语法分析".into(),
                category: String::new(),
                tags: vec!["cs".into()],
                pinned: false,
            })
            .expect("create n2");

        let related = related_notes_for_store(&store, &n1.id, 5).expect("related from store");
        assert_eq!(related.len(), 1);
        assert_eq!(related[0].id, n2.id);
        assert!(!related[0].already_linked);

        let _ = fs::remove_dir_all(PathBuf::from(&root));
    }
}
