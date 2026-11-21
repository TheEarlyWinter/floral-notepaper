use super::config::{
    data_dir_from_notes_dir, has_isolated_env_override, MACOS_SHORTCUT_MIGRATION_MARKER,
};
use super::store::{count_words, preview};
use super::types::{AppConfig, AppError, MetadataFile, NoteMetadata};
use super::NoteStore;
use crate::json_io::write_json_atomic;
use chrono::{DateTime, Utc};
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

// 每次应用进程首次接触一个数据目录时，扫描一次未登记 Markdown。
// 这能恢复“文件已写入、metadata 尚未来得及提交”时留下的孤儿笔记，
// 又避免每一条 IPC 请求都递归扫描整个笔记库。
static RECONCILED_DATA_DIRS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

// 旧版无论 notesDir 指向哪里，metadata.json、images、backgrounds 都固定存放在旧主目录；
// 数据目录解析到其他位置时必须一并带走，否则笔记内图片引用全部失效、created_at 丢失
fn migrate_legacy_aux_data(legacy_base_dir: &Path, data_dir: &Path) {
    for item in ["metadata.json", "images", "backgrounds"] {
        let src = legacy_base_dir.join(item);
        let dst = data_dir.join(item);
        if !src.exists() || dst.exists() {
            continue;
        }
        if let Err(error) = move_path(&src, &dst) {
            eprintln!(
                "failed to migrate legacy {item} from {} to {}: {}",
                legacy_base_dir.display(),
                data_dir.display(),
                error.message
            );
        }
    }
}

