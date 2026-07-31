use crate::{
    json_io::write_json_atomic,
    services::notes::{
        validate_metadata_json, validate_note_id, validate_relative_file_name, AppError, Note,
    },
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Seek, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

/// 附件清单（attachments.json）的进程内写锁：GUI 单实例下覆盖多窗口并发。
static ATTACHMENT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_attachments() -> Result<MutexGuard<'static, ()>, AppError> {
    ATTACHMENT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| err("attachmentLock", "附件存储锁已中毒，请重启应用后重试"))
}

const BACKUP_KEEP: usize = 30;
const BACKUP_ITEMS: [&str; 7] = [
    "metadata.json",
    "notes",
    "images",
    "attachments",
    "attachments.json",
    "history",
    "reminders.json",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub file_name: String,
    pub size: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub created_at: DateTime<Utc>,
    pub size: u64,
    pub automatic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub note_id: String,
    pub title: String,
    pub category: String,
    pub snippet: String,
    pub match_start: usize,
    pub score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AttachmentFile {
    #[serde(default)]
    attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SearchIndex {
    #[serde(default)]
    documents: Vec<SearchDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocument {
    note_id: String,
    title: String,
    category: String,
    content: String,
    updated_at: DateTime<Utc>,
}

fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError {
        code: code.into(),
        message: message.into(),
        details: Default::default(),
    }
}

fn attachments_path(data_dir: &Path) -> PathBuf {
    data_dir.join("attachments.json")
}
fn attachments_dir(data_dir: &Path, note_id: &str) -> Result<PathBuf, AppError> {
    validate_note_id(note_id)?;
    Ok(data_dir.join("attachments").join(note_id))
}
fn backup_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}
fn index_path(data_dir: &Path) -> PathBuf {
    data_dir.join("search-index.json")
}

fn parse_attachments(raw: &str) -> Result<AttachmentFile, AppError> {
    let file: AttachmentFile = serde_json::from_str(raw)?;
    for attachment in &file.attachments {
        validate_note_id(&attachment.note_id)?;
        validate_relative_file_name(&attachment.file_name, "附件文件名")?;
    }
    Ok(file)
}

pub(crate) fn validate_attachments_json(path: &Path) -> Result<(), AppError> {
    parse_attachments(&fs::read_to_string(path)?).map(|_| ())
}

fn load_attachments(data_dir: &Path) -> Result<AttachmentFile, AppError> {
    let path = attachments_path(data_dir);
    if !path.exists() {
        return Ok(AttachmentFile::default());
    }
    parse_attachments(&fs::read_to_string(path)?)
}

fn save_attachments(data_dir: &Path, file: &AttachmentFile) -> Result<(), AppError> {
    write_json_atomic(&attachments_path(data_dir), file)
}

fn safe_file_name(value: &str) -> String {
    let result: String = value
        .chars()
        .map(|ch| {
            if "<>:\"/\\|?*".contains(ch) || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let result = result.trim_matches(['.', ' ']);
    if result.is_empty() {
        "attachment".into()
    } else {
        result.chars().take(120).collect()
    }
}

pub fn add_attachment(
    data_dir: &Path,
    note_id: &str,
    source: &Path,
) -> Result<Attachment, AppError> {
    let _lock = lock_attachments()?;
    if !source.is_file() {
        return Err(err("attachmentSource", "附件源文件不存在"));
    }
    let metadata = fs::metadata(source)?;
    if metadata.len() > 100 * 1024 * 1024 {
        return Err(err("attachmentTooLarge", "单个附件不能超过 100 MB"));
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment")
        .to_string();
    let id = Uuid::new_v4().to_string();
    let file_name = format!("{}_{}", id, safe_file_name(&name));
    let dir = attachments_dir(data_dir, note_id)?;
    fs::create_dir_all(&dir)?;
    fs::copy(source, dir.join(&file_name))?;
    let attachment = Attachment {
        id,
        note_id: note_id.into(),
        name,
        file_name,
        size: metadata.len(),
        created_at: Utc::now(),
    };
    let mut file = load_attachments(data_dir)?;
    file.attachments.push(attachment.clone());
    save_attachments(data_dir, &file)?;
    Ok(attachment)
}

pub fn list_attachments(data_dir: &Path, note_id: &str) -> Result<Vec<Attachment>, AppError> {
    let mut attachments: Vec<_> = load_attachments(data_dir)?
        .attachments
        .into_iter()
        .filter(|item| item.note_id == note_id)
        .collect();
    let dir = attachments_dir(data_dir, note_id)?;
    attachments.retain(|item| dir.join(&item.file_name).is_file());
    attachments.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    Ok(attachments)
}

pub fn delete_attachment(
    data_dir: &Path,
    note_id: &str,
    attachment_id: &str,
) -> Result<(), AppError> {
    let _lock = lock_attachments()?;
    let mut file = load_attachments(data_dir)?;
    let index = file
        .attachments
        .iter()
        .position(|item| item.id == attachment_id && item.note_id == note_id)
        .ok_or_else(|| err("attachmentNotFound", "找不到附件"))?;
    let attachment = file.attachments.remove(index);
    let path = attachments_dir(data_dir, note_id)?.join(attachment.file_name);
    if path.exists() {
        trash::delete(&path).map_err(|error| err("trash", format!("移入回收站失败: {error}")))?;
    }
    save_attachments(data_dir, &file)
}

pub fn delete_note_attachments(data_dir: &Path, note_id: &str) -> Result<(), AppError> {
    let _lock = lock_attachments()?;
    let mut file = load_attachments(data_dir)?;
    file.attachments.retain(|item| item.note_id != note_id);
    save_attachments(data_dir, &file)?;
    let dir = attachments_dir(data_dir, note_id)?;
    if dir.exists() {
        let _ = trash::delete(dir);
    }
    Ok(())
}

pub fn move_note_attachments(
    data_dir: &Path,
    source_id: &str,
    target_id: &str,
) -> Result<(), AppError> {
    let _lock = lock_attachments()?;
    let source = attachments_dir(data_dir, source_id)?;
    let target = attachments_dir(data_dir, target_id)?;
    // 记录已移动的文件（目标 → 源），JSON 保存失败时回滚
    let mut moved_files: Vec<(PathBuf, PathBuf)> = Vec::new();
    if source.exists() {
        fs::create_dir_all(&target)?;
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            if entry.path().is_file() {
                let from = entry.path();
                let to = target.join(entry.file_name());
                if let Err(error) = fs::rename(&from, &to) {
                    // 回滚：把本次已移动的文件移回源目录
                    for (moved_to, moved_from) in &moved_files {
                        let _ = fs::rename(moved_to, moved_from);
                    }
                    return Err(err("moveAttachmentFailed", format!("移动附件失败: {error}")));
                }
                moved_files.push((to, from));
            }
        }
        let _ = fs::remove_dir(&source);
    }
    let mut file = load_attachments(data_dir)?;
    for attachment in &mut file.attachments {
        if attachment.note_id == source_id {
            attachment.note_id = target_id.to_string();
        }
    }
    if let Err(error) = save_attachments(data_dir, &file) {
        // 回滚：附件清单保存失败时把已移动的文件移回源目录，避免成孤儿
        for (to, from) in moved_files {
            let _ = fs::rename(&to, &from);
        }
        return Err(error);
    }
    Ok(())
}

fn add_dir_to_zip<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    root: &Path,
    path: &Path,
) -> Result<(), AppError> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        let relative = entry_path
            .strip_prefix(root)
            .map_err(|_| err("backup", "备份路径无效"))?
            .to_string_lossy()
            .replace('\\', "/");
        if entry.file_type()?.is_dir() {
            add_dir_to_zip(zip, root, &entry_path)?;
        } else if entry.file_type()?.is_file() {
            zip.start_file(
                relative,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .map_err(|e| err("backup", e.to_string()))?;
            let mut source = fs::File::open(entry_path)?;
            std::io::copy(&mut source, zip)?;
        }
    }
    Ok(())
}

fn create_backup(data_dir: &Path, destination: &Path) -> Result<(), AppError> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = destination.with_extension("zip.tmp");
    let file = fs::File::create(&temp)?;
    let mut zip = ZipWriter::new(file);
    for name in BACKUP_ITEMS {
        let path = data_dir.join(name);
        if path.is_file() {
            zip.start_file(
                name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .map_err(|e| err("backup", e.to_string()))?;
            let mut source = fs::File::open(path)?;
            std::io::copy(&mut source, &mut zip)?;
        } else if path.is_dir() {
            add_dir_to_zip(&mut zip, data_dir, &path)?;
        }
    }
    zip.finish().map_err(|e| err("backup", e.to_string()))?;
    fs::rename(temp, destination)?;
    Ok(())
}

fn backup_name(prefix: &str) -> String {
    // 带随机后缀：同一秒内手动 + 自动备份不会互相覆盖
    format!(
        "{prefix}-{}-{}.zip",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    )
}

pub fn create_manual_backup(data_dir: &Path, destination: &Path) -> Result<(), AppError> {
    create_backup(data_dir, destination)
}

pub fn ensure_daily_backup(data_dir: &Path) -> Result<Option<BackupInfo>, AppError> {
    let dir = backup_dir(data_dir);
    fs::create_dir_all(&dir)?;
    let today = Utc::now().format("%Y%m%d").to_string();
    if fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("auto-{today}"))
        })
    {
        return Ok(None);
    }
    let path = dir.join(backup_name("auto"));
    create_backup(data_dir, &path)?;
    prune_backups(&dir)?;
    Ok(Some(backup_info(&path)?))
}

