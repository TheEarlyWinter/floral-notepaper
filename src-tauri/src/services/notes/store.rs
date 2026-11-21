use super::migration::{
    data_dir_needs_reconciliation, invalidate_data_dir_reconciliation, mark_data_dir_reconciled,
};
use super::types::{
    validate_category_name, validate_metadata, validate_note_file_name, validate_note_id, AppError,
    MergeNotesRequest, MetadataFile, Note, NoteMetadata, SaveNoteRequest,
};
use crate::json_io::write_json_atomic;
use chrono::Utc;
use fs4::fs_std::FileExt;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};
use uuid::Uuid;

const CORRUPT_METADATA_BACKUP_KEEP: usize = 5;

// default_store() 会为每个命令创建一个新的 NoteStore；这把进程内锁覆盖完整
// 读-改-写区间，避免多个窗口用旧 metadata.json 覆盖彼此的更新。
static METADATA_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// 元数据写锁的持有凭证：进程内互斥 + 跨进程文件锁，析构时自动释放。
pub(super) struct MetadataLockGuard {
    _process: MutexGuard<'static, ()>,
    _file: fs::File,
}

#[derive(Debug, Clone)]
pub struct NoteStore {
    pub(super) config_dir: PathBuf,
    pub(super) data_dir: PathBuf,
}

impl NoteStore {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            config_dir,
            data_dir,
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn metadata_path(&self) -> PathBuf {
        self.data_dir.join("metadata.json")
    }

    pub fn config_path(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }

    pub fn list_notes(&self) -> Result<Vec<NoteMetadata>, AppError> {
        self.ensure_storage()?;
        let mut metadata = self.load_metadata()?.notes;
        metadata.retain(|note| {
            self.note_path_in_category(&note.file_name, &note.category)
                .map(|path| path.exists())
                .unwrap_or(false)
        });
        metadata.sort_by_key(|note| std::cmp::Reverse(note.updated_at));
        Ok(metadata)
    }

    pub fn read_note(&self, id: &str) -> Result<Note, AppError> {
        self.ensure_storage()?;
        let metadata = self.find_metadata(id)?;
        let content = fs::read_to_string(
            self.note_path_in_category(&metadata.file_name, &metadata.category)?,
        )?;
        Ok(Note {
            id: metadata.id,
            title: metadata.title,
            file_name: metadata.file_name,
            category: metadata.category,
            created_at: metadata.created_at,
            updated_at: metadata.updated_at,
            word_count: metadata.word_count,
            content,
            tags: metadata.tags,
            pinned: metadata.pinned,
        })
    }

