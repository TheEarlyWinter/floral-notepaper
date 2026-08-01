use crate::json_io::write_json_atomic;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    env, fmt, fs, io,
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};
use fs4::fs_std::FileExt;
use uuid::Uuid;

#[cfg(target_os = "macos")]
const DEFAULT_MACOS_GLOBAL_SHORTCUT: &str = "Command+Option+N";
#[cfg(target_os = "macos")]
const LEGACY_MACOS_GLOBAL_SHORTCUTS: [&str; 5] = [
    "Option+Space",
    "Alt+Space",
    "Ctrl+Option+Space",
    "Control+Option+Space",
    "Ctrl+Alt+Space",
];
const MACOS_SHORTCUT_MIGRATION_MARKER: &str = ".macos-shortcut-default-v3";
const NOTE_HISTORY_LIMIT: usize = 20;
const CORRUPT_METADATA_BACKUP_KEEP: usize = 5;

// default_store() 会为每个命令创建一个新的 NoteStore；这把进程内锁覆盖完整
// 读-改-写区间，避免多个窗口用旧 metadata.json 覆盖彼此的更新。
static METADATA_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// 元数据写锁的持有凭证：进程内互斥 + 跨进程文件锁，析构时自动释放。
struct MetadataLockGuard {
    _process: MutexGuard<'static, ()>,
    _file: fs::File,
}

// config.json 是唯一没有独立写锁的 JSON：多窗口并发保存设置会互相覆盖。
static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_config() -> Result<MutexGuard<'static, ()>, AppError> {
    CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| AppError::new("configLock", "配置锁已中毒，请重启应用后重试"))
}
// 每次应用进程首次接触一个数据目录时，扫描一次未登记 Markdown。
// 这能恢复“文件已写入、metadata 尚未来得及提交”时留下的孤儿笔记，
// 又避免每一条 IPC 请求都递归扫描整个笔记库。
static RECONCILED_DATA_DIRS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_locale")]
    pub locale: String,
    // 读入时可缺省（旧 config 无此字段），但返回前端前必在 load_config / save_config
    // 中被设为 Some。不加 skip_serializing_if：保证 dataDir 字段始终序列化输出，
    // 与前端 `dataDir: string` 契约一致，避免 None 时省略字段导致前端收到 undefined
    #[serde(default)]
    pub data_dir: Option<String>,
    pub global_shortcut: String,
    pub close_to_tray: bool,
    #[serde(default = "default_close_tab_shortcut")]
    pub close_tab_shortcut: String,
    pub autostart: bool,
    pub default_view_mode: String,
    #[serde(default = "default_note_auto_save")]
    pub note_auto_save: bool,
    #[serde(default = "default_note_surface_auto_save")]
    pub note_surface_auto_save: bool,
    #[serde(default = "default_tile_color")]
    pub tile_color: String,
    #[serde(default = "default_tile_color_mode")]
    pub tile_color_mode: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_surface_font_size")]
    pub surface_font_size: u32,
    #[serde(default = "default_tab_indent_size")]
    pub tab_indent_size: u32,
    #[serde(default = "default_external_file_auto_save")]
    pub external_file_auto_save: bool,
    #[serde(default)]
    pub background_image_path: String,
    #[serde(default = "default_background_fit")]
    pub background_fit: String,
    #[serde(default = "default_background_dim")]
    pub background_dim: f64,
    #[serde(default = "default_background_blur")]
    pub background_blur: f64,
    #[serde(default = "default_background_scale")]
    pub background_scale: f64,
    #[serde(default = "default_background_position")]
    pub background_position_x: f64,
    #[serde(default = "default_background_position")]
    pub background_position_y: f64,
    #[serde(default = "default_remember_surface_size")]
    pub remember_surface_size: bool,
    #[serde(default = "default_tile_ctrl_close")]
    pub tile_ctrl_close: bool,
    #[serde(default)]
    pub tile_double_click_to_edit: bool,
    #[serde(default)]
    pub tile_save_returns_to_pin: bool,
    #[serde(default)]
    pub tile_render_markdown: bool,
    #[serde(default)]
    pub tile_desktop_only: bool,
    #[serde(default)]
    pub render_html_markdown: bool,
    #[serde(default = "default_split_scroll_sync")]
    pub split_scroll_sync: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_height: Option<u32>,
    #[serde(default = "default_toggle_visibility_shortcut")]
    pub toggle_visibility_shortcut: String,
    #[serde(default = "default_open_at_cursor")]
    pub open_at_cursor: bool,
    #[serde(default = "default_preset_theme")]
    pub preset_theme: String,
    #[serde(default)]
    pub accent_color: String,
    #[serde(default = "default_code_theme")]
    pub code_theme: String,
    #[serde(default)]
    pub editor_font_family: String,
    #[serde(default = "default_editor_line_height")]
    pub editor_line_height: f64,
    #[serde(default)]
    pub editor_paragraph_spacing: u32,
    #[serde(default = "default_editor_width")]
    pub editor_width: String,
    #[serde(default = "default_sidebar_position")]
    pub sidebar_position: String,
    #[serde(default = "default_window_opacity")]
    pub window_opacity: f64,
    #[serde(default)]
    pub remember_window_size: bool,
    #[serde(default)]
    pub sidebar_item_order: Vec<String>,
    #[serde(default)]
    pub sidebar_category_order: Vec<String>,
    #[serde(default)]
    pub show_outline: bool,
    #[serde(default)]
    pub code_line_numbers: bool,
    #[serde(default = "default_link_preview")]
    pub link_preview: bool,
    #[serde(default)]
    pub custom_css: String,
    #[serde(default)]
    pub templates: Vec<NoteTemplate>,
    // Legacy fields — read from old config, never written back
    #[serde(default, skip_serializing)]
    pub notes_dir: Option<String>,
    #[serde(default, skip_serializing)]
    pub last_known_base_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteTemplate {
    pub id: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteRequest {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeNotesRequest {
    pub target_id: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub file_name: String,
    #[serde(default)]
    pub category: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub word_count: usize,
    pub preview: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub file_name: String,
    #[serde(default)]
    pub category: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub word_count: usize,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
}

impl AppError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: BTreeMap::new(),
        }
    }

    fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }

    fn note_not_found(id: &str) -> Self {
        Self::new("noteNotFound", format!("Note {id} was not found")).with_detail("noteId", id)
    }

    fn unsupported_file() -> Self {
        Self::new("unsupportedFile", "只支持导入 .md 文件")
    }

    fn category_name_empty() -> Self {
        Self::new("categoryNameEmpty", "分类名不能为空")
    }

    fn category_name_invalid_chars() -> Self {
        Self::new("categoryNameInvalidChars", "分类名不能包含特殊字符")
    }

    fn category_not_found(name: &str) -> Self {
        Self::new("categoryNotFound", format!("分类「{name}」不存在")).with_detail("category", name)
    }

    fn category_already_exists(name: &str) -> Self {
        Self::new("categoryAlreadyExists", format!("分类「{name}」已存在"))
            .with_detail("category", name)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        Self::new("io", error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("json", error.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        Self::new("tauri", error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MetadataFile {
    notes: Vec<NoteMetadata>,
}

fn unsafe_path_error(field: &str) -> AppError {
    AppError::new("unsafePath", format!("{field} 包含不安全路径"))
}

fn validate_single_path_component(value: &str, field: &str) -> Result<(), AppError> {
    if value.is_empty() || value.contains('\0') || value.contains(':') {
        return Err(unsafe_path_error(field));
    }

    let mut components = Path::new(value).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(unsafe_path_error(field)),
    }
}

pub(crate) fn validate_note_id(note_id: &str) -> Result<(), AppError> {
    validate_single_path_component(note_id, "note_id").map_err(|_| {
        AppError::new("invalidNoteId", "note_id 格式无效").with_detail("noteId", note_id)
    })
}

pub(crate) fn validate_category_name(category: &str) -> Result<(), AppError> {
    if category.is_empty() {
        return Ok(());
    }
    validate_single_path_component(category, "分类名")
        .map_err(|_| AppError::category_name_invalid_chars())
}

pub(crate) fn validate_relative_file_name(file_name: &str, field: &str) -> Result<(), AppError> {
    validate_single_path_component(file_name, field)
}

pub(crate) fn validate_note_file_name(file_name: &str) -> Result<(), AppError> {
    validate_relative_file_name(file_name, "笔记文件名")?;
    if Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("md"))
    {
        return Err(unsafe_path_error("笔记文件名"));
    }
    Ok(())
}

fn validate_metadata(metadata: &MetadataFile) -> Result<(), AppError> {
    for note in &metadata.notes {
        validate_note_id(&note.id)?;
        validate_category_name(&note.category)?;
        validate_note_file_name(&note.file_name)?;
    }
    Ok(())
}

pub(crate) fn validate_metadata_json(path: &Path) -> Result<(), AppError> {
    let metadata: MetadataFile = serde_json::from_str(&fs::read_to_string(path)?)
        .map_err(|_| AppError::new("backupInvalid", "备份中的 metadata.json 格式无效"))?;
    validate_metadata(&metadata).map_err(|error| {
        AppError::new(
            "backupInvalid",
            format!("备份元数据无效: {}", error.message),
        )
    })
}

#[derive(Debug, Clone)]
pub struct NoteStore {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

pub fn default_store() -> Result<NoteStore, AppError> {
    let config_dir = default_config_dir()?;
    let data_dir = resolve_data_dir(&config_dir)?;
    let store = NoteStore::new(config_dir, data_dir);
    // 必须先处理可能存在的数据目录迁移。若先创建 floral.db，空目标目录会被误判为
    // "已有用户数据"，从而跳过旧 JSON/Markdown 的迁移。
    store.load_config()?;
    if let Err(e) = crate::services::db::init_db(store.data_dir()) {
        eprintln!("[花笺] 数据库初始化失败，FTS5 搜索不可用: {e}");
    }
    Ok(store)
}

pub(crate) fn default_config_dir() -> Result<PathBuf, AppError> {
    if let Ok(path) = env::var("FLORAL_NOTEPAPER_CONFIG_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Some(dir) = dirs::config_dir() {
        return Ok(dir.join("floral-notepaper"));
    }
    Ok(env::current_dir()?.join("floral-notepaper"))
}

fn default_data_dir() -> Result<PathBuf, AppError> {
    if let Ok(path) = env::var("FLORAL_NOTEPAPER_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(dir) = dirs::data_dir() {
        return Ok(dir.join("花笺"));
    }

    if let Some(dir) = dirs::document_dir() {
        return Ok(dir.join("花笺"));
    }

    Ok(env::current_dir()?.join("data"))
}

fn resolve_data_dir(config_dir: &Path) -> Result<PathBuf, AppError> {
    if let Ok(path) = env::var("FLORAL_NOTEPAPER_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PartialConfig {
        data_dir: Option<String>,
        notes_dir: Option<String>,
    }

    fn data_dir_from_partial(partial: &PartialConfig) -> Option<PathBuf> {
        if let Some(ref data_dir) = partial.data_dir {
            return Some(PathBuf::from(data_dir));
        }
        if let Some(ref notes_dir) = partial.notes_dir {
            return Some(data_dir_from_notes_dir(notes_dir));
        }
        None
    }

    let config_path = config_dir.join("config.json");
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(partial) = serde_json::from_str::<PartialConfig>(&content) {
                if let Some(dir) = data_dir_from_partial(&partial) {
                    return Ok(dir);
                }
            }
        }
    }

    for old_dir in known_data_migration_candidates() {
        let old_config = old_dir.join("config.json");
        if !old_config.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&old_config) {
            if let Ok(partial) = serde_json::from_str::<PartialConfig>(&content) {
                if let Some(dir) = data_dir_from_partial(&partial) {
                    return Ok(dir);
                }
            }
        }
        return Ok(old_dir);
    }

    default_data_dir()
}