fn backup_info(path: &Path) -> Result<BackupInfo, AppError> {
    let metadata = fs::metadata(path)?;
    let created_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| DateTime::<Utc>::from(std::time::UNIX_EPOCH + value))
        .unwrap_or_else(Utc::now);
    Ok(BackupInfo {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        created_at,
        size: metadata.len(),
        automatic: path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("auto-"))
            .unwrap_or(false),
    })
}

fn prune_backups(dir: &Path) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("zip"))
        .collect();
    entries.sort_by_key(|entry| {
        std::cmp::Reverse(entry.metadata().and_then(|meta| meta.modified()).ok())
    });
    for entry in entries.into_iter().skip(BACKUP_KEEP) {
        let _ = fs::remove_file(entry.path());
    }
    Ok(())
}

pub fn list_backups(data_dir: &Path) -> Result<Vec<BackupInfo>, AppError> {
    let dir = backup_dir(data_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| backup_info(&entry.path()).ok())
        .collect::<Vec<_>>();
    items.sort_by_key(|item| std::cmp::Reverse(item.created_at));
    Ok(items)
}

fn safe_archive_path(name: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(name);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(err("backupUnsafe", "备份文件包含不安全路径"));
    }
    // Windows 保留设备名（CON/NUL/PRN/AUX/COM1-9/LPT1-9）：
    // 解压到这些名字会让恢复直接失败，属于可拒绝的 DoS
    let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.starts_with("COM")
            && base.len() > 3
            && base[3..].parse::<u8>().is_ok())
        || (base.starts_with("LPT")
            && base.len() > 3
            && base[3..].parse::<u8>().is_ok());
    if reserved {
        return Err(err("backupUnsafe", "备份文件包含 Windows 保留名称"));
    }
    Ok(path.to_path_buf())
}