    pub fn create_note(&self, request: SaveNoteRequest) -> Result<Note, AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.create_note_unlocked(request)
    }

    fn create_note_unlocked(&self, request: SaveNoteRequest) -> Result<Note, AppError> {
        self.ensure_storage()?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let file_name = self.file_name_for(&id, &request.title);
        let word_count = count_words(&request.content);
        let category = request.category.clone();
        let note_path = self.note_path_in_category(&file_name, &category)?;
        if let Some(parent) = note_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let metadata = NoteMetadata {
            id: id.clone(),
            title: request.title,
            file_name: file_name.clone(),
            category: category.clone(),
            created_at: now,
            updated_at: now,
            word_count,
            preview: preview(&request.content),
            tags: request.tags.clone(),
            pinned: request.pinned,
        };

        fs::write(&note_path, &request.content)?;
        let mut metadata_file = self.load_metadata()?;
        metadata_file.notes.push(metadata.clone());
        self.save_metadata(&metadata_file)?;

        let created = Note {
            id,
            title: metadata.title,
            file_name,
            category,
            created_at: now,
            updated_at: now,
            word_count,
            content: request.content,
            tags: metadata.tags,
            pinned: metadata.pinned,
        };
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        self.update_fts_after_mutation(&metadata_file, &[&created], &[]);
        Ok(created)
    }

    pub fn update_note(&self, id: &str, request: SaveNoteRequest) -> Result<Note, AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.update_note_unlocked(id, request)
    }

    pub(super) fn update_note_unlocked(
        &self,
        id: &str,
        request: SaveNoteRequest,
    ) -> Result<Note, AppError> {
        validate_note_id(id)?;
        self.ensure_storage()?;
        let mut metadata_file = self.load_metadata()?;
        let note = metadata_file
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| AppError::note_not_found(id))?;

        let old_file_name = note.file_name.clone();
        let old_category = note.category.clone();
        let new_file_name = self.file_name_for(id, &request.title);
        let new_category = request.category.clone();
        let now = Utc::now();
        let word_count = count_words(&request.content);

        let new_path = self.note_path_in_category(&new_file_name, &new_category)?;
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let old_path = self.note_path_in_category(&old_file_name, &old_category)?;
        let old_content = if old_path.exists() {
            let content = fs::read_to_string(&old_path)?;
            if content != request.content {
                self.save_note_version(id, &content)?;
            }
            Some(content)
        } else {
            None
        };
        fs::write(&new_path, &request.content)?;

        note.title = request.title;
        note.file_name = new_file_name.clone();
        note.category = new_category.clone();
        note.updated_at = now;
        note.word_count = word_count;
        note.preview = preview(&request.content);
        note.tags = request.tags;
        note.pinned = request.pinned;

        let result = Note {
            id: note.id.clone(),
            title: note.title.clone(),
            file_name: note.file_name.clone(),
            category: new_category.clone(),
            created_at: note.created_at,
            updated_at: note.updated_at,
            word_count: note.word_count,
            content: request.content,
            tags: note.tags.clone(),
            pinned: note.pinned,
        };

        self.save_metadata(&metadata_file).map_err(|error| {
            // 元数据提交失败时回滚刚写入的正文，避免"新正文配旧标题"的
            // 不一致状态；旧文件位置未变则把旧内容写回去
            if new_path != old_path {
                let _ = fs::remove_file(&new_path);
            } else if let Some(content) = old_content.as_ref() {
                let _ = fs::write(&old_path, content);
            }
            error
        })?;
        // 元数据提交成功后才清理旧文件；清理失败只会留下冗余副本，不能让一次
        // 编辑因为回收站不可用而丢掉原笔记。
        if (old_file_name != new_file_name || old_category != new_category)
            && old_path.exists()
            && old_path != new_path
        {
            if let Err(error) = trash::delete(&old_path) {
                eprintln!(
                    "[花笺] 新笔记已保存，但旧文件未能移入回收站 {}: {error}",
                    old_path.display()
                );
            }
        }
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        self.update_fts_after_mutation(&metadata_file, &[&result], &[]);
        Ok(result)
    }

    pub fn merge_notes(&self, request: MergeNotesRequest) -> Result<Note, AppError> {
        if request.target_id == request.source_id {
            return Err(AppError::new("mergeSameNote", "不能合并同一篇笔记"));
        }

        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        let target = self.read_note(&request.target_id)?;
        let source = self.read_note(&request.source_id)?;

        // Copy source images before touching either note. The merged Markdown must point to
        // the target note directory, otherwise deleting the source would leave broken images.
        let source_image_prefix = format!("images/{}/", source.id);
        let target_image_prefix = format!("images/{}/", target.id);
        if source.content.contains(&source_image_prefix) {
            let source_images = self.images_dir(&source.id)?;
            let target_images = self.images_dir(&target.id)?;
            if source_images.exists() {
                fs::create_dir_all(&target_images)?;
                for entry in fs::read_dir(source_images)? {
                    let entry = entry?;
                    if entry.path().is_file() {
                        fs::copy(entry.path(), target_images.join(entry.file_name()))?;
                    }
                }
            }
        }

        let source_title = source.title.trim();
        let source_heading = if source_title.is_empty() {
            "未命名笔记"
        } else {
            source_title
        };
        let source_content = source
            .content
            .replace(&source_image_prefix, &target_image_prefix);
        let separator = if target.content.trim().is_empty() {
            ""
        } else {
            "\n\n---\n\n"
        };
        let merged_content = format!(
            "{}{}## 合并自：{}\n\n{}",
            target.content, separator, source_heading, source_content
        );
        let mut merged_tags = target.tags.clone();
        for tag in source.tags {
            if !merged_tags.contains(&tag) {
                merged_tags.push(tag);
            }
        }

        let merged = self.update_note_unlocked(
            &target.id,
            SaveNoteRequest {
                title: target.title,
                content: merged_content,
                category: target.category,
                tags: merged_tags,
                pinned: target.pinned,
            },
        )?;

        let mut metadata_file = self.load_metadata()?;
        let source_index = metadata_file
            .notes
            .iter()
            .position(|note| note.id == source.id)
            .ok_or_else(|| AppError::note_not_found(&source.id))?;
        let source_metadata = metadata_file.notes.remove(source_index);
        let source_path =
            self.note_path_in_category(&source_metadata.file_name, &source_metadata.category)?;
        // 先提交清单；若回收站失败则把元数据放回去，源笔记仍可正常访问。
        self.save_metadata(&metadata_file)?;
        if source_path.exists() {
            if let Err(error) = trash::delete(&source_path) {
                metadata_file.notes.insert(source_index, source_metadata);
                let _ = self.save_metadata(&metadata_file);
                return Err(AppError::new("trash", format!("移入回收站失败: {error}")));
            }
        }
        let _ = self.delete_note_images(&source.id);
        let _ =
            crate::services::library::move_note_attachments(&self.data_dir, &source.id, &target.id);
        let source_history = self.note_history_dir(&source.id)?;
        if source_history.exists() {
            let _ = fs::remove_dir_all(source_history);
        }
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        self.update_fts_after_mutation(&metadata_file, &[&merged], &[&source.id]);

        Ok(merged)
    }

    pub fn delete_note(&self, id: &str) -> Result<(), AppError> {
        validate_note_id(id)?;
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        let mut metadata_file = self.load_metadata()?;
        let index = metadata_file
            .notes
            .iter()
            .position(|note| note.id == id)
            .ok_or_else(|| AppError::note_not_found(id))?;
        let metadata = metadata_file.notes.remove(index);
        let path = self.note_path_in_category(&metadata.file_name, &metadata.category)?;
        self.save_metadata(&metadata_file)?;
        if path.exists() {
            if let Err(error) = trash::delete(&path) {
                metadata_file.notes.insert(index, metadata);
                let _ = self.save_metadata(&metadata_file);
                return Err(AppError::new("trash", format!("移入回收站失败: {error}")));
            }
        }
        let _ = self.delete_note_images(id);
        let _ = crate::services::library::delete_note_attachments(&self.data_dir, id);
        let history_dir = self.note_history_dir(id)?;
        if history_dir.exists() {
            let _ = fs::remove_dir_all(history_dir);
        }
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        self.update_fts_after_mutation(&metadata_file, &[], &[id]);
        Ok(())
    }

    pub fn images_dir(&self, note_id: &str) -> Result<PathBuf, AppError> {
        validate_note_id(note_id)?;
        Ok(self.data_dir.join("images").join(note_id))
    }

    pub fn save_image(
        &self,
        note_id: &str,
        data: &[u8],
        extension: &str,
    ) -> Result<String, AppError> {
        self.ensure_storage()?;
        self.find_metadata(note_id)?;

        const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
        const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
        if data.len() > MAX_IMAGE_BYTES {
            return Err(AppError::new("imageTooLarge", "单张图片不能超过 50 MB"));
        }
        let ext = extension.to_ascii_lowercase();
        if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            return Err(AppError::new(
                "unsupportedImageFormat",
                format!("不支持的图片格式: {ext}"),
            ));
        }
        if !image_payload_matches_extension(data, &ext) {
            return Err(AppError::new("invalidImageData", "图片内容与扩展名不匹配"));
        }

        let dir = self.images_dir(note_id)?;
        fs::create_dir_all(&dir)?;

        let file_name = format!("{}.{}", Uuid::new_v4(), ext);
        fs::write(dir.join(&file_name), data)?;

        Ok(format!("images/{note_id}/{file_name}"))
    }

    pub fn open_daily_note(&self) -> Result<Note, AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        // 使用本地时区：东八区凌晨 0~8 点不应打开"昨天"的便笺
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let metadata = self.load_metadata()?;
        if let Some(existing) = metadata
            .notes
            .iter()
            .find(|note| note.tags.iter().any(|tag| tag == "daily") && note.title == date)
        {
            return self.read_note(&existing.id);
        }

        self.create_note_unlocked(SaveNoteRequest {
            title: date.clone(),
            content: format!("# {date}\n\n## 待办\n- [ ] \n\n## 随手记\n"),
            category: "每日便笺".into(),
            tags: vec!["daily".into()],
            pinned: false,
        })
    }

    pub fn delete_note_images(&self, note_id: &str) -> Result<(), AppError> {
        let dir = self.images_dir(note_id)?;
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    pub fn clean_unused_images(
        &self,
        note_id: &str,
        content: &str,
    ) -> Result<Vec<String>, AppError> {
        let dir = self.images_dir(note_id)?;
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut removed = Vec::new();
        let mut remaining = 0usize;
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let relative = format!("images/{note_id}/{file_name}");
            if !content.contains(&relative) {
                fs::remove_file(&path)?;
                removed.push(file_name);
            } else {
                remaining += 1;
            }
        }

        if remaining == 0 {
            let _ = fs::remove_dir(&dir);
        }

        Ok(removed)
    }

    pub fn import_markdown_file(&self, path: &Path, category: &str) -> Result<Note, AppError> {
        if !is_markdown_path(path) {
            return Err(AppError::unsupported_file());
        }
        // 与外部文件读取保持一致的大小上限，防止超大文件拖垮编辑器
        if fs::metadata(path)?.len() > 25 * 1024 * 1024 {
            return Err(AppError::new(
                "importTooLarge",
                "导入的 Markdown 文件不能超过 25 MB",
            ));
        }
        let content = fs::read_to_string(path)?;
        let title = imported_markdown_title(path, &content);
        self.create_note(SaveNoteRequest {
            title,
            content,
            category: category.to_string(),
            tags: Vec::new(),
            pinned: false,
        })
    }

    pub fn export_markdown_file(&self, id: &str, path: &Path) -> Result<(), AppError> {
        let note = self.read_note(id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, note.content)?;
        Ok(())
    }

    pub fn all_notes_for_index(&self) -> Result<Vec<Note>, AppError> {
        self.ensure_storage()?;
        let metadata = self.load_metadata()?;
        self.notes_for_metadata(&metadata)
    }

    /// 用户主动重建搜索索引时，同时重建 JSON 兼容索引和 SQLite FTS5。
    pub fn rebuild_search_index(&self) -> Result<(), AppError> {
        self.ensure_storage()?;
        let metadata = self.load_metadata()?;
        self.rebuild_derived_indexes(&metadata)
    }

    /// 远端同步落地变更后：持元数据锁重新对账笔记文件并全量重建派生索引（search-index.json + SQLite FTS5）。
    pub(crate) fn reload_indexes_after_sync(&self) -> Result<(), AppError> {
        let _lock = self.lock_metadata_mutation()?;
        invalidate_data_dir_reconciliation(&self.data_dir);
        self.ensure_storage()?;
        let metadata = self.load_metadata()?;
        self.rebuild_derived_indexes(&metadata)
    }

    pub fn search_content(
        &self,
        query: &str,
    ) -> Result<Vec<crate::services::library::SearchResult>, AppError> {
        self.ensure_storage()?;
        let metadata = self.load_metadata()?;
        // 搜索前确保索引新鲜：检测外部编辑器对 .md 的修改（指纹比对），
        // 需要时重建。搜索是低频操作，这里全库指纹的代价可接受
        self.ensure_fts_current(&metadata)?;
        if crate::services::db::is_initialized(&self.data_dir) {
            match self.search_fts(query) {
                Ok(results) if !results.is_empty() => return Ok(results),
                Ok(_) | Err(_) => {} // FTS 无结果或暂不可用时，权威 Markdown 回退搜索
            }
        }
        let notes = self.notes_for_metadata(&metadata)?;
        crate::services::library::search(&self.data_dir, query, &notes)
    }

    /// 使用 FTS5 全文搜索（trigram tokenizer）。摘要位置始终从原始 UTF-8 字符串
    /// 计算，不能复用 lowercase 后的字节偏移。
    fn search_fts(
        &self,
        query: &str,
    ) -> Result<Vec<crate::services::library::SearchResult>, AppError> {
        use crate::services::library::{safe_snippet, search_match_position, SearchResult};

        let ids = crate::services::db::db_search_fts(&self.data_dir, query)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let normalized = query.trim().to_lowercase();
        let mut results = Vec::new();
        for id in &ids {
            if let Ok(note) = self.read_note(id) {
                let title = if note.title.trim().is_empty() {
                    "无标题笔记".into()
                } else {
                    note.title.clone()
                };
                let content_pos = search_match_position(&note.content, &normalized);
                let title_pos = search_match_position(&note.title, &normalized);
                let (source, match_pos, match_start, match_length, score) =
                    if let Some((position, matched_term)) = content_pos {
                        (
                            &note.content,
                            position,
                            crate::services::library::utf16_offset_at_byte_for_search(
                                &note.content,
                                position,
                            ),
                            matched_term.encode_utf16().count() as isize,
                            10 + title_pos.map(|_| 8).unwrap_or(0),
                        )
                    } else if let Some((position, _)) = title_pos {
                        (&note.title, position, -1, -1, 18)
                    } else {
                        // FTS 可处理 trigram 边界匹配；没有精确子串时给出安全的内容开头。
                        (&note.content, 0, -1, -1, 5)
                    };
                results.push(SearchResult {
                    note_id: note.id,
                    title,
                    category: note.category,
                    snippet: safe_snippet(source, match_pos, query),
                    match_start,
                    match_length,
                    score,
                });
            }
        }

        results.sort_by_key(|result| std::cmp::Reverse(result.score));
        results.truncate(80);
        Ok(results)
    }

    pub fn add_attachment(
        &self,
        note_id: &str,
        source: &Path,
    ) -> Result<crate::services::library::Attachment, AppError> {
        self.read_note(note_id)?;
        crate::services::library::add_attachment(&self.data_dir, note_id, source)
    }

    pub fn list_attachments(
        &self,
        note_id: &str,
    ) -> Result<Vec<crate::services::library::Attachment>, AppError> {
        self.read_note(note_id)?;
        crate::services::library::list_attachments(&self.data_dir, note_id)
    }

    pub fn delete_attachment(&self, note_id: &str, attachment_id: &str) -> Result<(), AppError> {
        crate::services::library::delete_attachment(&self.data_dir, note_id, attachment_id)
    }

    pub fn attachment_path(&self, note_id: &str, attachment_id: &str) -> Result<PathBuf, AppError> {
        let attachment = self
            .list_attachments(note_id)?
            .into_iter()
            .find(|item| item.id == attachment_id)
            .ok_or_else(|| AppError::new("attachmentNotFound", "找不到附件"))?;
        Ok(self
            .data_dir
            .join("attachments")
            .join(note_id)
            .join(attachment.file_name))
    }

    pub fn create_backup(&self, destination: &Path) -> Result<(), AppError> {
        // 手动备份持元数据锁：避免在 "先写 .md → 再写 metadata.json" 的
        // 空窗内打包出"新正文配旧元数据"的混合备份
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        crate::services::library::create_manual_backup(&self.data_dir, destination)
    }

    pub fn ensure_daily_backup(
        &self,
    ) -> Result<Option<crate::services::library::BackupInfo>, AppError> {
        self.ensure_storage()?;
        crate::services::library::ensure_daily_backup(&self.data_dir)
    }

    pub fn list_backups(&self) -> Result<Vec<crate::services::library::BackupInfo>, AppError> {
        crate::services::library::list_backups(&self.data_dir)
    }

    pub fn restore_backup(&self, backup: &Path) -> Result<(), AppError> {
        let _lock = self.lock_metadata_mutation()?;
        // 恢复会整体替换 attachments.json / reminders.json：按固定顺序
        // （metadata → attachments → reminders）持有全部锁，避免与在途
        // 附件/提醒写入竞态；各写入路径只持单把锁，不会锁序颠倒
        crate::services::library::with_attachment_lock(|| {
            crate::services::reminders::with_lock(|| {
                crate::services::library::restore_backup(&self.data_dir, backup)
            })
        })?;
        invalidate_data_dir_reconciliation(&self.data_dir);
        // floral.db 不参与备份，恢复后的 JSON/Markdown 必须主动覆盖旧派生缓存。
        if let Err(error) = crate::services::db::reset_derived_data(&self.data_dir) {
            eprintln!("[花笺] 无法重置恢复前的 SQLite 缓存，将在后续访问时尝试重建: {error}");
        }
        self.ensure_storage()?;
        self.rebuild_search_index()
    }

    pub fn list_categories(&self) -> Result<Vec<String>, AppError> {
        let notes_dir = self.notes_dir();
        fs::create_dir_all(&notes_dir)?;
        let mut categories = Vec::new();
        for entry in fs::read_dir(&notes_dir)? {
            let entry = entry?;
            if entry.path().is_dir() {
                categories.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        categories.sort();
        Ok(categories)
    }

    pub fn create_category(&self, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::category_name_empty());
        }
        validate_category_name(name)?;
        let notes_dir = self.notes_dir();
        let path = notes_dir.join(name);
        fs::create_dir_all(&path)?;
        Ok(())
    }

    pub fn rename_category(&self, old_name: &str, new_name: &str) -> Result<(), AppError> {
        validate_category_name(old_name)?;
        let _lock = self.lock_metadata_mutation()?;
        let new_name = new_name.trim();
        validate_category_name(new_name)?;
        let notes_dir = self.notes_dir();
        let old_path = notes_dir.join(old_name);
        let new_path = notes_dir.join(new_name);
        if !old_path.exists() {
            return Err(AppError::category_not_found(old_name));
        }
        if new_path.exists() {
            return Err(AppError::category_already_exists(new_name));
        }
        fs::rename(&old_path, &new_path)?;

        let mut metadata_file = self.load_metadata()?;
        for note in &mut metadata_file.notes {
            if note.category == old_name {
                note.category = new_name.to_string();
            }
        }
        if let Err(error) = self.save_metadata(&metadata_file) {
            let _ = fs::rename(&new_path, &old_path);
            return Err(error);
        }
        self.update_fts_after_mutation(&metadata_file, &[], &[]);
        Ok(())
    }

    pub fn delete_category(&self, name: &str) -> Result<(), AppError> {
        validate_category_name(name)?;
        let _lock = self.lock_metadata_mutation()?;
        let notes_dir = self.notes_dir();
        let category_path = notes_dir.join(name);
        let dir_exists = category_path.exists();

        if dir_exists {
            // Safety: ensure the category path is actually inside notes_dir
            let canon_notes = fs::canonicalize(&notes_dir).unwrap_or_else(|_| notes_dir.clone());
            let canon_cat =
                fs::canonicalize(&category_path).unwrap_or_else(|_| category_path.clone());
            if !canon_cat.starts_with(&canon_notes) || canon_cat == canon_notes {
                return Err(AppError::new(
                    "unsafePath",
                    format!(
                        "拒绝删除「{}」：路径不在数据目录内",
                        category_path.display()
                    ),
                ));
            }

            // Move all notes in this category to uncategorized (root)
            let mut metadata_file = self.load_metadata()?;
            for note in &mut metadata_file.notes {
                if note.category == name {
                    let old_path = category_path.join(&note.file_name);
                    let new_path = notes_dir.join(&note.file_name);
                    if old_path.exists() {
                        fs::rename(&old_path, &new_path)?;
                    }
                    note.category = String::new();
                }
            }
            self.save_metadata(&metadata_file)?;
            self.update_fts_after_mutation(&metadata_file, &[], &[]);

            // Move to recycle bin instead of permanent deletion
            trash::delete(&category_path)
                .map_err(|e| AppError::new("trash", format!("移入回收站失败: {e}")))?;
        } else {
            // Directory already gone (manually deleted outside the app);
            // clean up any stale metadata references.
            let mut metadata_file = self.load_metadata()?;
            let mut changed = false;
            for note in &mut metadata_file.notes {
                if note.category == name {
                    note.category = String::new();
                    changed = true;
                }
            }
            if changed {
                self.save_metadata(&metadata_file)?;
                self.update_fts_after_mutation(&metadata_file, &[], &[]);
            }
        }
        Ok(())
    }

    pub fn move_note_to_category(
        &self,
        id: &str,
        new_category: &str,
    ) -> Result<NoteMetadata, AppError> {
        validate_note_id(id)?;
        validate_category_name(new_category)?;
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        let mut metadata_file = self.load_metadata()?;
        let note = metadata_file
            .notes
            .iter_mut()
            .find(|note| note.id == id)
            .ok_or_else(|| AppError::note_not_found(id))?;

        let old_category = note.category.clone();
        if old_category == new_category {
            return Ok(note.clone());
        }

        let old_path = self.note_path_in_category(&note.file_name, &old_category)?;
        let new_path = self.note_path_in_category(&note.file_name, new_category)?;
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if old_path.exists() {
            fs::rename(&old_path, &new_path)?;
        }

        note.category = new_category.to_string();
        let result = note.clone();
        if let Err(error) = self.save_metadata(&metadata_file) {
            if new_path.exists() && old_path != new_path {
                let _ = fs::rename(&new_path, &old_path);
            }
            return Err(error);
        }
        self.update_fts_after_mutation(&metadata_file, &[], &[]);
        Ok(result)
    }

    pub(super) fn lock_metadata_mutation(&self) -> Result<MetadataLockGuard, AppError> {
        let process = METADATA_MUTATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| AppError::new("metadataLock", "笔记存储锁已中毒，请重启应用后重试"))?;
        // 跨进程互斥：CLI 与 GUI 同时写同一数据目录时，文件锁保证
        // 读-改-写区间串行，避免后写者覆盖先写者导致整批条目丢失
        let lock_path = self.data_dir.join("metadata.json.lock");
        fs::create_dir_all(&self.data_dir)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| {
                AppError::new("metadataLock", format!("无法打开存储锁文件: {error}"))
            })?;
        file.lock_exclusive()
            .map_err(|error| AppError::new("metadataLock", format!("获取存储锁失败: {error}")))?;
        Ok(MetadataLockGuard {
            _process: process,
            _file: file,
        })
    }

    fn ensure_data_dir(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.data_dir)?;
        Ok(())
    }

    pub(super) fn ensure_storage(&self) -> Result<(), AppError> {
        self.ensure_data_dir()?;
        let _config = self.load_config()?;
        fs::create_dir_all(self.notes_dir())?;
        if let Err(error) = crate::services::db::init_db(&self.data_dir) {
            eprintln!("[花笺] SQLite 初始化失败，继续使用 Markdown/JSON: {error}");
        }

        let mut metadata = if !self.metadata_path().exists() {
            let rebuilt = self.rebuild_metadata()?;
            self.save_metadata(&rebuilt)?;
            rebuilt
        } else {
            let metadata = self.load_metadata()?;
            if metadata.notes.is_empty() && self.notes_dir_has_md_files() {
                let rebuilt = self.rebuild_metadata()?;
                self.save_metadata(&rebuilt)?;
                rebuilt
            } else {
                metadata
            }
        };
        if data_dir_needs_reconciliation(&self.data_dir) {
            if self.reconcile_metadata_with_files(&mut metadata)? {
                self.save_metadata(&metadata)?;
            }
            mark_data_dir_reconciled(&self.data_dir);
        }
        // 注意：不在每次 IPC 都调 ensure_fts_current（全库读 .md 算指纹代价高）；
        // 索引新鲜度由 mutation 路径增量更新 + 搜索前 ensure 保证
        Ok(())
    }

    pub(super) fn notes_dir(&self) -> PathBuf {
        self.data_dir.join("notes")
    }

    pub(super) fn note_path_in_category(
        &self,
        file_name: &str,
        category: &str,
    ) -> Result<PathBuf, AppError> {
        validate_note_file_name(file_name)?;
        validate_category_name(category)?;
        let notes_dir = self.notes_dir();
        Ok(if category.is_empty() {
            notes_dir.join(file_name)
        } else {
            notes_dir.join(category).join(file_name)
        })
    }

    fn find_metadata(&self, id: &str) -> Result<NoteMetadata, AppError> {
        validate_note_id(id)?;
        self.load_metadata()?
            .notes
            .into_iter()
            .find(|note| note.id == id)
            .ok_or_else(|| AppError::note_not_found(id))
    }

    fn file_name_for(&self, id: &str, title: &str) -> String {
        let safe_title = safe_file_stem(title);
        if safe_title.is_empty() {
            format!("{id}.md")
        } else {
            format!("{id}_{safe_title}.md")
        }
    }

    /// 从权威 JSON/Markdown 读取元数据。SQLite 只是派生索引，绝不反向覆盖这里。
    pub(super) fn load_metadata(&self) -> Result<MetadataFile, AppError> {
        self.ensure_data_dir()?;
        self.fallback_load_from_json_or_rebuild()
    }

    /// JSON / 文件系统回退加载。metadata.json 不存在或损坏时，Markdown 文件是最后的
    /// 权威来源；损坏 JSON 会保留副本，便于用户事后取证。
    fn fallback_load_from_json_or_rebuild(&self) -> Result<MetadataFile, AppError> {
        let path = self.metadata_path();
        if !path.exists() {
            let rebuilt = self.rebuild_metadata()?;
            self.save_metadata(&rebuilt)?;
            return Ok(rebuilt);
        }
        match serde_json::from_str(&fs::read_to_string(&path)?) {
            Ok(metadata) => {
                if let Err(error) = validate_metadata(&metadata) {
                    eprintln!("[花笺] metadata.json 包含不安全路径，将保留副本并重建: {error}");
                    self.back_up_corrupt_metadata(&path);
                    let rebuilt = self.rebuild_metadata()?;
                    self.save_metadata(&rebuilt)?;
                    Ok(rebuilt)
                } else {
                    Ok(metadata)
                }
            }
            Err(_) => {
                self.back_up_corrupt_metadata(&path);
                let rebuilt = self.rebuild_metadata()?;
                self.save_metadata(&rebuilt)?;
                Ok(rebuilt)
            }
        }
    }

    fn back_up_corrupt_metadata(&self, path: &Path) {
        // 随机后缀：同一秒内两次损坏不会 rename 失败导致取证副本丢失
        let corrupt_name = format!(
            "metadata.corrupt-{}-{}.json",
            Utc::now().format("%Y%m%d%H%M%S"),
            &Uuid::new_v4().to_string()[..8]
        );
        if let Err(error) = fs::rename(path, self.data_dir.join(corrupt_name)) {
            eprintln!(
                "failed to back up corrupt metadata {}: {error}",
                path.display()
            );
            return;
        }
        let Ok(mut backups) = fs::read_dir(&self.data_dir).map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("metadata.corrupt-")
                })
                .collect::<Vec<_>>()
        }) else {
            return;
        };
        backups.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
        for entry in backups.into_iter().skip(CORRUPT_METADATA_BACKUP_KEEP) {
            if let Err(error) = fs::remove_file(entry.path()) {
                eprintln!(
                    "failed to prune corrupt metadata backup {}: {error}",
                    entry.path().display()
                );
            }
        }
    }

    /// 先提交权威 JSON；SQLite 镜像失败不会把一次已成功落盘的笔记伪装成保存失败。
    /// 后续 FTS 指纹校验会自动重建该镜像。
    fn save_metadata(&self, metadata: &MetadataFile) -> Result<(), AppError> {
        validate_metadata(metadata)?;
        self.ensure_data_dir()?;
        write_json_atomic(&self.metadata_path(), metadata)?;
        if crate::services::db::is_initialized(&self.data_dir) {
            if let Err(error) =
                crate::services::db::db_notes_replace_all(&self.data_dir, &metadata.notes)
            {
                eprintln!("[花笺] SQLite 元数据镜像失败，将在后续自动重建: {error}");
            }
        }
        Ok(())
    }

    fn fts_fingerprint(&self, metadata: &MetadataFile) -> Result<String, AppError> {
        let mut notes = metadata.notes.iter().collect::<Vec<_>>();
        notes.sort_by(|left, right| left.id.cmp(&right.id));
        let mut hasher = blake3::Hasher::new();
        for note in notes {
            let updated_at = note.updated_at.to_rfc3339();
            for value in [
                note.id.as_str(),
                note.title.as_str(),
                note.file_name.as_str(),
                note.category.as_str(),
                updated_at.as_str(),
            ] {
                hasher.update(value.as_bytes());
                hasher.update(&[0]);
            }

            // Markdown 文件是正文权威来源。外部编辑不会更新 metadata.json，
            // 因此指纹必须包含正文内容，否则 SQLite FTS 会永久保留旧索引。
            let path = self.note_path_in_category(&note.file_name, &note.category)?;
            match fs::read(path) {
                Ok(content) => {
                    hasher.update(blake3::hash(&content).to_hex().as_bytes());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    hasher.update(b"<missing>");
                }
                Err(error) => return Err(error.into()),
            }
            hasher.update(&[0]);
        }
        Ok(hasher.finalize().to_hex().to_string())
    }

    fn notes_for_metadata(&self, metadata: &MetadataFile) -> Result<Vec<Note>, AppError> {
        metadata
            .notes
            .iter()
            .filter_map(|note| {
                let path = self
                    .note_path_in_category(&note.file_name, &note.category)
                    .ok()?;
                path.is_file().then_some((note, path))
            })
            .map(|(metadata, path)| {
                let content = fs::read_to_string(path)?;
                Ok(Note {
                    id: metadata.id.clone(),
                    title: metadata.title.clone(),
                    file_name: metadata.file_name.clone(),
                    category: metadata.category.clone(),
                    created_at: metadata.created_at,
                    updated_at: metadata.updated_at,
                    word_count: metadata.word_count,
                    content,
                    tags: metadata.tags.clone(),
                    pinned: metadata.pinned,
                })
            })
            .collect()
    }

    pub(super) fn rebuild_derived_indexes(&self, metadata: &MetadataFile) -> Result<(), AppError> {
        let notes = self.notes_for_metadata(metadata)?;
        // 保留 JSON 索引文件以兼容已有备份；回退搜索不会再信任它作为权威来源。
        crate::services::library::rebuild_search_index(&self.data_dir, &notes)?;
        if crate::services::db::is_initialized(&self.data_dir) {
            let fingerprint = self.fts_fingerprint(metadata)?;
            crate::services::db::db_rebuild_from_notes(&self.data_dir, &notes, &fingerprint)?;
        }
        Ok(())
    }

    fn ensure_fts_current(&self, metadata: &MetadataFile) -> Result<(), AppError> {
        if let Err(error) = crate::services::db::init_db(&self.data_dir) {
            eprintln!("[花笺] SQLite 初始化失败，改用本地回退搜索: {error}");
            return Ok(());
        }
        let fingerprint = self.fts_fingerprint(metadata)?;
        match crate::services::db::db_fts_is_current(&self.data_dir, &fingerprint) {
            Ok(true) => Ok(()),
            Ok(false) => self.rebuild_derived_indexes(metadata),
            Err(error) => {
                eprintln!("[花笺] FTS 状态读取失败，尝试重建: {error}");
                self.rebuild_derived_indexes(metadata)
            }
        }
    }

    fn update_fts_after_mutation(
        &self,
        metadata: &MetadataFile,
        upserts: &[&Note],
        deletes: &[&str],
    ) {
        if !crate::services::db::is_initialized(&self.data_dir) {
            return;
        }
        let fingerprint = match self.fts_fingerprint(metadata) {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                eprintln!("[花笺] 无法计算 FTS 指纹，将在下次访问时重建: {error}");
                return;
            }
        };
        let result = (|| -> Result<(), AppError> {
            for id in deletes {
                crate::services::db::db_fts_delete(&self.data_dir, id)?;
            }
            for note in upserts {
                crate::services::db::db_fts_upsert(
                    &self.data_dir,
                    &note.id,
                    &note.title,
                    &note.content,
                )?;
            }
            crate::services::db::db_set_fts_fingerprint(&self.data_dir, &fingerprint)
        })();
        if let Err(error) = result {
            eprintln!("[花笺] FTS 增量更新失败，将在下次访问时自动重建: {error}");
        }
    }
}

