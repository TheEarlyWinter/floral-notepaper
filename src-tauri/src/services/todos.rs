use crate::services::notes::{AppError, Note, NoteStore, SaveNoteRequest};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoFilter {
    All,
    Pending,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub note_id: String,
    pub note_title: String,
    pub category: String,
    /// 0-based task index within the note (stable across status filters).
    pub index: usize,
    /// 1-based line number within the note content.
    pub line: usize,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedTaskLine {
    line: usize,
    line_start_byte: usize,
    state_offset_in_line: usize,
    done: bool,
    text: String,
}

fn display_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "无标题笔记".to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_fence_open(trimmed: &str) -> Option<(char, usize)> {
    let mut chars = trimmed.chars();
    let fence_char = chars.next()?;
    if fence_char != '`' && fence_char != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|&c| c == fence_char).count();
    if count < 3 {
        return None;
    }
    let rest = &trimmed[count..];
    // Per CommonMark, backtick fence info strings cannot contain backticks
    // (prevents treating inline spans like ```foo``` as unclosed fences).
    if fence_char == '`' && rest.contains('`') {
        return None;
    }
    Some((fence_char, count))
}

fn is_fence_close(trimmed: &str, open_char: char, open_len: usize) -> bool {
    let count = trimmed.chars().take_while(|&c| c == open_char).count();
    if count < open_len {
        return false;
    }
    trimmed[count..].trim_matches([' ', '\t']).is_empty()
}

fn parse_task_line(
    line_text: &str,
    line_number: usize,
    line_start_byte: usize,
) -> Option<ParsedTaskLine> {
    let bytes = line_text.as_bytes();
    let mut pos = 0;

    while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t') {
        pos += 1;
    }

    // Match bullet (`-`, `*`, `+`) or ordered (`1.`, `1)`) list marker.
    let marker_first = *bytes.get(pos)?;
    if matches!(marker_first, b'-' | b'*' | b'+') {
        pos += 1;
    } else if marker_first.is_ascii_digit() {
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        let delim = *bytes.get(pos)?;
        if delim != b'.' && delim != b')' {
            return None;
        }
        pos += 1;
    } else {
        return None;
    }

    // Require at least one space/tab after list marker.
    let ws_after_marker_start = pos;
    while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t') {
        pos += 1;
    }
    if pos == ws_after_marker_start {
        return None;
    }

    // Match `[ ]`, `[x]`, or `[X]`.
    if *bytes.get(pos)? != b'[' {
        return None;
    }
    let state_byte = *bytes.get(pos + 1)?;
    let done = match state_byte {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    if *bytes.get(pos + 2)? != b']' {
        return None;
    }
    let state_offset_in_line = pos + 1;
    pos += 3;

    // Require at least one space/tab after `]`.
    let ws_after_box_start = pos;
    while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t') {
        pos += 1;
    }
    if pos == ws_after_box_start {
        return None;
    }

    let text = line_text[pos..].trim();
    if text.is_empty() {
        return None;
    }

    Some(ParsedTaskLine {
        line: line_number,
        line_start_byte,
        state_offset_in_line,
        done,
        text: text.to_string(),
    })
}

fn scan_task_lines(content: &str) -> Vec<ParsedTaskLine> {
    let mut tasks = Vec::new();
    let mut open_fence: Option<(char, usize)> = None;
    let mut offset = 0usize;

    for (idx, raw_line) in content.split_inclusive('\n').enumerate() {
        let line_number = idx + 1;
        let line_no_eol = raw_line.trim_end_matches(['\r', '\n']);
        let trimmed_start = line_no_eol.trim_start_matches([' ', '\t']);

        if let Some((fence_char, fence_len)) = open_fence {
            if is_fence_close(trimmed_start, fence_char, fence_len) {
                open_fence = None;
            }
        } else if let Some(fence) = parse_fence_open(trimmed_start) {
            open_fence = Some(fence);
        } else if let Some(parsed) = parse_task_line(line_no_eol, line_number, offset) {
            tasks.push(parsed);
        }

        offset += raw_line.len();
    }

    tasks
}

pub fn parse_note_todos(note: &Note) -> Vec<TodoItem> {
    let note_title = display_title(&note.title);
    scan_task_lines(&note.content)
        .into_iter()
        .enumerate()
        .map(|(index, task)| TodoItem {
            note_id: note.id.clone(),
            note_title: note_title.clone(),
            category: note.category.clone(),
            index,
            line: task.line,
            text: task.text,
            done: task.done,
        })
        .collect()
}

