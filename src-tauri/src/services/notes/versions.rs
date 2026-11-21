use super::store::preview;
use super::types::{validate_note_id, AppError, Note, NoteVersion, SaveNoteRequest};
use super::NoteStore;
use chrono::Utc;
use std::{fs, io, path::PathBuf};
use uuid::Uuid;

const NOTE_HISTORY_LIMIT: usize = 20;

impl NoteStore {
    pub(super) fn note_history_dir(&self, note_id: &str) -> Result<PathBuf, AppError> {
        validate_note_id(note_id)?;
        Ok(self.data_dir.join("history").join(note_id))
    }

    fn note_version_path(&self, note_id: &str, version_id: &str) -> Result<PathBuf, AppError> {
        // 版本 ID 格式：`%Y%m%dT%H%M%S%.6fZ` 或 `{时间戳}-{8位hex}`。
        // 整体必须匹配白名单，杜绝路径分隔符 / .. 穿越
        let segments: Vec<&str> = version_id.split('-').collect();
        let base = segments.first().copied().unwrap_or(version_id);
        let suffix_ok = match segments.len() {
            1 => true,
            2 => segments[1].len() == 8 && segments[1].chars().all(|ch| ch.is_ascii_hexdigit()),
            _ => false,
        };
        if chrono::NaiveDateTime::parse_from_str(base, "%Y%m%dT%H%M%S%.fZ").is_err() || !suffix_ok {
            return Err(AppError::new("noteVersionNotFound", "找不到该历史版本"));
        }
        Ok(self
            .note_history_dir(note_id)?
            .join(format!("{version_id}.md")))
    }

    pub(super) fn save_note_version(&self, note_id: &str, content: &str) -> Result<(), AppError> {
        validate_note_id(note_id)?;
        let dir = self.note_history_dir(note_id)?;
        fs::create_dir_all(&dir)?;

        // 计算内容 blake3 hash
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();

        // 在完整保留窗口中去重。A→B→A 不应把同一内容重复写入历史。
        let mut entries: Vec<_> = fs::read_dir(&dir)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("md")
            })
            .collect();
        entries.sort_by_key(|entry| entry.file_name());

        if entries.iter().any(|entry| {
            fs::read_to_string(entry.path())
                .map(|existing| blake3::hash(existing.as_bytes()).to_hex().to_string() == hash)
                .unwrap_or(false)
        }) {
            return Ok(());
        }

        // 存储新版本（时间戳 + 随机后缀，避免同微秒两次保存覆盖同一文件）
        let version_id = format!(
            "{}-{}",
            Utc::now().format("%Y%m%dT%H%M%S%.6fZ"),
            &Uuid::new_v4().to_string()[..8]
        );
        // 原子写：临时文件 + rename，崩溃不会留下半个版本文件
        let version_path = dir.join(format!("{version_id}.md"));
        let temp_path = dir.join(format!("{version_id}.tmp"));
        fs::write(&temp_path, content)?;
        fs::rename(&temp_path, &version_path)?;

        // 重新读取条目列表（包含新写入的版本），清理超出上限的旧版本
        let mut entries: Vec<_> = fs::read_dir(&dir)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("md")
            })
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        let excess = entries.len().saturating_sub(NOTE_HISTORY_LIMIT);
        for entry in entries.into_iter().take(excess) {
            fs::remove_file(entry.path())?;
        }
        Ok(())
    }

    pub fn list_note_versions(&self, id: &str) -> Result<Vec<NoteVersion>, AppError> {
        self.read_note(id)?;
        let dir = self.note_history_dir(id)?;
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut versions = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let Ok(created_at) = chrono::NaiveDateTime::parse_from_str(
                stem.split('-').next().unwrap_or(stem),
                "%Y%m%dT%H%M%S%.fZ",
            ) else {
                continue;
            };
            // 单个版本文件损坏时跳过而不是拖垮整个版本列表
            let Ok(content) = fs::read_to_string(&path) else {
                eprintln!("[花笺] 跳过损坏的历史版本文件: {}", path.display());
                continue;
            };
            versions.push(NoteVersion {
                id: stem.to_string(),
                created_at: created_at.and_utc(),
                preview: preview(&content),
            });
        }
        versions.sort_by_key(|version| std::cmp::Reverse(version.created_at));
        Ok(versions)
    }

    pub fn restore_note_version(&self, id: &str, version_id: &str) -> Result<Note, AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        let version_path = self.note_version_path(id, version_id)?;
        let content = fs::read_to_string(&version_path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                AppError::new("noteVersionNotFound", "找不到该历史版本")
            } else {
                AppError::from(error)
            }
        })?;
        let note = self.read_note(id)?;
        self.update_note_unlocked(
            id,
            SaveNoteRequest {
                title: note.title,
                content,
                category: note.category,
                tags: note.tags,
                pinned: note.pinned,
            },
        )
    }
}