fn safe_file_stem(title: &str) -> String {
    let mut stem = String::new();
    let mut last_was_separator = false;

    for ch in title.trim().chars() {
        let should_separate = ch.is_whitespace()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || ch.is_control();

        if should_separate {
            if !stem.is_empty() && !last_was_separator {
                stem.push('_');
                last_was_separator = true;
            }
            continue;
        }

        stem.push(ch);
        last_was_separator = false;
        if stem.chars().count() >= 48 {
            break;
        }
    }

    stem.trim_matches('_').to_string()
}

fn image_payload_matches_extension(data: &[u8], extension: &str) -> bool {
    match extension {
        "png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => data.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "webp" => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "bmp" => data.starts_with(b"BM"),
        // SVG 是文本格式。它会作为 img 资源加载，仍限制为 SVG 根节点而非任意文本；
        // 同时拒绝内嵌 script（防止 render_html 开启时被当作 HTML 内联渲染的 XSS 面）
        "svg" => std::str::from_utf8(data)
            .ok()
            .map(|text| {
                let trimmed = text.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
                let has_script = text.to_ascii_lowercase().contains("<script");
                (trimmed.starts_with("<svg")
                    || (trimmed.starts_with("<?xml") && trimmed.contains("<svg")))
                    && !has_script
            })
            .unwrap_or(false),
        _ => false,
    }
}

pub(super) fn count_words(content: &str) -> usize {
    content.chars().filter(|ch| !ch.is_whitespace()).count()
}

pub(super) fn preview(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn imported_markdown_title(path: &Path, content: &str) -> String {
    let first_line = content.lines().next().unwrap_or_default();
    let first_line = first_line.trim_start_matches('\u{feff}').trim_start();

    if let Some(title) = first_line
        .strip_prefix("# ")
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        return title.to_string();
    }

    path.file_stem()
        .and_then(|file_stem| file_stem.to_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("导入笔记")
        .to_string()
}