pub fn restore_backup(data_dir: &Path, backup: &Path) -> Result<(), AppError> {
    let rollback = backup_dir(data_dir).join(backup_name("before-restore"));
    create_backup(data_dir, &rollback)?;
    let staging = data_dir.join(format!(".restore-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging)?;

    let restore_result = (|| -> Result<(), AppError> {
        let file = fs::File::open(backup)?;
        let mut archive =
            ZipArchive::new(file).map_err(|error| err("backupInvalid", error.to_string()))?;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| err("backupInvalid", error.to_string()))?;
            let relative = safe_archive_path(entry.name())?;
            let output = staging.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(output)?;
            } else {
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut target = fs::File::create(output)?;
                std::io::copy(&mut entry, &mut target)?;
            }
        }
        if !staging.join("metadata.json").is_file() || !staging.join("notes").is_dir() {
            return Err(err("backupInvalid", "备份缺少笔记数据"));
        }
        validate_metadata_json(&staging.join("metadata.json"))?;
        if staging.join("attachments.json").is_file() {
            validate_attachments_json(&staging.join("attachments.json")).map_err(|error| {
                err(
                    "backupInvalid",
                    format!("备份附件元数据无效: {}", error.message),
                )
            })?;
        }
        Ok(())
    })();

    if let Err(error) = restore_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    // 替换数据目录内容：先把现有数据整体挪进 stash（不删除、可回滚），
    // 再把 staging 内容放入目标位置，全部成功后才清理 stash。
    // 相比逐项 remove_dir_all + rename，中途失败不会留下"半恢复"状态。
    let stash = data_dir.join(format!(".restore-old-{}", Uuid::new_v4()));
    fs::create_dir_all(&stash)?;
    let mut stashed: Vec<&str> = Vec::new();
    for name in BACKUP_ITEMS {
        let target = data_dir.join(name);
        if target.exists() {
            if let Err(error) = fs::rename(&target, stash.join(name)) {
                // 回滚：把已挪进 stash 的旧数据挪回原位
                for item in &stashed {
                    let _ = fs::rename(stash.join(item), data_dir.join(item));
                }
                let _ = fs::remove_dir_all(&stash);
                return Err(err("restoreFailed", format!("暂存旧数据失败: {error}")));
            }
            stashed.push(name);
        }
    }

    let mut restored: Vec<&str> = Vec::new();
    for name in BACKUP_ITEMS {
        let source = staging.join(name);
        if source.exists() {
            if let Err(error) = fs::rename(&source, data_dir.join(name)) {
                // 回滚：移除已放置的新数据，再把旧数据从 stash 挪回
                for item in &restored {
                    let _ = fs::remove_dir_all(data_dir.join(item));
                    let _ = fs::remove_file(data_dir.join(item));
                }
                for item in BACKUP_ITEMS {
                    let stashed = stash.join(item);
                    if stashed.exists() {
                        let _ = fs::rename(&stashed, data_dir.join(item));
                    }
                }
                let _ = fs::remove_dir_all(&stash);
                return Err(err("restoreFailed", format!("恢复数据失败: {error}")));
            }
            restored.push(name);
        }
    }
    let _ = fs::remove_dir_all(&stash);
    let _ = fs::remove_dir_all(staging);
    Ok(())
}