fn data_dir_from_notes_dir(notes_dir: &str) -> PathBuf {
    let path = Path::new(notes_dir);
    if path.file_name().and_then(|n| n.to_str()) == Some("notes") {
        if let Some(parent) = path.parent() {
            return parent.to_path_buf();
        }
    }
    path.to_path_buf()
}

// 这里故意不包含 floral.db / floral.db-wal / floral.db-shm：SQLite 是可重建的
// 派生索引。复制活动 WAL 文件会产生不完整快照，迁移后统一从 JSON/Markdown 重建。
const DATA_DIR_ITEMS: [&str; 9] = [
    "metadata.json",
    "notes",
    "images",
    "attachments",
    "attachments.json",
    "backgrounds",
    "history",
    "reminders.json",
    "search-index.json",
];
const DERIVED_DB_ITEMS: [&str; 3] = ["floral.db", "floral.db-wal", "floral.db-shm"];

fn remove_derived_database_files(data_dir: &Path) {
    crate::services::db::close_db(data_dir);
    for name in DERIVED_DB_ITEMS {
        let path = data_dir.join(name);
        if path.exists() {
            if let Err(error) = fs::remove_file(&path) {
                eprintln!(
                    "failed to remove derived database {}: {error}",
                    path.display()
                );
            }
        }
    }
}

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

fn remap_path_prefix(path_str: &str, old_base: &Path, new_base: &Path) -> String {
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
fn canonical_for_compare(path: &Path) -> PathBuf {
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

fn data_dir_needs_reconciliation(path: &Path) -> bool {
    let set = RECONCILED_DATA_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    set.lock()
        .map(|set| !set.contains(&reconciliation_key(path)))
        .unwrap_or(false)
}

fn mark_data_dir_reconciled(path: &Path) {
    let set = RECONCILED_DATA_DIRS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut set) = set.lock() {
        set.insert(reconciliation_key(path));
    }
}

fn invalidate_data_dir_reconciliation(path: &Path) {
    let Some(set) = RECONCILED_DATA_DIRS.get() else {
        return;
    };
    if let Ok(mut set) = set.lock() {
        set.remove(&reconciliation_key(path));
    }
}

fn known_data_migration_candidates() -> Vec<PathBuf> {
    known_data_migration_candidates_for(env::var("HOME").ok(), env::var("USERPROFILE").ok())
}

fn known_data_migration_candidates_for(
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

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), AppError> {
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

fn is_filesystem_root(path: &Path) -> bool {
    let path = path.to_string_lossy();
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return true;
    }
    // Windows drive root: "C:" or "D:" etc.
    if trimmed.len() == 2 {
        let bytes = trimmed.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return true;
        }
    }
    false
}