// v1.0.4 之前没有 ensure_notes_suffix，自定义笔记目录下 .md 直接位于目录顶层、
// 分类是顶层子目录；新布局要求笔记位于 data_dir/notes 下，这里按旧 metadata 归位
fn rescue_loose_legacy_notes(legacy_base_dir: &Path, data_dir: &Path) {
    let notes_dir = data_dir.join("notes");
    let tracked = fs::read_to_string(legacy_base_dir.join("metadata.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<MetadataFile>(&content).ok());

    match tracked {
        Some(metadata) => {
            for note in &metadata.notes {
                let (src, dst) = if note.category.is_empty() {
                    (
                        data_dir.join(&note.file_name),
                        notes_dir.join(&note.file_name),
                    )
                } else {
                    (
                        data_dir.join(&note.category).join(&note.file_name),
                        notes_dir.join(&note.category).join(&note.file_name),
                    )
                };
                move_loose_note_file(&src, &dst);
            }
        }
        None => {
            // 旧 metadata 缺失时退化为整层扫描，与旧版重建逻辑一致：所有 .md 均视为笔记
            move_loose_note_files_in(data_dir, &notes_dir);
            let Ok(entries) = fs::read_dir(data_dir) else {
                return;
            };
            for entry in entries.filter_map(|entry| entry.ok()) {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                // 点前缀目录是 VCS / 应用配置（.git、.obsidian 等），绝非用户分类，
                // 连同保留目录一并跳过，避免把无关目录的 .md 误搬成笔记
                if name.starts_with('.')
                    || matches!(
                        name.as_str(),
                        "notes" | "images" | "backgrounds" | "updates"
                    )
                {
                    continue;
                }
                move_loose_note_files_in(&path, &notes_dir.join(&name));
            }
        }
    }
}

fn move_loose_note_files_in(from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(from) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        move_loose_note_file(&path, &to.join(entry.file_name()));
    }
}

// legacy 数据搬运：尽力而为，单个文件失败不中断整体迁移，故吞掉错误。
// 与下方 move_path 的"错误传播"语义刻意相反——调用方需据此选择
fn move_loose_note_file(src: &Path, dst: &Path) {
    if !src.is_file() || dst.exists() {
        return;
    }
    if let Some(parent) = dst.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if fs::rename(src, dst).is_err() && fs::copy(src, dst).is_ok() {
        let _ = fs::remove_file(src);
    }
}

// 关键路径搬运（aux data / 目录迁移）：失败必须向上传播，
// 与上方 move_loose_note_file 的"静默吞错"语义刻意相反
fn move_path(src: &Path, dst: &Path) -> Result<(), AppError> {
    if src.is_dir() {
        return move_or_copy_dir(src, dst);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_err() {
        fs::copy(src, dst)?;
        fs::remove_file(src)?;
    }
    Ok(())
}

pub(super) fn remap_path_prefix(path_str: &str, old_base: &Path, new_base: &Path) -> String {
    if path_str.is_empty() {
        return String::new();
    }
    match Path::new(path_str).strip_prefix(old_base) {
        Ok(relative) => new_base.join(relative).to_string_lossy().to_string(),
        Err(_) => path_str.to_string(),
    }
}

// 仅用于路径比较：解析符号链接并统一表示。Windows 上 fs::canonicalize 返回
// \\?\ verbatim 前缀，而 fallback 分支拿不到该前缀；若一边规范化成功、另一边走
// fallback，starts_with 前缀比较会失配，导致嵌套目录保护被绕过。这里统一剥离
// verbatim 前缀，保证两条路径处于同一表示空间
pub(super) fn canonical_for_compare(path: &Path) -> PathBuf {
    fn strip_verbatim(path: PathBuf) -> PathBuf {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            // UNC verbatim 前缀 \\?\UNC\server\share → \\server\share
            if let Some(unc) = rest.strip_prefix(r"UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            return PathBuf::from(rest);
        }
        path
    }

    if let Ok(canonical) = fs::canonicalize(path) {
        return strip_verbatim(canonical);
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = fs::canonicalize(parent) {
            return strip_verbatim(parent).join(name);
        }
    }
    path.to_path_buf()
}

fn reconciliation_key(path: &Path) -> PathBuf {
    canonical_for_compare(path)
}

pub(super) fn data_dir_needs_reconciliation(path: &Path) -> bool {
    let set = RECONCILED_DATA_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    set.lock()
        .map(|set| !set.contains(&reconciliation_key(path)))
        .unwrap_or(false)
}

pub(super) fn mark_data_dir_reconciled(path: &Path) {
    let set = RECONCILED_DATA_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut set) = set.lock() {
        set.insert(reconciliation_key(path));
    }
}

pub(super) fn invalidate_data_dir_reconciliation(path: &Path) {
    let Some(set) = RECONCILED_DATA_DIRS.get() else {
        return;
    };
    if let Ok(mut set) = set.lock() {
        set.remove(&reconciliation_key(path));
    }
}

pub(super) fn known_data_migration_candidates() -> Vec<PathBuf> {
    known_data_migration_candidates_for(env::var("HOME").ok(), env::var("USERPROFILE").ok())
}

pub(super) fn known_data_migration_candidates_for(
    home: Option<String>,
    userprofile: Option<String>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = home {
        let home = PathBuf::from(home);
        candidates.push(home.join("Documents").join("花笺"));
        candidates.push(
            home.join("Library")
                .join("Application Support")
                .join("花笺"),
        );
    }
    if let Some(profile) = userprofile {
        let profile = PathBuf::from(profile);
        candidates.push(profile.join("Documents").join("花笺"));
    }

    candidates
}

fn move_or_copy_dir(from: &Path, to: &Path) -> Result<(), AppError> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // cross-filesystem fallback
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    copy_dir_recursive(from, to)?;
    fs::remove_dir_all(from)?;
    Ok(())
}