pub fn rebuild_search_index(data_dir: &Path, notes: &[Note]) -> Result<(), AppError> {
    let index = SearchIndex {
        documents: notes
            .iter()
            .map(|note| SearchDocument {
                note_id: note.id.clone(),
                title: note.title.clone(),
                category: note.category.clone(),
                content: note.content.clone(),
                updated_at: note.updated_at,
            })
            .collect(),
    };
    write_json_atomic(&index_path(data_dir), &index)
}

/// 在权威笔记集合中执行 JSON/文件系统回退搜索。
///
/// `search-index.json` 曾被当作优先来源，但它可能落后于 Markdown 与 metadata，
/// 既会漏搜，也曾因按字节截取中文摘要而 panic。SQLite 不可用时宁可直接扫描
/// 当前权威笔记，保证结果正确；FTS 可用时由 notes.rs 负责走高性能路径。
pub fn search(
    _data_dir: &Path,
    query: &str,
    fallback: &[Note],
) -> Result<Vec<SearchResult>, AppError> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = fallback
        .iter()
        .filter_map(|note| {
            let title_pos = case_insensitive_find(&note.title, &normalized);
            let content_pos = case_insensitive_find(&note.content, &normalized);
            let (source, pos, score) = if let Some(position) = content_pos {
                (
                    &note.content,
                    position,
                    10 + title_pos.map(|_| 8).unwrap_or(0),
                )
            } else if let Some(position) = title_pos {
                (&note.title, position, 18)
            } else {
                return None;
            };

            let snippet = safe_snippet(source, pos, query);
            let title = if note.title.trim().is_empty() {
                "无标题笔记".into()
            } else {
                note.title.clone()
            };
            Some(SearchResult {
                note_id: note.id.clone(),
                title,
                category: note.category.clone(),
                snippet,
                match_start: pos,
                score,
            })
        })
        .collect::<Vec<_>>();

    results.sort_by_key(|result| std::cmp::Reverse(result.score));
    results.truncate(80);
    Ok(results)
}

pub(crate) fn case_insensitive_find(source: &str, normalized_query: &str) -> Option<usize> {
    if source.to_lowercase().starts_with(normalized_query) {
        return Some(0);
    }
    // Unicode lowercase conversion can change byte length (for example İ → i̇), so a byte
    // offset obtained from `source.to_lowercase()` cannot be used to slice `source`.
    // Compare at original character boundaries instead. This path is the JSON fallback only.
    source.char_indices().find_map(|(offset, _)| {
        source[offset..]
            .to_lowercase()
            .starts_with(normalized_query)
            .then_some(offset)
    })
}