fn is_safe_data_dir(path: &Path) -> Result<(), AppError> {
    if is_filesystem_root(path) {
        return Err(AppError::new(
            "unsafePath",
            "不能将磁盘根目录设为数据目录，请选择一个子文件夹",
        ));
    }

    let normalized = path.to_string_lossy().to_lowercase();
    let blocked = [
        "\\windows",
        "\\program files",
        "\\program files (x86)",
        "\\system32",
        "\\syswow64",
    ];
    for suffix in &blocked {
        if normalized.ends_with(suffix) {
            return Err(AppError::new(
                "unsafePath",
                format!("不能将系统目录「{}」设为数据目录", path.display()),
            ));
        }
    }

    let real_components = path
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if real_components == 0 {
        return Err(AppError::new(
            "unsafePath",
            "数据目录路径不合法，请选择一个具体的文件夹",
        ));
    }

    Ok(())
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

    #[cfg(target_os = "macos")]
    fn macos_shortcut_migration_path(&self) -> PathBuf {
        self.config_dir.join(MACOS_SHORTCUT_MIGRATION_MARKER)
    }

    pub fn load_config(&self) -> Result<AppConfig, AppError> {
        let _lock = lock_config()?;
        self.ensure_config_dir()?;
        let path = self.config_path();
        if !path.exists() {
            self.migrate_config_from_legacy()?;
        }
        if !path.exists() {
            // 直接写盘创建默认配置（锁内），不再调 save_config 避免递归锁
            let mut config = self.default_config();
            config.data_dir = Some(self.data_dir.to_string_lossy().to_string());
            config.tab_indent_size = config.tab_indent_size.clamp(1, 8);
            is_safe_data_dir(&self.data_dir)?;
            fs::create_dir_all(self.data_dir.join("notes"))?;
            write_json_atomic(&path, &config)?;
            self.mark_macos_shortcut_migration_handled()?;
            return Ok(config);
        }

        let mut config: AppConfig = serde_json::from_str(&fs::read_to_string(&path)?)?;
        // config 中记录的 dataDir 是上次运行时数据所在位置；若本次 resolve 出的
        // self.data_dir 与之不同（如 FLORAL_NOTEPAPER_DATA_DIR 被改），尝试搬运旧数据
        self.migrate_data_dir_if_relocated(&mut config)?;
        config.data_dir = Some(self.data_dir.to_string_lossy().to_string());
        config.tab_indent_size = config.tab_indent_size.clamp(1, 8);
        // 只有内容实际变化才写盘：避免每次读取都 fsync 重写 config
        let mut serialized = serde_json::to_vec_pretty(&config)?;
        serialized.push(b'\n');
        if fs::read(&path).unwrap_or_default() != serialized {
            write_json_atomic(&path, &config)?;
        }
        fs::create_dir_all(self.data_dir.join("notes"))?;
        if self.migrate_macos_shortcut_default(&mut config)? {
            write_json_atomic(&path, &config)?;
        }
        Ok(config)
    }

    pub fn save_config(&self, mut config: AppConfig) -> Result<AppConfig, AppError> {
        let _lock = lock_config()?;
        self.ensure_config_dir()?;
        config.data_dir = Some(self.data_dir.to_string_lossy().to_string());
        config.tab_indent_size = config.tab_indent_size.clamp(1, 8);
        is_safe_data_dir(&self.data_dir)?;
        fs::create_dir_all(self.data_dir.join("notes"))?;
        write_json_atomic(&self.config_path(), &config)?;
        Ok(config)
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

    fn update_note_unlocked(&self, id: &str, request: SaveNoteRequest) -> Result<Note, AppError> {
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

    fn note_history_dir(&self, note_id: &str) -> Result<PathBuf, AppError> {
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
            2 => {
                segments[1].len() == 8 && segments[1].chars().all(|ch| ch.is_ascii_hexdigit())
            }
            _ => false,
        };
        if chrono::NaiveDateTime::parse_from_str(base, "%Y%m%dT%H%M%S%.fZ").is_err()
            || !suffix_ok
        {
            return Err(AppError::new("noteVersionNotFound", "找不到该历史版本"));
        }
        Ok(self
            .note_history_dir(note_id)?
            .join(format!("{version_id}.md")))
    }

    fn save_note_version(&self, note_id: &str, content: &str) -> Result<(), AppError> {
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

    fn lock_metadata_mutation(&self) -> Result<MetadataLockGuard, AppError> {
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
        file.lock_exclusive().map_err(|error| {
            AppError::new("metadataLock", format!("获取存储锁失败: {error}"))
        })?;
        Ok(MetadataLockGuard {
            _process: process,
            _file: file,
        })
    }

    fn default_config(&self) -> AppConfig {
        AppConfig {
            locale: default_locale(),
            data_dir: Some(self.data_dir.to_string_lossy().to_string()),
            #[cfg(target_os = "macos")]
            global_shortcut: DEFAULT_MACOS_GLOBAL_SHORTCUT.into(),
            #[cfg(not(target_os = "macos"))]
            global_shortcut: "Ctrl+Space".into(),
            close_to_tray: true,
            close_tab_shortcut: default_close_tab_shortcut(),
            autostart: false,
            default_view_mode: "split".into(),
            note_auto_save: true,
            note_surface_auto_save: true,
            tile_color: default_tile_color(),
            tile_color_mode: default_tile_color_mode(),
            theme: default_theme(),
            font_size: default_font_size(),
            surface_font_size: default_surface_font_size(),
            tab_indent_size: default_tab_indent_size(),
            external_file_auto_save: default_external_file_auto_save(),
            background_image_path: String::new(),
            background_fit: default_background_fit(),
            background_dim: default_background_dim(),
            background_blur: default_background_blur(),
            background_scale: default_background_scale(),
            background_position_x: default_background_position(),
            background_position_y: default_background_position(),
            remember_surface_size: default_remember_surface_size(),
            tile_ctrl_close: default_tile_ctrl_close(),
            tile_double_click_to_edit: false,
            tile_save_returns_to_pin: false,
            tile_render_markdown: false,
            tile_desktop_only: false,
            render_html_markdown: false,
            split_scroll_sync: true,
            surface_width: None,
            surface_height: None,
            toggle_visibility_shortcut: default_toggle_visibility_shortcut(),
            open_at_cursor: default_open_at_cursor(),
            preset_theme: default_preset_theme(),
            accent_color: String::new(),
            code_theme: default_code_theme(),
            editor_font_family: String::new(),
            editor_line_height: default_editor_line_height(),
            editor_paragraph_spacing: 0,
            editor_width: default_editor_width(),
            sidebar_position: default_sidebar_position(),
            window_opacity: default_window_opacity(),
            remember_window_size: false,
            sidebar_item_order: Vec::new(),
            sidebar_category_order: Vec::new(),
            show_outline: false,
            code_line_numbers: false,
            link_preview: default_link_preview(),
            custom_css: String::new(),
            templates: Vec::new(),
            notes_dir: None,
            last_known_base_dir: None,
        }
    }

    fn migrate_config_from_legacy(&self) -> Result<(), AppError> {
        self.migrate_config_from_candidates(&known_data_migration_candidates())
    }

    fn migrate_config_from_candidates(&self, candidates: &[PathBuf]) -> Result<(), AppError> {
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

    fn ensure_config_dir(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.config_dir)?;
        Ok(())
    }

    fn ensure_data_dir(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.data_dir)?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn migrate_macos_shortcut_default(&self, config: &mut AppConfig) -> Result<bool, AppError> {
        let migration_path = self.macos_shortcut_migration_path();
        if migration_path.exists() {
            return Ok(false);
        }

        let should_migrate = LEGACY_MACOS_GLOBAL_SHORTCUTS
            .iter()
            .any(|shortcut| shortcuts_equal(shortcut, &config.global_shortcut));
        if should_migrate {
            config.global_shortcut = DEFAULT_MACOS_GLOBAL_SHORTCUT.into();
        }

        self.mark_macos_shortcut_migration_handled()?;
        Ok(should_migrate)
    }

    #[cfg(not(target_os = "macos"))]
    fn migrate_macos_shortcut_default(&self, _config: &mut AppConfig) -> Result<bool, AppError> {
        Ok(false)
    }

    #[cfg(target_os = "macos")]
    fn mark_macos_shortcut_migration_handled(&self) -> Result<(), AppError> {
        fs::write(self.macos_shortcut_migration_path(), "done")?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    fn mark_macos_shortcut_migration_handled(&self) -> Result<(), AppError> {
        Ok(())
    }

    fn ensure_storage(&self) -> Result<(), AppError> {
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

    fn notes_dir(&self) -> PathBuf {
        self.data_dir.join("notes")
    }

    fn note_path_in_category(&self, file_name: &str, category: &str) -> Result<PathBuf, AppError> {
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
    fn load_metadata(&self) -> Result<MetadataFile, AppError> {
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

    fn rebuild_derived_indexes(&self, metadata: &MetadataFile) -> Result<(), AppError> {
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

    fn notes_dir_has_md_files(&self) -> bool {
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

    fn rebuild_metadata(&self) -> Result<MetadataFile, AppError> {
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
    fn reconcile_metadata_with_files(&self, metadata: &mut MetadataFile) -> Result<bool, AppError> {
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
                eprintln!(
                    "[花笺] 跳过与已有笔记 ID 冲突的文件: {}",
                    path.display()
                );
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

    pub fn migrate_data_to(&self, new_data_dir: &Path) -> Result<NoteStore, AppError> {
        // 迁移期间持元数据锁：避免与在途写命令竞态
        // （写旧目录的请求在清理阶段可能打到已删除的目录上）
        let _lock = self.lock_metadata_mutation()?;
        self.migrate_data_to_unlocked(new_data_dir)
    }

    fn migrate_data_to_unlocked(&self, new_data_dir: &Path) -> Result<NoteStore, AppError> {
        is_safe_data_dir(new_data_dir)?;
        let canonical_new = canonical_for_compare(new_data_dir);
        let canonical_current = canonical_for_compare(&self.data_dir);
        if canonical_new == canonical_current {
            return Ok(self.clone());
        }
        // 目标位于当前数据目录内部时，notes/images 等会被搬进自己的子目录，
        // 复制阶段自我递归、清理阶段连带删除新目录，必须拒绝
        if canonical_new.starts_with(&canonical_current) {
            return Err(AppError::new(
                "unsafePath",
                "新数据目录不能位于当前数据目录内部，请选择其他位置",
            ));
        }
        fs::create_dir_all(new_data_dir)?;
        // 读取当前配置但不修改其 data_dir；真正提交只发生在新目录已完成索引重建之后。
        let mut config = self.load_config()?;

        // 第一阶段：只复制不删除。中途失败时源数据完好、配置不变，重试时覆盖续传
        for item in DATA_DIR_ITEMS {
            let src = self.data_dir.join(item);
            let dst = new_data_dir.join(item);
            if !src.exists() {
                continue;
            }
            if src.is_dir() {
                copy_dir_recursive(&src, &dst)?;
            } else {
                fs::copy(&src, &dst)?;
            }
        }

        // 第二阶段：先从新目录的权威 JSON/Markdown 重建派生索引；这里失败时
        // 旧目录和旧配置仍完整保留，绝不把半迁移目录设为新的权威位置。
        let new_store = NoteStore::new(self.config_dir.clone(), new_data_dir.to_path_buf());
        if let Err(error) = crate::services::db::init_db(new_data_dir) {
            eprintln!("[花笺] 新数据目录 SQLite 初始化失败，将使用回退搜索: {error}");
        }
        let new_metadata = new_store.load_metadata()?;
        if let Err(error) = new_store.rebuild_derived_indexes(&new_metadata) {
            crate::services::db::close_db(new_data_dir);
            return Err(AppError::new(
                "dataMigration",
                format!("新数据目录索引重建失败，旧数据未删除: {error}"),
            ));
        }

        // 第三阶段：切换配置指向新目录（提交点）
        config.background_image_path =
            remap_path_prefix(&config.background_image_path, &self.data_dir, new_data_dir);
        config.data_dir = Some(new_data_dir.to_string_lossy().to_string());
        new_store.save_config(config)?;

        // 第四阶段：清理旧位置。失败只会留下冗余副本，不影响新目录的数据,
        // 但需记录日志：否则用户可能困惑哪份是权威数据
        for item in DATA_DIR_ITEMS {
            let src = self.data_dir.join(item);
            if src.is_dir() {
                if let Err(error) = fs::remove_dir_all(&src) {
                    eprintln!(
                        "data migrated, but failed to clean up old directory {}: {error}",
                        src.display()
                    );
                }
            } else if src.is_file() {
                if let Err(error) = fs::remove_file(&src) {
                    eprintln!(
                        "data migrated, but failed to clean up old file {}: {error}",
                        src.display()
                    );
                }
            }
        }
        // SQLite 不是需要搬运的用户数据；新位置已验证重建成功后再清理旧缓存。
        remove_derived_database_files(&self.data_dir);

        Ok(new_store)
    }

    // 跨重启自动迁移：config 持久化的 dataDir 与本次 resolve 的 self.data_dir 不一致时
    // （典型为修改 FLORAL_NOTEPAPER_DATA_DIR 环境变量），先完整复制，再重建派生索引，
    // 最后才删除旧数据。复制/重建任何一步失败，都不修改 config 且旧数据保持完整。
    fn migrate_data_dir_if_relocated(&self, config: &mut AppConfig) -> Result<(), AppError> {
        let Some(ref last_dir) = config.data_dir else {
            return Ok(());
        };
        let old_dir = PathBuf::from(last_dir);
        if canonical_for_compare(&old_dir) == canonical_for_compare(&self.data_dir)
            || !old_dir.exists()
        {
            return Ok(());
        }
        match self.data_dir_has_user_data() {
            Ok(true) => return Ok(()),
            Err(error) => return Err(error),
            Ok(false) => {}
        }

        eprintln!(
            "data dir relocated, migrating from {} to {}",
            old_dir.display(),
            self.data_dir.display()
        );
        fs::create_dir_all(&self.data_dir)?;
        let mut copied_items = Vec::new();
        let copy_result = (|| -> Result<(), AppError> {
            for item in DATA_DIR_ITEMS {
                let src = old_dir.join(item);
                let dst = self.data_dir.join(item);
                if !src.exists() {
                    continue;
                }
                if src.is_dir() {
                    copy_dir_recursive(&src, &dst)?;
                } else {
                    fs::copy(&src, &dst)?;
                }
                copied_items.push(item);
            }
            if let Err(error) = crate::services::db::init_db(&self.data_dir) {
                eprintln!("[花笺] 重定位目标 SQLite 初始化失败，将使用回退搜索: {error}");
            }
            let metadata = self.load_metadata()?;
            self.rebuild_derived_indexes(&metadata)?;
            Ok(())
        })();

        if let Err(error) = copy_result {
            // 目标此前确认没有用户数据，因此失败时仅清理本次写入，不触碰旧目录。
            for item in copied_items {
                let path = self.data_dir.join(item);
                let _ = if path.is_dir() {
                    fs::remove_dir_all(path)
                } else {
                    fs::remove_file(path)
                };
            }
            remove_derived_database_files(&self.data_dir);
            return Err(AppError::new(
                "dataMigration",
                format!("数据目录迁移失败，旧数据未删除: {error}"),
            ));
        }

        for item in DATA_DIR_ITEMS {
            let src = old_dir.join(item);
            if src.is_dir() {
                if let Err(error) = fs::remove_dir_all(&src) {
                    eprintln!(
                        "data migrated, but failed to clean up {}: {error}",
                        src.display()
                    );
                }
            } else if src.is_file() {
                if let Err(error) = fs::remove_file(&src) {
                    eprintln!(
                        "data migrated, but failed to clean up {}: {error}",
                        src.display()
                    );
                }
            }
        }
        remove_derived_database_files(&old_dir);
        config.background_image_path =
            remap_path_prefix(&config.background_image_path, &old_dir, &self.data_dir);
        Ok(())
    }

    // 新数据目录是否已有用户数据（config.json 不算，它属于配置目录、且可能与数据目录重合）
    fn data_dir_has_user_data(&self) -> Result<bool, AppError> {
        if !self.data_dir.exists() {
            return Ok(false);
        }
        for entry in fs::read_dir(&self.data_dir)? {
            let entry = entry?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                return Ok(true);
            };
            if name == "config.json" || name == MACOS_SHORTCUT_MIGRATION_MARKER {
                continue;
            }
            return Ok(true);
        }
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
fn shortcuts_equal(left: &str, right: &str) -> bool {
    fn normalize(value: &str) -> String {
        value
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .flat_map(|ch| ch.to_lowercase())
            .collect()
    }

    normalize(left) == normalize(right)
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
                let has_script = text
                    .to_ascii_lowercase()
                    .contains("<script");
                (trimmed.starts_with("<svg")
                    || (trimmed.starts_with("<?xml") && trimmed.contains("<svg")))
                    && !has_script
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn count_words(content: &str) -> usize {
    content.chars().filter(|ch| !ch.is_whitespace()).count()
}

fn preview(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
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

fn default_note_auto_save() -> bool {
    true
}

fn default_note_surface_auto_save() -> bool {
    true
}

fn default_tile_color() -> String {
    "#f6f3ec".into()
}

fn default_close_tab_shortcut() -> String {
    "Ctrl+W".into()
}

fn default_tile_color_mode() -> String {
    "system".into()
}

fn default_theme() -> String {
    "system".into()
}

fn default_font_size() -> u32 {
    14
}

fn default_surface_font_size() -> u32 {
    14
}

fn default_tab_indent_size() -> u32 {
    2
}

fn default_external_file_auto_save() -> bool {
    true
}

fn default_background_fit() -> String {
    "cover".into()
}

fn default_background_dim() -> f64 {
    0.25
}

fn default_background_blur() -> f64 {
    0.0
}

fn default_background_scale() -> f64 {
    1.0
}

fn default_background_position() -> f64 {
    50.0
}

fn default_remember_surface_size() -> bool {
    true
}

fn default_tile_ctrl_close() -> bool {
    true
}

fn default_split_scroll_sync() -> bool {
    true
}

fn default_toggle_visibility_shortcut() -> String {
    String::new()
}

fn default_open_at_cursor() -> bool {
    true
}

fn default_preset_theme() -> String {
    "default".into()
}

fn default_code_theme() -> String {
    "light".into()
}

fn default_editor_line_height() -> f64 {
    1.8
}

fn default_editor_width() -> String {
    "normal".into()
}

fn default_sidebar_position() -> String {
    "left".into()
}

fn default_window_opacity() -> f64 {
    1.0
}

fn default_link_preview() -> bool {
    true
}

fn default_locale() -> String {
    "zh-CN".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn test_root(name: &str) -> PathBuf {
        let base = std::env::var_os("FLORAL_NOTEPAPER_TEST_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("floral-notepaper-rust-tests"));
        let root = base.join(name);
        if root.exists() {
            fs::remove_dir_all(&root).expect("remove stale test root");
        }
        fs::create_dir_all(&root).expect("create test root");
        root
    }

    fn test_store(name: &str) -> NoteStore {
        let root = test_root(name);
        let store = NoteStore::new(root.clone(), root);
        // 先写入独立配置，避免测试在开发机上误迁移用户的真实旧数据目录。
        write_json_atomic(&store.config_path(), &store.default_config())
            .expect("write isolated test config");
        store
    }

    #[test]
    fn creates_updates_reads_and_deletes_markdown_notes() {
        let store = test_store("crud");

        let created = store
            .create_note(SaveNoteRequest {
                title: "A/B:Test".into(),
                content: "hello\nworld".into(),
                category: String::new(),
                tags: vec!["work".into(), "urgent".into()],
                pinned: true,
            })
            .expect("create note");

        assert_eq!(created.title, "A/B:Test");
        assert_eq!(created.tags, ["work", "urgent"]);
        assert!(created.pinned);
        assert_eq!(created.content, "hello\nworld");
        assert_eq!(created.word_count, 10);
        assert!(created.file_name.ends_with(".md"));
        assert!(created.file_name.contains("A_B_Test"));

        let loaded = store.read_note(&created.id).expect("read note");
        assert_eq!(loaded, created);

        let listed = store.list_notes().expect("list notes");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].preview, "hello world");

        let updated = store
            .update_note(
                &created.id,
                SaveNoteRequest {
                    title: "".into(),
                    content: "# 新标题\nsecond line".into(),
                    category: String::new(),
                    tags: vec!["archive".into()],
                    pinned: false,
                },
            )
            .expect("update note");

        assert_eq!(updated.title, "");
        assert_eq!(updated.tags, ["archive"]);
        assert!(!updated.pinned);
        assert_eq!(updated.content, "# 新标题\nsecond line");
        assert_ne!(updated.file_name, created.file_name);

        store.delete_note(&created.id).expect("delete note");
        assert!(store.read_note(&created.id).is_err());
        assert!(store.list_notes().expect("list after delete").is_empty());
    }

    #[test]
    fn rejects_unsafe_note_paths_and_recovers_unsafe_metadata() {
        let store = test_store("unsafe-paths");
        assert!(store
            .create_note(SaveNoteRequest {
                title: "越界分类".into(),
                content: "不应写入分类目录外".into(),
                category: "../outside".into(),
                tags: Vec::new(),
                pinned: false,
            })
            .is_err());
        assert!(store.create_category(".").is_err());

        let note = store
            .create_note(SaveNoteRequest {
                title: "安全笔记".into(),
                content: "正文".into(),
                category: String::new(),
                tags: vec!["保留".into()],
                pinned: true,
            })
            .expect("create note");
        let metadata_path = store.metadata_path();
        let metadata = fs::read_to_string(&metadata_path).expect("read metadata");
        fs::write(
            &metadata_path,
            metadata.replace(&note.file_name, "../escape.md"),
        )
        .expect("write unsafe metadata");

        let recovered = store.list_notes().expect("recover unsafe metadata");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, note.id);
        assert!(
            store.data_dir().join("metadata.corrupt-").exists()
                || fs::read_dir(store.data_dir())
                    .expect("read data directory")
                    .filter_map(|entry| entry.ok())
                    .any(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("metadata.corrupt-")
                    })
        );
    }

    #[test]
    fn merges_notes_preserving_target_history_and_combining_tags() {
        let store = test_store("merge-notes");
        let target = store
            .create_note(SaveNoteRequest {
                title: "目标笔记".into(),
                content: "目标内容".into(),
                category: "学习".into(),
                tags: vec!["机械".into()],
                pinned: true,
            })
            .expect("create target");
        let source = store
            .create_note(SaveNoteRequest {
                title: "来源笔记".into(),
                content: "来源内容".into(),
                category: "收件箱".into(),
                tags: vec!["机械".into(), "待整理".into()],
                pinned: false,
            })
            .expect("create source");

        let merged = store
            .merge_notes(MergeNotesRequest {
                target_id: target.id.clone(),
                source_id: source.id.clone(),
            })
            .expect("merge notes");

        assert!(merged.content.contains("目标内容"));
        assert!(merged.content.contains("## 合并自：来源笔记"));
        assert!(merged.content.contains("来源内容"));
        assert_eq!(merged.category, "学习");
        assert!(merged.pinned);
        assert_eq!(merged.tags, ["机械", "待整理"]);
        assert!(store.read_note(&source.id).is_err());
        assert_eq!(store.list_notes().expect("list notes").len(), 1);
        assert_eq!(
            store.list_note_versions(&target.id).expect("history").len(),
            1
        );
        assert!(store
            .merge_notes(MergeNotesRequest {
                target_id: target.id.clone(),
                source_id: target.id,
            })
            .is_err());
    }

    #[test]
    fn serializes_concurrent_note_creations_without_losing_metadata() {
        let store = std::sync::Arc::new(test_store("concurrent-create"));
        let mut workers = Vec::new();
        for index in 0..2 {
            let store = store.clone();
            workers.push(std::thread::spawn(move || {
                store.create_note(SaveNoteRequest {
                    title: format!("并发笔记 {index}"),
                    content: format!("正文 {index}"),
                    category: String::new(),
                    tags: Vec::new(),
                    pinned: false,
                })
            }));
        }
        for worker in workers {
            worker.join().expect("join worker").expect("create note");
        }

        let notes = store.list_notes().expect("list concurrent notes");
        assert_eq!(notes.len(), 2);
    }

    #[test]
    fn keeps_note_versions_and_restores_a_previous_content_snapshot() {
        let store = test_store("history");
        let created = store
            .create_note(SaveNoteRequest {
                title: "历史测试".into(),
                content: "第一版".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");

        store
            .update_note(
                &created.id,
                SaveNoteRequest {
                    title: "历史测试".into(),
                    content: "第二版".into(),
                    category: String::new(),
                    tags: Vec::new(),
                    pinned: false,
                },
            )
            .expect("update note");

        let versions = store
            .list_note_versions(&created.id)
            .expect("list versions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].preview, "第一版");

        let restored = store
            .restore_note_version(&created.id, &versions[0].id)
            .expect("restore version");
        assert_eq!(restored.content, "第一版");
        // 恢复前的第二版也会被保留为可再次恢复的快照。
        assert_eq!(
            store
                .list_note_versions(&created.id)
                .expect("list restored history")
                .len(),
            2
        );
    }

    #[test]
    fn keeps_at_most_twenty_note_versions() {
        let store = test_store("history-limit");
        let created = store
            .create_note(SaveNoteRequest {
                title: "历史上限".into(),
                content: "版本 0".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");

        for index in 1..=25 {
            store
                .update_note(
                    &created.id,
                    SaveNoteRequest {
                        title: "历史上限".into(),
                        content: format!("版本 {index}"),
                        category: String::new(),
                        tags: Vec::new(),
                        pinned: false,
                    },
                )
                .expect("update note");
        }

        assert_eq!(
            store
                .list_note_versions(&created.id)
                .expect("list versions")
                .len(),
            20
        );
    }

    #[test]
    fn opens_the_same_daily_note_for_the_same_day() {
        let store = test_store("daily-note");
        let first = store.open_daily_note().expect("open first daily note");
        let second = store.open_daily_note().expect("open second daily note");

        assert_eq!(first.id, second.id);
        assert!(first.tags.iter().any(|tag| tag == "daily"));
        assert_eq!(store.list_notes().expect("list daily note").len(), 1);
    }

    #[test]
    fn rebuilds_metadata_when_metadata_json_is_corrupt() {
        let store = test_store("repair");
        let first = store
            .create_note(SaveNoteRequest {
                title: "第一条".into(),
                content: "# 第一条\n正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create first");
        let second = store
            .create_note(SaveNoteRequest {
                title: "第二条".into(),
                content: "第二条正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create second");

        fs::write(store.metadata_path(), "{ broken json").expect("corrupt metadata");

        let repaired = store.list_notes().expect("repair metadata");
        let ids: Vec<_> = repaired.iter().map(|note| note.id.as_str()).collect();

        assert_eq!(repaired.len(), 2);
        assert!(ids.contains(&first.id.as_str()));
        assert!(ids.contains(&second.id.as_str()));

        // 损坏文件被备份保留，供事后取证分析
        let corrupt_backup = fs::read_dir(store.data_dir())
            .expect("read data dir")
            .filter_map(|entry| entry.ok())
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("metadata.corrupt-")
            });
        assert!(corrupt_backup, "corrupt metadata should be backed up");
    }

    #[test]
    fn reads_and_writes_config_json() {
        let store = test_store("config");
        fs::create_dir_all(store.config_dir.as_path()).expect("create config dir");
        write_json_atomic(&store.config_path(), &store.default_config())
            .expect("write default config");

        let default_config = store.load_config().expect("load default config");
        #[cfg(target_os = "macos")]
        assert_eq!(default_config.global_shortcut, "Command+Option+N");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(default_config.global_shortcut, "Ctrl+Space");
        assert!(default_config.note_auto_save);
        assert!(default_config.note_surface_auto_save);
        assert_eq!(default_config.tile_color, "#f6f3ec");
        assert_eq!(default_config.tile_color_mode, "system");
        assert!(!default_config.tile_double_click_to_edit);
        assert!(!default_config.tile_save_returns_to_pin);
        assert!(!default_config.tile_desktop_only);
        assert_eq!(default_config.theme, "system");
        assert_eq!(default_config.preset_theme, "default");
        assert_eq!(default_config.code_theme, "light");
        assert_eq!(default_config.editor_line_height, 1.8);
        assert_eq!(default_config.window_opacity, 1.0);
        assert!(default_config.link_preview);
        assert!(default_config.templates.is_empty());
        assert_eq!(default_config.locale, "zh-CN");
        assert_eq!(
            default_config.data_dir.as_deref(),
            Some(store.data_dir().to_string_lossy().as_ref())
        );

        let mut saved = AppConfig {
            locale: "en-US".into(),
            data_dir: None,
            global_shortcut: "Alt+Space".into(),
            close_to_tray: false,
            close_tab_shortcut: default_close_tab_shortcut(),
            autostart: true,
            default_view_mode: "preview".into(),
            note_auto_save: false,
            note_surface_auto_save: false,
            tile_color: "#efe8dc".into(),
            tile_color_mode: "custom".into(),
            theme: "dark".into(),
            font_size: 16,
            surface_font_size: 16,
            tab_indent_size: 2,
            external_file_auto_save: true,
            background_image_path: String::new(),
            background_fit: "cover".into(),
            background_dim: 0.25,
            background_blur: 0.0,
            background_scale: 1.0,
            background_position_x: 50.0,
            background_position_y: 50.0,
            remember_surface_size: true,
            tile_ctrl_close: true,
            tile_double_click_to_edit: true,
            tile_save_returns_to_pin: true,
            tile_render_markdown: false,
            tile_desktop_only: true,
            render_html_markdown: false,
            split_scroll_sync: true,
            surface_width: None,
            surface_height: None,
            toggle_visibility_shortcut: String::new(),
            preset_theme: "paper".into(),
            accent_color: "#7a5b32".into(),
            code_theme: "dark".into(),
            editor_font_family: "Source Han Serif SC".into(),
            editor_line_height: 2.0,
            editor_paragraph_spacing: 12,
            editor_width: "wide".into(),
            sidebar_position: "right".into(),
            window_opacity: 0.85,
            remember_window_size: true,
            sidebar_item_order: vec!["inbox".into(), "daily".into()],
            sidebar_category_order: vec!["学习".into(), "生活".into()],
            show_outline: true,
            code_line_numbers: true,
            link_preview: false,
            custom_css: ".note { color: red; }".into(),
            templates: vec![NoteTemplate {
                id: "study".into(),
                name: "学习笔记".into(),
                content: "# 标题\n".into(),
            }],
            notes_dir: None,
            last_known_base_dir: None,
            open_at_cursor: true,
        };

        store.save_config(saved.clone()).expect("save config");

        let loaded = store.load_config().expect("reload config");
        saved.data_dir = Some(store.data_dir().to_string_lossy().to_string());
        assert_eq!(loaded, saved);
        assert_eq!(loaded.templates[0].name, "学习笔记");
    }

    #[test]
    fn data_migration_candidates_include_legacy_chinese_dirs() {
        let candidates = known_data_migration_candidates_for(
            Some("/Users/alice".into()),
            Some(r"C:\Users\Alice".into()),
        );

        assert!(candidates.contains(&PathBuf::from("/Users/alice").join("Documents").join("花笺")));
        assert!(candidates.contains(
            &PathBuf::from("/Users/alice")
                .join("Library")
                .join("Application Support")
                .join("花笺")
        ));
        assert!(candidates.contains(
            &PathBuf::from(r"C:\Users\Alice")
                .join("Documents")
                .join("花笺")
        ));
    }

    #[test]
    fn loads_legacy_config_with_note_surface_auto_save_enabled() {
        let store = test_store("legacy-config");
        let notes_dir = store.data_dir().join("notes");
        fs::create_dir_all(&notes_dir).expect("create notes dir");
        fs::write(
            store.config_path(),
            format!(
                r#"{{
  "notesDir": "{}",
  "globalShortcut": "Ctrl+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split"
}}"#,
                notes_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write legacy config");

        let loaded = store.load_config().expect("load legacy config");

        assert!(loaded.note_auto_save);
        assert!(loaded.note_surface_auto_save);
        assert_eq!(loaded.tile_color, "#f6f3ec");
        assert_eq!(loaded.tile_color_mode, "system");
        assert!(!loaded.tile_double_click_to_edit);
        assert!(!loaded.tile_save_returns_to_pin);
        assert_eq!(loaded.theme, "system");
        assert_eq!(loaded.preset_theme, "default");
        assert_eq!(loaded.code_theme, "light");
        assert_eq!(loaded.editor_line_height, 1.8);
        assert_eq!(loaded.window_opacity, 1.0);
        assert!(loaded.link_preview);
        assert_eq!(loaded.locale, "zh-CN");
        assert_eq!(loaded.font_size, 14);
        assert_eq!(loaded.surface_font_size, 14);
    }

    fn legacy_config_json(notes_dir: &Path, background_image_path: &str) -> String {
        format!(
            r#"{{
  "notesDir": "{}",
  "globalShortcut": "Ctrl+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split",
  "backgroundImagePath": "{}"
}}"#,
            notes_dir.to_string_lossy().replace('\\', "\\\\"),
            background_image_path.replace('\\', "\\\\")
        )
    }

    #[test]
    fn migrates_legacy_aux_data_when_notes_dir_was_customized() {
        let root = test_root("legacy-aux-migration");
        let old_dir = root.join("old-base");
        let custom_dir = root.join("custom");
        let custom_notes = custom_dir.join("notes");
        fs::create_dir_all(&custom_notes).expect("create custom notes dir");
        fs::write(custom_notes.join("id-1_笔记.md"), "# 标题\n内容").expect("write note");

        fs::create_dir_all(old_dir.join("images").join("id-1")).expect("create images dir");
        fs::write(old_dir.join("images").join("id-1").join("p.png"), b"png").expect("write image");
        fs::create_dir_all(old_dir.join("backgrounds")).expect("create backgrounds dir");
        fs::write(old_dir.join("backgrounds").join("bg-1.png"), b"bg").expect("write background");
        fs::write(old_dir.join("metadata.json"), r#"{"notes":[]}"#).expect("write metadata");
        let old_background = old_dir.join("backgrounds").join("bg-1.png");
        fs::write(
            old_dir.join("config.json"),
            legacy_config_json(&custom_notes, &old_background.to_string_lossy()),
        )
        .expect("write legacy config");

        let store = NoteStore::new(root.join("appdata"), custom_dir.clone());
        store
            .migrate_config_from_candidates(std::slice::from_ref(&old_dir))
            .expect("migrate legacy config");

        assert!(custom_dir.join("metadata.json").exists());
        assert!(custom_dir
            .join("images")
            .join("id-1")
            .join("p.png")
            .exists());
        assert!(custom_dir.join("backgrounds").join("bg-1.png").exists());
        assert!(!old_dir.join("metadata.json").exists());
        assert!(!old_dir.join("images").exists());
        assert!(!old_dir.join("backgrounds").exists());

        let migrated: AppConfig =
            serde_json::from_str(&fs::read_to_string(store.config_path()).expect("read config"))
                .expect("parse migrated config");
        assert_eq!(
            migrated.data_dir.as_deref(),
            Some(custom_dir.to_string_lossy().as_ref())
        );
        assert_eq!(
            migrated.background_image_path,
            custom_dir
                .join("backgrounds")
                .join("bg-1.png")
                .to_string_lossy()
        );
    }

    #[test]
    fn rescues_loose_notes_from_pre_suffix_custom_dir() {
        let root = test_root("legacy-loose-notes");
        let old_dir = root.join("old-base");
        // v1.0.0–v1.0.3 自定义目录不带 notes 后缀，笔记直接位于目录顶层
        let custom_dir = root.join("custom");
        fs::create_dir_all(custom_dir.join("工作")).expect("create category dir");
        fs::write(custom_dir.join("id-1_第一篇.md"), "# 第一篇").expect("write loose note");
        fs::write(custom_dir.join("工作").join("id-2_第二篇.md"), "# 第二篇")
            .expect("write category note");
        fs::write(custom_dir.join("无关文件.md"), "未被跟踪").expect("write untracked file");

        fs::create_dir_all(&old_dir).expect("create old base");
        fs::write(
            old_dir.join("metadata.json"),
            r#"{"notes":[
  {"id":"id-1","title":"第一篇","fileName":"id-1_第一篇.md","category":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","wordCount":3,"preview":"第一篇"},
  {"id":"id-2","title":"第二篇","fileName":"id-2_第二篇.md","category":"工作","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","wordCount":3,"preview":"第二篇"}
]}"#,
        )
        .expect("write legacy metadata");
        fs::write(
            old_dir.join("config.json"),
            legacy_config_json(&custom_dir, ""),
        )
        .expect("write legacy config");

        let store = NoteStore::new(root.join("appdata"), custom_dir.clone());
        store
            .migrate_config_from_candidates(std::slice::from_ref(&old_dir))
            .expect("migrate legacy config");

        assert!(custom_dir.join("notes").join("id-1_第一篇.md").exists());
        assert!(custom_dir
            .join("notes")
            .join("工作")
            .join("id-2_第二篇.md")
            .exists());
        assert!(!custom_dir.join("id-1_第一篇.md").exists());
        // metadata 未跟踪的文件留在原处
        assert!(custom_dir.join("无关文件.md").exists());
        // metadata.json 一并迁入新数据目录，created_at 不丢失
        assert!(custom_dir.join("metadata.json").exists());

        let notes = store.list_notes().expect("list notes after migration");
        assert_eq!(notes.len(), 2);
        let first = notes
            .iter()
            .find(|note| note.id == "id-1")
            .expect("find first note");
        assert_eq!(first.created_at.to_rfc3339(), "2026-01-01T00:00:00+00:00");
    }

    #[test]
    fn rescues_loose_notes_by_scanning_when_metadata_missing() {
        let root = test_root("legacy-loose-notes-scan");
        let old_dir = root.join("old-base");
        let custom_dir = root.join("custom");
        fs::create_dir_all(custom_dir.join("分类")).expect("create category dir");
        fs::write(custom_dir.join("id-1_散落.md"), "# 散落").expect("write loose note");
        fs::write(custom_dir.join("分类").join("id-2_归类.md"), "# 归类")
            .expect("write category note");

        fs::create_dir_all(&old_dir).expect("create old base");
        fs::write(
            old_dir.join("config.json"),
            legacy_config_json(&custom_dir, ""),
        )
        .expect("write legacy config");

        let store = NoteStore::new(root.join("appdata"), custom_dir.clone());
        store
            .migrate_config_from_candidates(std::slice::from_ref(&old_dir))
            .expect("migrate legacy config");

        assert!(custom_dir.join("notes").join("id-1_散落.md").exists());
        assert!(custom_dir
            .join("notes")
            .join("分类")
            .join("id-2_归类.md")
            .exists());
    }

    // 模拟 FLORAL_NOTEPAPER_DATA_DIR 改向新空目录：旧位置数据应自动迁移过来
    #[test]
    fn relocates_data_when_target_dir_is_empty() {
        let root = test_root("relocate-empty");
        let config_dir = root.join("config");
        let old_data = root.join("old");
        let new_data = root.join("new");

        // 在旧位置创建一条笔记，并把 config 持久化为指向旧位置
        let old_store = NoteStore::new(config_dir.clone(), old_data.clone());
        let created = old_store
            .create_note(SaveNoteRequest {
                title: "重定位".into(),
                content: "# 重定位\n正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note in old dir");
        old_store.load_config().expect("persist old config");

        // 新 store 共享同一 config 目录，但 data_dir 指向新空目录
        let new_store = NoteStore::new(config_dir.clone(), new_data.clone());
        let notes = new_store.list_notes().expect("list after relocate");

        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, created.id);
        assert!(new_data.join("metadata.json").exists());
        assert!(!old_data.join("metadata.json").exists());

        let config: AppConfig = serde_json::from_str(
            &fs::read_to_string(new_store.config_path()).expect("read config"),
        )
        .expect("parse config");
        assert_eq!(
            config.data_dir.as_deref(),
            Some(new_data.to_string_lossy().as_ref())
        );
    }

    // 新位置已有用户数据时绝不合并，保留两边，防止交叉污染
    #[test]
    fn does_not_merge_relocated_data_into_non_empty_target() {
        let root = test_root("relocate-non-empty");
        let config_dir = root.join("config");
        let old_data = root.join("old");
        let new_data = root.join("new");

        let old_store = NoteStore::new(config_dir.clone(), old_data.clone());
        old_store
            .create_note(SaveNoteRequest {
                title: "旧数据".into(),
                content: "旧正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create old note");
        old_store.load_config().expect("persist old config");

        // 新位置已有独立笔记
        let seed_store = NoteStore::new(root.join("seed-config"), new_data.clone());
        let kept = seed_store
            .create_note(SaveNoteRequest {
                title: "新数据".into(),
                content: "新正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create new note");

        let new_store = NoteStore::new(config_dir.clone(), new_data.clone());
        let notes = new_store.list_notes().expect("list after relocate");

        // 只保留新位置原有数据，旧数据未被搬入合并
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, kept.id);
        // 旧数据原地保留，未丢失
        assert!(old_data.join("metadata.json").exists());
    }

    #[test]
    fn migrate_data_to_moves_items_and_updates_config() {
        let root = test_root("migrate-data-dir");
        let config_dir = root.join("config");
        let data_dir = root.join("data");
        let store = NoteStore::new(config_dir.clone(), data_dir.clone());
        fs::create_dir_all(&config_dir).expect("create config dir");
        write_json_atomic(&store.config_path(), &store.default_config())
            .expect("write default config");
        let note = store
            .create_note(SaveNoteRequest {
                title: "迁移测试".into(),
                content: "# 迁移测试\n正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");

        let target = root.join("target");
        let new_store = store.migrate_data_to(&target).expect("migrate data dir");

        assert_eq!(new_store.data_dir(), target.as_path());
        assert!(target.join("metadata.json").exists());
        assert!(target.join("notes").exists());
        assert!(!data_dir.join("metadata.json").exists());
        assert!(!data_dir.join("notes").exists());

        let notes = new_store.list_notes().expect("list notes after migration");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, note.id);

        let config: AppConfig =
            serde_json::from_str(&fs::read_to_string(store.config_path()).expect("read config"))
                .expect("parse config");
        assert_eq!(
            config.data_dir.as_deref(),
            Some(target.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn migrate_data_to_rejects_target_inside_current_data_dir() {
        let root = test_root("migrate-nested-reject");
        let config_dir = root.join("config");
        let data_dir = root.join("data");
        let store = NoteStore::new(config_dir.clone(), data_dir.clone());
        fs::create_dir_all(&config_dir).expect("create config dir");
        write_json_atomic(&store.config_path(), &store.default_config())
            .expect("write default config");
        store
            .create_note(SaveNoteRequest {
                title: "防护测试".into(),
                content: "正文".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");

        let error = store
            .migrate_data_to(&data_dir.join("notes").join("floral"))
            .expect_err("target inside data dir must be rejected");
        assert_eq!(error.code, "unsafePath");

        // 数据未被破坏，配置仍指向原目录
        assert!(data_dir.join("notes").exists());
        assert!(data_dir.join("metadata.json").exists());
        let config: AppConfig =
            serde_json::from_str(&fs::read_to_string(store.config_path()).expect("read config"))
                .expect("parse config");
        assert_eq!(
            config.data_dir.as_deref(),
            Some(data_dir.to_string_lossy().as_ref())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn migrates_legacy_macos_shortcut_default_once() {
        let store = test_store("legacy-macos-shortcut");
        let notes_dir = store.data_dir().join("notes");
        fs::create_dir_all(store.data_dir()).expect("create base dir");
        fs::create_dir_all(&notes_dir).expect("create notes dir");
        fs::write(
            store.config_path(),
            format!(
                r#"{{
  "notesDir": "{}",
  "globalShortcut": "Option+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split"
}}"#,
                notes_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write legacy config");

        let migrated = store.load_config().expect("load legacy config");

        assert_eq!(migrated.global_shortcut, "Command+Option+N");
        assert!(store.macos_shortcut_migration_path().exists());

        let mut manual = migrated;
        manual.global_shortcut = "Option+Space".into();
        store
            .save_config(manual.clone())
            .expect("save manual config");

        let loaded = store.load_config().expect("reload manual config");
        assert_eq!(loaded.global_shortcut, "Option+Space");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn migrates_previous_macos_shortcut_default() {
        let store = test_store("previous-macos-shortcut");
        let notes_dir = store.data_dir().join("notes");
        fs::create_dir_all(store.data_dir()).expect("create base dir");
        fs::create_dir_all(&notes_dir).expect("create notes dir");
        fs::write(
            store.config_path(),
            format!(
                r#"{{
  "notesDir": "{}",
  "globalShortcut": "Ctrl+Option+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split"
}}"#,
                notes_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write previous config");

        let migrated = store.load_config().expect("load previous config");

        assert_eq!(migrated.global_shortcut, "Command+Option+N");
        assert!(store.macos_shortcut_migration_path().exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn leaves_custom_macos_shortcut_unchanged() {
        let store = test_store("custom-macos-shortcut");
        let notes_dir = store.data_dir().join("notes");
        fs::create_dir_all(store.data_dir()).expect("create base dir");
        fs::create_dir_all(&notes_dir).expect("create notes dir");
        fs::write(
            store.config_path(),
            format!(
                r#"{{
  "notesDir": "{}",
  "globalShortcut": "Command+K",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split"
}}"#,
                notes_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write custom config");

        let loaded = store.load_config().expect("load custom config");

        assert_eq!(loaded.global_shortcut, "Command+K");
        assert!(store.macos_shortcut_migration_path().exists());
    }

    #[test]
    fn imports_markdown_heading_title_without_stripping_content() {
        let root = test_root("import-heading-title");
        let source_path = root.join("外部文件.md");
        let source_content = "# 导入标题\n正文第一行\n正文第二行";
        fs::write(&source_path, source_content).expect("write source markdown");
        let store_path = root.join("store");
        let store = NoteStore::new(store_path.clone(), store_path);

        let imported = store
            .import_markdown_file(&source_path, "")
            .expect("import markdown");

        assert_eq!(imported.title, "导入标题");
        assert_eq!(imported.content, source_content);
        assert_eq!(
            store
                .read_note(&imported.id)
                .expect("read imported")
                .content,
            source_content
        );
    }

    #[test]
    fn imports_markdown_title_from_file_name_without_heading() {
        let root = test_root("import-file-title");
        let source_path = root.join("会议记录.md");
        let source_content = "正文第一行\n# 不是第一行标题";
        fs::write(&source_path, source_content).expect("write source markdown");
        let store_path = root.join("store");
        let store = NoteStore::new(store_path.clone(), store_path);

        let imported = store
            .import_markdown_file(&source_path, "")
            .expect("import markdown");

        assert_eq!(imported.title, "会议记录");
        assert_eq!(imported.content, source_content);
    }

    #[test]
    fn exports_markdown_file_without_rewriting_content() {
        let root = test_root("export-markdown");
        let store_path = root.join("store");
        let store = NoteStore::new(store_path.clone(), store_path);
        let content = "# 原始标题\n正文\n- 列表";
        let note = store
            .create_note(SaveNoteRequest {
                title: "导出标题".into(),
                content: content.into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");
        let export_path = root.join("exports").join("导出.md");

        store
            .export_markdown_file(&note.id, &export_path)
            .expect("export markdown");

        assert_eq!(
            fs::read_to_string(export_path).expect("read exported markdown"),
            content
        );
    }

    #[test]
    fn reconciles_an_orphan_markdown_file_without_losing_existing_metadata() {
        let store = test_store("orphan-markdown-recovery");
        let existing = store
            .create_note(SaveNoteRequest {
                title: "已有笔记".into(),
                content: "已有内容".into(),
                category: String::new(),
                tags: vec!["kept".into()],
                pinned: true,
            })
            .expect("create existing note");
        let orphan_id = Uuid::new_v4().to_string();
        let orphan_file = format!("{orphan_id}_崩溃后留下的笔记.md");
        fs::write(
            store.notes_dir().join(&orphan_file),
            "# 崩溃恢复\n这篇文件写入后 metadata 尚未来得及提交。",
        )
        .expect("write orphan markdown");

        invalidate_data_dir_reconciliation(store.data_dir());
        let notes = store.list_notes().expect("reconcile orphan note");
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().any(|note| note.id == orphan_id));
        let kept = notes
            .iter()
            .find(|note| note.id == existing.id)
            .expect("existing note");
        assert_eq!(kept.tags, ["kept"]);
        assert!(kept.pinned);
    }

    #[test]
    fn rebuilds_fts_for_existing_json_notes_when_derived_state_is_missing() {
        let store = test_store("fts-initial-migration");
        let first = store
            .create_note(SaveNoteRequest {
                title: "旧笔记一".into(),
                content: "水稻田里的第一条旧记录".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create first note");
        let second = store
            .create_note(SaveNoteRequest {
                title: "旧笔记二".into(),
                content: "水稻田里的第二条旧记录".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create second note");

        crate::services::db::reset_derived_data(store.data_dir()).expect("clear derived state");
        let results = store
            .search_content("水稻田")
            .expect("search after migration");
        let ids = results
            .iter()
            .map(|item| item.note_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 2);
        assert!(ids.contains(&first.id.as_str()));
        assert!(ids.contains(&second.id.as_str()));
    }

    #[test]
    fn rebuilds_fts_when_markdown_changes_outside_the_app() {
        let store = test_store("fts-external-edit");
        let note = store
            .create_note(SaveNoteRequest {
                title: "外部编辑".into(),
                content: "外部旧内容".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");

        fs::write(
            store
                .note_path_in_category(&note.file_name, &note.category)
                .expect("note path"),
            "外部新内容",
        )
        .expect("edit markdown externally");

        let new_results = store
            .search_content("外部新内容")
            .expect("search new content");
        assert_eq!(new_results.len(), 1);
        assert_eq!(new_results[0].note_id, note.id);
        assert!(store
            .search_content("外部旧内容")
            .expect("search old content")
            .is_empty());
    }

    #[test]
    fn restore_backup_rebuilds_metadata_and_fts_from_restored_files() {
        let store = test_store("restore-rebuilds-derived-indexes");
        let restored = store
            .create_note(SaveNoteRequest {
                title: "备份中的笔记".into(),
                content: "恢复后应该能搜索到水稻田".into(),
                category: String::new(),
                tags: vec!["backup".into()],
                pinned: false,
            })
            .expect("create backup note");
        let backup = store.data_dir().join("restore-source.zip");
        store.create_backup(&backup).expect("create backup");

        store.delete_note(&restored.id).expect("delete backup note");
        let current = store
            .create_note(SaveNoteRequest {
                title: "恢复前的当前笔记".into(),
                content: "这篇不应留在恢复结果中".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create current note");

        store.restore_backup(&backup).expect("restore backup");
        let notes = store.list_notes().expect("list restored notes");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, restored.id);
        assert_ne!(notes[0].id, current.id);

        let results = store
            .search_content("水稻田")
            .expect("search restored notes");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].note_id, restored.id);
    }

    #[test]
    fn explicit_data_migration_rebuilds_fts_without_copying_live_sqlite() {
        let root = test_root("migrate-rebuilds-derived-indexes");
        let data_dir = root.join("source");
        let target_dir = root.join("target");
        let store = NoteStore::new(root.join("config"), data_dir.clone());
        fs::create_dir_all(store.config_dir()).expect("create config dir");
        write_json_atomic(&store.config_path(), &store.default_config()).expect("write config");
        let note = store
            .create_note(SaveNoteRequest {
                title: "迁移索引".into(),
                content: "迁移后也能搜索水稻田".into(),
                category: String::new(),
                tags: Vec::new(),
                pinned: false,
            })
            .expect("create note");

        let migrated = store.migrate_data_to(&target_dir).expect("migrate data");
        assert!(
            !data_dir.join("floral.db").exists(),
            "old derived database should be cleaned"
        );
        assert!(
            target_dir.join("floral.db").exists(),
            "new database should be rebuilt"
        );
        let results = migrated
            .search_content("水稻田")
            .expect("search migrated data");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].note_id, note.id);
    }
}