pub(super) fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), AppError> {
    // 拒绝把目录复制进自身子目录：必须使用规范化后的路径比较，避免 Windows
    // 分隔符、大小写、junction 或 verbatim 前缀让词法 starts_with 失效。
    let canonical_from = canonical_for_compare(from);
    let canonical_to = canonical_for_compare(to);
    if canonical_to.starts_with(&canonical_from) && canonical_to != canonical_from {
        return Err(AppError::new("unsafePath", "目标目录不能位于源目录内部"));
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

impl NoteStore {
    pub(super) fn migrate_config_from_legacy(&self) -> Result<(), AppError> {
        // 显式指定了配置/数据目录环境变量或处于测试模式时保持隔离，避免空沙盒把用户真实旧目录搬走
        if cfg!(test) || has_isolated_env_override() {
            return Ok(());
        }
        self.migrate_config_from_candidates(&known_data_migration_candidates())
    }

    pub(super) fn migrate_config_from_candidates(
        &self,
        candidates: &[PathBuf],
    ) -> Result<(), AppError> {
        if self.config_path().exists() {
            return Ok(());
        }
        for old_dir in candidates {
            let old_config = old_dir.join("config.json");
            if !old_config.exists() {
                continue;
            }
            eprintln!(
                "migrating config from {} to {}",
                old_dir.display(),
                self.config_dir.display()
            );
            let old_str = fs::read_to_string(&old_config)?;
            let mut config: AppConfig = serde_json::from_str(&old_str)?;
            let resolved_data_dir = config
                .notes_dir
                .as_deref()
                .map(data_dir_from_notes_dir)
                .unwrap_or_else(|| old_dir.clone());

            // notesDir 不带 notes 后缀（v1.0.0–v1.0.3 的自定义目录），
            // 笔记散落在该目录顶层，先归位到 notes/ 子目录
            let notes_dir_is_loose = config
                .notes_dir
                .as_deref()
                .map(|nd| Path::new(nd) == resolved_data_dir.as_path())
                .unwrap_or(false);
            if notes_dir_is_loose {
                rescue_loose_legacy_notes(old_dir, &resolved_data_dir);
            }

            if resolved_data_dir != *old_dir {
                migrate_legacy_aux_data(old_dir, &resolved_data_dir);
            }

            config.background_image_path =
                remap_path_prefix(&config.background_image_path, old_dir, &resolved_data_dir);
            config.data_dir = Some(resolved_data_dir.to_string_lossy().to_string());
            config.notes_dir = None;
            config.last_known_base_dir = None;
            fs::create_dir_all(&self.config_dir)?;
            write_json_atomic(&self.config_path(), &config)?;
            let marker = old_dir.join(MACOS_SHORTCUT_MIGRATION_MARKER);
            if marker.exists() {
                let _ = fs::copy(
                    &marker,
                    self.config_dir.join(MACOS_SHORTCUT_MIGRATION_MARKER),
                );
            }
            return Ok(());
        }
        Ok(())
    }

    pub(super) fn notes_dir_has_md_files(&self) -> bool {
        // 递归扫描：笔记按分类存放在子目录中（notes/工作/x.md），
        // 只看根目录会漏掉所有已分类笔记，导致 rebuild_metadata 被错误跳过
        fn dir_has_md(dir: &Path) -> bool {
            let Ok(entries) = fs::read_dir(dir) else {
                return false;
            };
            entries.filter_map(|e| e.ok()).any(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    dir_has_md(&path)
                } else {
                    path.extension().and_then(|ext| ext.to_str()) == Some("md")
                }
            })
        }
        dir_has_md(&self.notes_dir())
    }

    pub(super) fn rebuild_metadata(&self) -> Result<MetadataFile, AppError> {
        let notes_dir = self.notes_dir();
        fs::create_dir_all(&notes_dir)?;
        let mut notes = Vec::new();

        // 递归扫描：与 notes_dir_has_md_files 的递归判断保持一致，
        // 手动放进深层子目录的 .md 也能被识别
        self.scan_dir_for_notes_recursive(&notes_dir, "", &mut notes)?;

        Ok(MetadataFile { notes })
    }

    fn scan_dir_for_notes_recursive(
        &self,
        dir: &Path,
        category: &str,
        notes: &mut Vec<NoteMetadata>,
    ) -> Result<(), AppError> {
        self.scan_dir_for_notes(dir, category, notes)?;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                // 深层子目录沿用最近一层分类名（第一层用目录名）
                let child_category = if category.is_empty() {
                    entry.file_name().to_string_lossy().to_string()
                } else {
                    category.to_string()
                };
                self.scan_dir_for_notes_recursive(&path, &child_category, notes)?;
            }
        }
        Ok(())
    }

    /// 将磁盘上可恢复、但 metadata.json 尚未登记的笔记纳入清单。
    /// 对已有 id，只有 metadata 指向的文件已不存在时才用扫描结果纠正路径，
    /// 这样可保留用户原有的标签、置顶和创建时间。
    pub(super) fn reconcile_metadata_with_files(
        &self,
        metadata: &mut MetadataFile,
    ) -> Result<bool, AppError> {
        let scanned = self.rebuild_metadata()?;
        let mut changed = false;
        for scanned_note in scanned.notes {
            // 兼容旧版 ID 前缀（v1.0.x 的 id-N 格式）：新逻辑下非 UUID 前缀的
            // 文件使用完整文件名作 ID，这里允许按旧前缀回退匹配 metadata
            let legacy_id = scanned_note
                .file_name
                .split_once('_')
                .map(|(id, _)| id.to_string());
            match metadata.notes.iter_mut().find(|note| {
                note.id == scanned_note.id
                    || (legacy_id.is_some()
                        && note.id == legacy_id.as_deref().unwrap_or("")
                        && note.file_name == scanned_note.file_name)
            }) {
                Some(existing) => {
                    let existing_path =
                        self.note_path_in_category(&existing.file_name, &existing.category)?;
                    if !existing_path.is_file() {
                        let tags = existing.tags.clone();
                        let pinned = existing.pinned;
                        let created_at = existing.created_at;
                        *existing = scanned_note;
                        existing.tags = tags;
                        existing.pinned = pinned;
                        existing.created_at = created_at;
                        changed = true;
                    }
                }
                None => {
                    metadata.notes.push(scanned_note);
                    changed = true;
                }
            }
        }
        // 清理死条目：metadata 中文件已不存在的笔记（外部删除 .md 后残留），
        // 与 list_notes 的过滤语义一致并落盘，避免死条目永久残留在
        // metadata.json、备份与全库指纹里
        let before = metadata.notes.len();
        metadata.notes.retain(|note| {
            self.note_path_in_category(&note.file_name, &note.category)
                .map(|path| path.is_file())
                .unwrap_or(false)
        });
        if metadata.notes.len() != before {
            changed = true;
        }
        Ok(changed)
    }

    fn scan_dir_for_notes(
        &self,
        dir: &Path,
        category: &str,
        notes: &mut Vec<NoteMetadata>,
    ) -> Result<(), AppError> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = id_from_file_name(&file_name) else {
                continue;
            };
            // 同名文件（如 `abc.md` 与 `abc_xxx.md`）可能产生相同 ID：
            // 扫描时跳过重复，避免读错内容、改错文件、误删笔记
            if notes.iter().any(|note| note.id == id) {
                eprintln!("[花笺] 跳过与已有笔记 ID 冲突的文件: {}", path.display());
                continue;
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            let title = infer_title(&file_name, &content);
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .map(DateTime::<Utc>::from)
                .unwrap_or_else(|_| Utc::now());

            notes.push(NoteMetadata {
                id,
                title,
                file_name,
                category: category.to_string(),
                created_at: modified,
                updated_at: modified,
                word_count: count_words(&content),
                preview: preview(&content),
                tags: Vec::new(),
                pinned: false,
            });
        }
        Ok(())
    }
}

fn is_uuid_like(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && parts
            .iter()
            .all(|part| part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn id_from_file_name(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".md")?;
    Some(
        stem.split_once('_')
            // 只有 UUID 前缀才是笔记 ID；`abc.md` 与 `abc_xxx.md` 这类
            // 非标准命名不会碰撞出相同 ID（修复同名文件串号问题）
            .filter(|(id, _)| is_uuid_like(id))
            .map(|(id, _)| id.to_string())
            .unwrap_or_else(|| stem.to_string()),
    )
}

fn infer_title(file_name: &str, content: &str) -> String {
    if let Some(title) = content
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
    {
        return title.to_string();
    }

    let stem = file_name.strip_suffix(".md").unwrap_or(file_name);
    stem.split_once('_')
        .map(|(_, title)| title.replace('_', " "))
        .unwrap_or_default()
}