pub fn list_todos(
    store: &NoteStore,
    filter: TodoFilter,
    note_id: Option<&str>,
) -> Result<Vec<TodoItem>, AppError> {
    let mut items = match note_id {
        Some(id) => {
            let note = store.read_note(id)?;
            parse_note_todos(&note)
        }
        None => {
            let metas = store.list_notes()?;
            let mut all = Vec::new();
            for meta in metas {
                if let Ok(note) = store.read_note(&meta.id) {
                    all.extend(parse_note_todos(&note));
                }
            }
            all
        }
    };

    match filter {
        TodoFilter::All => {}
        TodoFilter::Pending => items.retain(|item| !item.done),
        TodoFilter::Done => items.retain(|item| item.done),
    }

    Ok(items)
}

pub fn toggle_todo_in_content(content: &str, index: usize) -> Option<(String, TodoItemDraft)> {
    let tasks = scan_task_lines(content);
    let task = tasks.get(index)?;
    let byte_pos = task.line_start_byte + task.state_offset_in_line;
    let new_done = !task.done;
    let new_char = if new_done { "x" } else { " " };

    let mut updated = String::with_capacity(content.len());
    updated.push_str(&content[..byte_pos]);
    updated.push_str(new_char);
    updated.push_str(&content[byte_pos + 1..]);

    Some((
        updated,
        TodoItemDraft {
            line: task.line,
            text: task.text.clone(),
            done: new_done,
        },
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItemDraft {
    pub line: usize,
    pub text: String,
    pub done: bool,
}

pub fn toggle_todo(store: &NoteStore, note_id: &str, index: usize) -> Result<TodoItem, AppError> {
    let note = store.read_note(note_id)?;
    let total = scan_task_lines(&note.content).len();
    let (updated_content, toggled) =
        toggle_todo_in_content(&note.content, index).ok_or_else(|| AppError {
            code: "todoNotFound".into(),
            message: format!("Todo index {index} out of bounds for note {note_id} (total {total})"),
            details: Default::default(),
        })?;

    let updated = store.update_note(
        note_id,
        SaveNoteRequest {
            title: note.title,
            content: updated_content,
            category: note.category,
            tags: note.tags,
            pinned: note.pinned,
        },
    )?;

    Ok(TodoItem {
        note_id: updated.id,
        note_title: display_title(&updated.title),
        category: updated.category,
        index,
        line: toggled.line,
        text: toggled.text,
        done: toggled.done,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn temp_store() -> (std::path::PathBuf, NoteStore) {
        let root = std::env::temp_dir().join(format!("floral-todos-test-{}", Uuid::new_v4()));
        let config_dir = root.join("config");
        let data_dir = root.join("data");
        fs::create_dir_all(&config_dir).expect("create config dir");
        fs::create_dir_all(&data_dir).expect("create data dir");
        let store = NoteStore::new(config_dir, data_dir);
        (root, store)
    }

    #[test]
    fn parses_all_gfm_task_list_variants_and_ignores_fenced_code_blocks() {
        let (_root, store) = temp_store();
        let note = store
            .create_note(SaveNoteRequest {
                title: "Tasks".into(),
                content: concat!(
                    "# Header\n",
                    "- [ ] dash pending\n",
                    "- [x] dash lower done\n",
                    "- [X] dash upper done\n",
                    "  * [ ] indented star pending\n",
                    "+ [x] plus done\n",
                    "1. [ ] numbered dot pending\n",
                    "2) [X] numbered paren done\n",
                    "- [ ]   \n",
                    "```markdown\n",
                    "- [ ] inside backtick fence\n",
                    "* [x] still inside fence\n",
                    "```\n",
                    "  ~~~\n",
                    "  - [ ] inside tilde fence\n",
                    "  ~~~\n",
                    "Inline ```code``` before task\n",
                    "- [ ] after fences\n",
                )
                .into(),
                category: "work".into(),
                tags: vec!["todo".into()],
                pinned: true,
            })
            .expect("create note");

        let items = parse_note_todos(&note);
        assert_eq!(items.len(), 8);
        assert_eq!(items[0].index, 0);
        assert_eq!(items[0].text, "dash pending");
        assert!(!items[0].done);
        assert_eq!(items[0].line, 2);

        assert_eq!(items[1].index, 1);
        assert_eq!(items[1].text, "dash lower done");
        assert!(items[1].done);

        assert_eq!(items[2].index, 2);
        assert_eq!(items[2].text, "dash upper done");
        assert!(items[2].done);

        assert_eq!(items[3].index, 3);
        assert_eq!(items[3].text, "indented star pending");
        assert!(!items[3].done);

        assert_eq!(items[4].index, 4);
        assert_eq!(items[4].text, "plus done");
        assert!(items[4].done);

        assert_eq!(items[5].index, 5);
        assert_eq!(items[5].text, "numbered dot pending");
        assert!(!items[5].done);

        assert_eq!(items[6].index, 6);
        assert_eq!(items[6].text, "numbered paren done");
        assert!(items[6].done);

        assert_eq!(items[7].index, 7);
        assert_eq!(items[7].text, "after fences");
        assert!(!items[7].done);

        let _ = fs::remove_dir_all(_root);
    }

    #[test]
    fn handles_longer_backtick_fences_and_crlf_line_endings() {
        let content = "````\r\n```\r\n- [ ] still fenced\r\n```\r\n````\r\n- [ ] real task\r\n";
        let (updated, toggled) = toggle_todo_in_content(content, 0).expect("toggle task 0");
        assert!(toggled.done);
        assert_eq!(toggled.text, "real task");
        assert_eq!(toggled.line, 6);
        assert_eq!(
            updated,
            "````\r\n```\r\n- [ ] still fenced\r\n```\r\n````\r\n- [x] real task\r\n"
        );
    }

    #[test]
    fn list_todos_filters_by_status_and_note_preserving_note_index() {
        let (root, store) = temp_store();
        let note_a = store
            .create_note(SaveNoteRequest {
                title: "A".into(),
                content: "- [x] done a\n- [ ] pending a\n".into(),
                category: String::new(),
                tags: vec![],
                pinned: false,
            })
            .expect("create note A");
        let note_b = store
            .create_note(SaveNoteRequest {
                title: "B".into(),
                content: "* [ ] pending b\n".into(),
                category: "study".into(),
                tags: vec![],
                pinned: false,
            })
            .expect("create note B");

        let all = list_todos(&store, TodoFilter::All, None).expect("list all");
        assert_eq!(all.len(), 3);

        let pending_a =
            list_todos(&store, TodoFilter::Pending, Some(&note_a.id)).expect("pending A");
        assert_eq!(pending_a.len(), 1);
        assert_eq!(pending_a[0].text, "pending a");
        // Must retain its 0-based index within note A (1, not 0).
        assert_eq!(pending_a[0].index, 1);

        let done_all = list_todos(&store, TodoFilter::Done, None).expect("done all");
        assert_eq!(done_all.len(), 1);
        assert_eq!(done_all[0].note_id, note_a.id);

        let only_b = list_todos(&store, TodoFilter::All, Some(&note_b.id)).expect("list B");
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].category, "study");

        assert!(list_todos(&store, TodoFilter::All, Some("missing-note")).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn toggle_todo_persists_via_update_note_and_preserves_metadata() {
        let (root, store) = temp_store();
        let created = store
            .create_note(SaveNoteRequest {
                title: "Plan".into(),
                content: "- [ ] first\n- [X] second\n".into(),
                category: "ops".into(),
                tags: vec!["tag1".into(), "tag2".into()],
                pinned: true,
            })
            .expect("create note");

        let toggled_first = toggle_todo(&store, &created.id, 0).expect("toggle 0");
        assert!(toggled_first.done);
        assert_eq!(toggled_first.index, 0);

        let toggled_second = toggle_todo(&store, &created.id, 1).expect("toggle 1");
        assert!(!toggled_second.done);
        assert_eq!(toggled_second.index, 1);

        let reloaded = store.read_note(&created.id).expect("reload note");
        assert_eq!(reloaded.content, "- [x] first\n- [ ] second\n");
        assert_eq!(reloaded.title, "Plan");
        assert_eq!(reloaded.category, "ops");
        assert_eq!(reloaded.tags, vec!["tag1".to_string(), "tag2".to_string()]);
        assert!(reloaded.pinned);

        let err = toggle_todo(&store, &created.id, 99).expect_err("out of bounds must fail");
        assert_eq!(err.code, "todoNotFound");

        let _ = fs::remove_dir_all(root);
    }
}