fn floor_char_boundary(source: &str, index: usize) -> usize {
    let mut index = index.min(source.len());
    while index > 0 && !source.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(source: &str, index: usize) -> usize {
    let mut index = index.min(source.len());
    while index < source.len() && !source.is_char_boundary(index) {
        index += 1;
    }
    index
}

pub(crate) fn safe_snippet(source: &str, match_start: usize, query: &str) -> String {
    let start = floor_char_boundary(source, match_start.saturating_sub(44));
    let matched_chars = query.chars().count().max(1);
    let match_end = source[match_start..]
        .char_indices()
        .nth(matched_chars)
        .map(|(offset, _)| match_start + offset)
        .unwrap_or(source.len());
    let end = ceil_char_boundary(source, (match_end + 90).min(source.len()));
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        source[start..end].replace('\n', " "),
        if end < source.len() { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("floral-library-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn sample_note(id: &str, title: &str, content: &str) -> Note {
        Note {
            id: id.into(),
            title: title.into(),
            file_name: format!("{id}.md"),
            category: "学习".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            word_count: content.len(),
            content: content.into(),
            tags: Vec::new(),
            pinned: false,
        }
    }

    #[test]
    fn attachment_is_listed_and_can_be_removed() {
        let dir = temp_dir("attachment");
        let source = dir.join("资料.pdf");
        fs::write(&source, b"reference").expect("write source");
        let attachment = add_attachment(&dir, "note-a", &source).expect("add attachment");
        assert_eq!(list_attachments(&dir, "note-a").expect("list").len(), 1);
        delete_attachment(&dir, "note-a", &attachment.id).expect("delete attachment");
        assert!(list_attachments(&dir, "note-a")
            .expect("list after delete")
            .is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn backup_round_trip_keeps_notes_and_attachments() {
        let dir = temp_dir("backup");
        fs::create_dir_all(dir.join("notes")).expect("notes dir");
        fs::write(dir.join("notes").join("a.md"), "backup content").expect("write note");
        fs::write(dir.join("metadata.json"), r#"{"notes":[]}"#).expect("metadata");
        let source = dir.join("paper.txt");
        fs::write(&source, "attachment").expect("source");
        add_attachment(&dir, "a", &source).expect("add attachment");
        let backup = dir.join("export.zip");
        create_manual_backup(&dir, &backup).expect("backup");
        fs::write(dir.join("notes").join("a.md"), "changed").expect("change note");
        restore_backup(&dir, &backup).expect("restore");
        assert_eq!(
            fs::read_to_string(dir.join("notes").join("a.md")).expect("read note"),
            "backup content"
        );
        assert_eq!(list_attachments(&dir, "a").expect("attachments").len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_rejects_unsafe_metadata_before_replacing_live_data() {
        let dir = temp_dir("unsafe-backup");
        fs::create_dir_all(dir.join("notes")).expect("notes dir");
        fs::write(dir.join("notes").join("a.md"), "live content").expect("live note");
        fs::write(dir.join("metadata.json"), r#"{"notes":[]}"#).expect("metadata");

        let backup = dir.join("malicious.zip");
        let file = fs::File::create(&backup).expect("create malicious backup");
        let mut zip = ZipWriter::new(file);
        zip.start_file("metadata.json", SimpleFileOptions::default())
            .expect("metadata entry");
        let metadata = format!(
            r#"{{"notes":[{{"id":"safe","title":"x","fileName":"../escape.md","category":"","createdAt":"{0}","updatedAt":"{0}","wordCount":0,"preview":"","tags":[],"pinned":false}}]}}"#,
            Utc::now().to_rfc3339()
        );
        std::io::Write::write_all(&mut zip, metadata.as_bytes()).expect("write metadata");
        zip.add_directory("notes/", SimpleFileOptions::default())
            .expect("notes entry");
        zip.finish().expect("finish malicious backup");

        let error = restore_backup(&dir, &backup).expect_err("unsafe backup should be rejected");
        assert_eq!(error.code, "backupInvalid");
        assert_eq!(
            fs::read_to_string(dir.join("notes").join("a.md")).expect("read live note"),
            "live content"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fallback_search_uses_current_authoritative_notes() {
        let dir = temp_dir("search");
        let notes = vec![
            sample_note("a", "机械设计", "齿轮强度计算"),
            sample_note("b", "菜谱", "番茄炒蛋"),
        ];
        // 即使磁盘上的旧 search-index.json 已存在，回退搜索也必须以传入的权威笔记为准。
        rebuild_search_index(&dir, &notes).expect("write compatibility index");
        let results = search(&dir, "齿轮", &notes).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].note_id, "a");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fallback_search_handles_chinese_utf8_boundaries() {
        let dir = temp_dir("utf8-search");
        let content = format!(
            "{}水稻田{}",
            "春风吹过田野。".repeat(40),
            "收成很好。".repeat(40)
        );
        let notes = vec![sample_note("rice", "农学", &content)];
        let results = search(&dir, "水稻", &notes).expect("search should not panic");
        assert_eq!(results.len(), 1);
        assert!(results[0].snippet.contains("水稻田"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn fallback_search_keeps_unicode_casefold_offsets_safe() {
        let dir = temp_dir("unicode-casefold");
        let notes = vec![sample_note(
            "turkish",
            "İstanbul",
            "İstanbul 的字节长度会变化",
        )];
        let results = search(&dir, "i̇stan", &notes).expect("unicode search should not panic");
        assert_eq!(results.len(), 1);
        assert!(results[0].snippet.contains("İstanbul"));
        let _ = fs::remove_dir_all(dir);
    }
}
