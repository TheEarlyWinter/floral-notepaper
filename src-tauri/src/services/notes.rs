use crate::json_io::write_json_atomic;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fmt, fs, io,
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};
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

// default_store() 会为每个命令创建一个新的 NoteStore；这把进程内锁覆盖完整
// 读-改-写区间，避免多个窗口用旧 metadata.json 覆盖彼此的更新。
static METADATA_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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

#[derive(Debug, Clone)]
pub struct NoteStore {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

pub fn default_store() -> Result<NoteStore, AppError> {
    let config_dir = default_config_dir()?;
    let data_dir = resolve_data_dir(&config_dir)?;
    // 确保 SQLite 数据库已初始化（幂等）。失败不阻塞启动，回退到 JSON 索引
    if let Err(e) = crate::services::db::init_db(&data_dir) {
        eprintln!("[花笺] 数据库初始化失败，FTS5 搜索不可用: {e}");
    }
    Ok(NoteStore::new(config_dir, data_dir))
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

const DATA_DIR_ITEMS: [&str; 9] = [
    "metadata.json", "notes", "images", "attachments", "attachments.json", "backgrounds", "history", "reminders.json", "search-index.json",
];

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
    // 拒绝把目录复制进自身子目录：否则递归无限展开、磁盘耗尽。
    // migrate_data_to 上层已用 canonical_for_compare 拦截，这里做底层兜底，
    // 与 updater::helper 的同名实现保持一致的自递归防护
    if to.starts_with(from) && to != from {
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
        self.ensure_config_dir()?;
        let path = self.config_path();
        if !path.exists() {
            self.migrate_config_from_legacy()?;
        }
        if !path.exists() {
            let config = self.default_config();
            self.save_config(config.clone())?;
            self.mark_macos_shortcut_migration_handled()?;
            return Ok(config);
        }

        let mut config: AppConfig = serde_json::from_str(&fs::read_to_string(&path)?)?;
        // config 中记录的 dataDir 是上次运行时数据所在位置；若本次 resolve 出的
        // self.data_dir 与之不同（如 FLORAL_NOTEPAPER_DATA_DIR 被改），尝试搬运旧数据
        self.migrate_data_dir_if_relocated(&mut config);
        config.data_dir = Some(self.data_dir.to_string_lossy().to_string());
        config.tab_indent_size = config.tab_indent_size.clamp(1, 8);
        write_json_atomic(&path, &config)?;
        fs::create_dir_all(self.data_dir.join("notes"))?;
        if self.migrate_macos_shortcut_default(&mut config)? {
            write_json_atomic(&path, &config)?;
        }
        Ok(config)
    }

    pub fn save_config(&self, mut config: AppConfig) -> Result<AppConfig, AppError> {
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
                .exists()
        });
        metadata.sort_by_key(|note| std::cmp::Reverse(note.updated_at));
        Ok(metadata)
    }

    pub fn read_note(&self, id: &str) -> Result<Note, AppError> {
        self.ensure_storage()?;
        let metadata = self.find_metadata(id)?;
        let content = fs::read_to_string(
            self.note_path_in_category(&metadata.file_name, &metadata.category),
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
        let note_path = self.note_path_in_category(&file_name, &category);
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
        let _ = self.rebuild_search_index();
        // 增量更新 FTS5
        if crate::services::db::is_initialized() {
            let _ = crate::services::db::db_fts_upsert(&created.id, &created.title, &created.content);
        }
        Ok(created)
    }

    pub fn update_note(&self, id: &str, request: SaveNoteRequest) -> Result<Note, AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.update_note_unlocked(id, request)
    }

    fn update_note_unlocked(&self, id: &str, request: SaveNoteRequest) -> Result<Note, AppError> {
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

        let new_path = self.note_path_in_category(&new_file_name, &new_category);
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let old_path = self.note_path_in_category(&old_file_name, &old_category);
        if old_path.exists() {
            let old_content = fs::read_to_string(&old_path)?;
            if old_content != request.content {
                self.save_note_version(id, &old_content)?;
            }
        }
        fs::write(&new_path, &request.content)?;

        if old_file_name != new_file_name || old_category != new_category {
            if old_path.exists() && old_path != new_path {
                trash::delete(&old_path)
                    .map_err(|e| AppError::new("trash", format!("移入回收站失败: {e}")))?;
            }
        }

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
            category: new_category,
            created_at: note.created_at,
            updated_at: note.updated_at,
            word_count: note.word_count,
            content: request.content,
            tags: note.tags.clone(),
            pinned: note.pinned,
        };

        self.save_metadata(&metadata_file)?;
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        let _ = self.rebuild_search_index();
        if crate::services::db::is_initialized() {
            let _ = crate::services::db::db_fts_upsert(&result.id, &result.title, &result.content);
        }
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
            let source_images = self.images_dir(&source.id);
            let target_images = self.images_dir(&target.id);
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
        let source_heading = if source_title.is_empty() { "未命名笔记" } else { source_title };
        let source_content = source.content.replace(&source_image_prefix, &target_image_prefix);
        let separator = if target.content.trim().is_empty() { "" } else { "\n\n---\n\n" };
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
        let source_path = self.note_path_in_category(&source_metadata.file_name, &source_metadata.category);
        if source_path.exists() {
            trash::delete(&source_path)
                .map_err(|e| AppError::new("trash", format!("移入回收站失败: {e}")))?;
        }
        self.save_metadata(&metadata_file)?;
        let _ = self.delete_note_images(&source.id);
        let _ = crate::services::library::move_note_attachments(&self.data_dir, &source.id, &target.id);
        let source_history = self.note_history_dir(&source.id);
        if source_history.exists() {
            let _ = fs::remove_dir_all(source_history);
        }
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        let _ = self.rebuild_search_index();
        // FTS5: 删除源笔记索引，更新目标笔记索引
        if crate::services::db::is_initialized() {
            let _ = crate::services::db::db_fts_delete(&source.id);
            let _ = crate::services::db::db_fts_upsert(&merged.id, &merged.title, &merged.content);
        }

        Ok(merged)
    }

    pub fn delete_note(&self, id: &str) -> Result<(), AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        let mut metadata_file = self.load_metadata()?;
        let index = metadata_file
            .notes
            .iter()
            .position(|note| note.id == id)
            .ok_or_else(|| AppError::note_not_found(id))?;
        let metadata = metadata_file.notes.remove(index);
        let path = self.note_path_in_category(&metadata.file_name, &metadata.category);
        if path.exists() {
            trash::delete(&path)
                .map_err(|e| AppError::new("trash", format!("移入回收站失败: {e}")))?;
        }
        self.save_metadata(&metadata_file)?;
        let _ = self.delete_note_images(id);
        let _ = crate::services::library::delete_note_attachments(&self.data_dir, id);
        let history_dir = self.note_history_dir(id);
        if history_dir.exists() {
            let _ = fs::remove_dir_all(history_dir);
        }
        let _ = crate::services::library::ensure_daily_backup(&self.data_dir);
        let _ = self.rebuild_search_index();
        if crate::services::db::is_initialized() {
            let _ = crate::services::db::db_fts_delete(id);
        }
        Ok(())
    }

    pub fn images_dir(&self, note_id: &str) -> PathBuf {
        self.data_dir.join("images").join(note_id)
    }

    fn note_history_dir(&self, note_id: &str) -> PathBuf {
        self.data_dir.join("history").join(note_id)
    }

    fn note_version_path(&self, note_id: &str, version_id: &str) -> Result<PathBuf, AppError> {
        if chrono::NaiveDateTime::parse_from_str(version_id, "%Y%m%dT%H%M%S%.fZ").is_err() {
            return Err(AppError::new("noteVersionNotFound", "找不到该历史版本"));
        }
        Ok(self.note_history_dir(note_id).join(format!("{version_id}.md")))
    }

    fn save_note_version(&self, note_id: &str, content: &str) -> Result<(), AppError> {
        // 路径穿越防护：note_id 必须是合法 UUID v4 格式
        if note_id.len() != 36 || note_id.chars().filter(|&c| c == '-').count() != 4 {
            return Err(AppError {
                code: "invalidNoteId".into(),
                message: "note_id 格式无效".into(),
                details: Default::default(),
            });
        }

        let dir = self.note_history_dir(note_id);
        fs::create_dir_all(&dir)?;

        // 计算内容 blake3 hash
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();

        // 检查是否与最新版本内容重复
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

        if let Some(last) = entries.last() {
            let existing = fs::read_to_string(last.path()).unwrap_or_default();
            if blake3::hash(existing.as_bytes()).to_hex().to_string() == hash {
                return Ok(()); // 内容未变，跳过
            }
        }

        // 存储新版本（纯时间戳格式，与 list_note_versions / restore_note_version 兼容）
        let version_id = Utc::now().format("%Y%m%dT%H%M%S%.6fZ").to_string();
        fs::write(dir.join(format!("{version_id}.md")), content)?;

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
        let ext = extension.to_ascii_lowercase();
        if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            return Err(AppError::new(
                "unsupportedImageFormat",
                format!("不支持的图片格式: {ext}"),
            ));
        }

        let dir = self.images_dir(note_id);
        fs::create_dir_all(&dir)?;

        let file_name = format!("{}.{}", Uuid::new_v4(), ext);
        fs::write(dir.join(&file_name), data)?;

        Ok(format!("images/{note_id}/{file_name}"))
    }

    pub fn open_daily_note(&self) -> Result<Note, AppError> {
        let _lock = self.lock_metadata_mutation()?;
        self.ensure_storage()?;
        let date = Utc::now().format("%Y-%m-%d").to_string();
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
        let dir = self.note_history_dir(id);
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
                stem,
                "%Y%m%dT%H%M%S%.fZ",
            ) else {
                continue;
            };
            let content = fs::read_to_string(&path)?;
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
        let dir = self.images_dir(note_id);
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
        let dir = self.images_dir(note_id);
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
        self.list_notes()?.into_iter().map(|metadata| self.read_note(&metadata.id)).collect()
    }

    pub fn rebuild_search_index(&self) -> Result<(), AppError> {
        let notes = self.all_notes_for_index()?;
        crate::services::library::rebuild_search_index(&self.data_dir, &notes)
    }

    pub fn search_content(&self, query: &str) -> Result<Vec<crate::services::library::SearchResult>, AppError> {
        // 优先使用 SQLite FTS5 索引
        if crate::services::db::is_initialized() {
            match self.search_fts(query) {
                Ok(results) if !results.is_empty() => return Ok(results),
                _ => {} // FTS 失败或为空则回退到 JSON 索引
            }
        }
        let notes = self.all_notes_for_index()?;
        crate::services::library::search(&self.data_dir, query, &notes)
    }

    /// 使用 FTS5 全文搜索（trigram tokenizer）
    fn search_fts(&self, query: &str) -> Result<Vec<crate::services::library::SearchResult>, AppError> {
        use crate::services::library::SearchResult;

        // UTF-8 安全字符边界辅助函数
        fn floor_char_boundary(s: &str, index: usize) -> usize {
            if index >= s.len() { return s.len(); }
            let mut i = index;
            while i > 0 && !s.is_char_boundary(i) { i -= 1; }
            i
        }
        fn ceil_char_boundary(s: &str, index: usize) -> usize {
            if index >= s.len() { return s.len(); }
            let mut i = index;
            while i < s.len() && !s.is_char_boundary(i) { i += 1; }
            i
        }

        let ids = crate::services::db::db_search_fts(query)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let normalized = query.trim().to_lowercase();
        let mut results = Vec::new();

        for id in &ids {
            if let Ok(note) = self.read_note(id) {
                let title = if note.title.trim().is_empty() { "无标题笔记".into() } else { note.title.clone() };
                let content_lower = note.content.to_lowercase();
                let title_lower = note.title.to_lowercase();
                let pos = content_lower.find(&normalized);

                let (source, match_pos, score) = if let Some(p) = pos {
                    // 安全：p 来自 content_lower，极少数 Unicode 大小写转换可能改变字节长度，
                    // 这里 min 确保不会越界 note.content
                    let safe_p = p.min(note.content.len().saturating_sub(1));
                    (&note.content, safe_p, 10 + title_lower.find(&normalized).map(|_| 8).unwrap_or(0))
                } else if let Some(p) = title_lower.find(&normalized) {
                    (&note.title, p, 18)
                } else {
                    // FTS 匹配但精确子串不匹配（trigram 模糊匹配），用内容开头
                    (&note.content, 0usize, 5)
                };

                let start = match_pos.saturating_sub(44);
                let end = (match_pos + normalized.len() + 90).min(source.len());
                // 确保 UTF-8 字符边界安全：找到 start 处最近的字符边界
                let safe_start = floor_char_boundary(source, start);
                let safe_end = ceil_char_boundary(source, end);
                let snippet = format!(
                    "{}{}{}",
                    if safe_start > 0 { "\u{2026}" } else { "" },
                    source[safe_start..safe_end].replace('\n', " "),
                    if safe_end < source.len() { "\u{2026}" } else { "" }
                );

                results.push(SearchResult {
                    note_id: note.id,
                    title,
                    category: note.category,
                    snippet,
                    match_start: match_pos,
                    score,
                });
            }
        }

        results.sort_by(|a, b| b.score.cmp(&a.score));
        results.truncate(80);
        Ok(results)
    }

    pub fn add_attachment(&self, note_id: &str, source: &Path) -> Result<crate::services::library::Attachment, AppError> {
        self.read_note(note_id)?;
        crate::services::library::add_attachment(&self.data_dir, note_id, source)
    }

    pub fn list_attachments(&self, note_id: &str) -> Result<Vec<crate::services::library::Attachment>, AppError> {
        self.read_note(note_id)?;
        crate::services::library::list_attachments(&self.data_dir, note_id)
    }

    pub fn delete_attachment(&self, note_id: &str, attachment_id: &str) -> Result<(), AppError> {
        crate::services::library::delete_attachment(&self.data_dir, note_id, attachment_id)
    }

    pub fn attachment_path(&self, note_id: &str, attachment_id: &str) -> Result<PathBuf, AppError> {
        let attachment = self.list_attachments(note_id)?.into_iter().find(|item| item.id == attachment_id).ok_or_else(|| AppError::new("attachmentNotFound", "找不到附件"))?;
        Ok(self.data_dir.join("attachments").join(note_id).join(attachment.file_name))
    }

    pub fn create_backup(&self, destination: &Path) -> Result<(), AppError> {
        self.ensure_storage()?;
        crate::services::library::create_manual_backup(&self.data_dir, destination)
    }

    pub fn ensure_daily_backup(&self) -> Result<Option<crate::services::library::BackupInfo>, AppError> {
        self.ensure_storage()?;
        crate::services::library::ensure_daily_backup(&self.data_dir)
    }

    pub fn list_backups(&self) -> Result<Vec<crate::services::library::BackupInfo>, AppError> {
        crate::services::library::list_backups(&self.data_dir)
    }

    pub fn restore_backup(&self, backup: &Path) -> Result<(), AppError> {
        let _lock = self.lock_metadata_mutation()?;
        crate::services::library::restore_backup(&self.data_dir, backup)?;
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
        if name.contains('/') || name.contains('\\') || name.contains(':') || name.contains("..") {
            return Err(AppError::category_name_invalid_chars());
        }
        let notes_dir = self.notes_dir();
        let path = notes_dir.join(name);
        fs::create_dir_all(&path)?;
        Ok(())
    }

    pub fn rename_category(&self, old_name: &str, new_name: &str) -> Result<(), AppError> {
        let _lock = self.lock_metadata_mutation()?;
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(AppError::category_name_empty());
        }
        if new_name.contains('/')
            || new_name.contains('\\')
            || new_name.contains(':')
            || new_name.contains("..")
        {
            return Err(AppError::category_name_invalid_chars());
        }
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
        self.save_metadata(&metadata_file)?;
        Ok(())
    }

    pub fn delete_category(&self, name: &str) -> Result<(), AppError> {
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
            }
        }
        Ok(())
    }

    pub fn move_note_to_category(
        &self,
        id: &str,
        new_category: &str,
    ) -> Result<NoteMetadata, AppError> {
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

        let old_path = self.note_path_in_category(&note.file_name, &old_category);
        let new_path = self.note_path_in_category(&note.file_name, new_category);
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if old_path.exists() {
            fs::rename(&old_path, &new_path)?;
        }

        note.category = new_category.to_string();
        let result = note.clone();
        self.save_metadata(&metadata_file)?;
        Ok(result)
    }

    fn lock_metadata_mutation(&self) -> Result<MutexGuard<'static, ()>, AppError> {
        METADATA_MUTATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| AppError::new("metadataLock", "笔记存储锁已中毒，请重启应用后重试"))
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
        if !self.metadata_path().exists() {
            let metadata = self.rebuild_metadata()?;
            self.save_metadata(&metadata)?;
        } else {
            let metadata = self.load_metadata()?;
            if metadata.notes.is_empty() && self.notes_dir_has_md_files() {
                let rebuilt = self.rebuild_metadata()?;
                self.save_metadata(&rebuilt)?;
            }
        }
        Ok(())
    }

    fn notes_dir(&self) -> PathBuf {
        self.data_dir.join("notes")
    }

    fn note_path_in_category(&self, file_name: &str, category: &str) -> PathBuf {
        let notes_dir = self.notes_dir();
        if category.is_empty() {
            notes_dir.join(file_name)
        } else {
            notes_dir.join(category).join(file_name)
        }
    }

    fn find_metadata(&self, id: &str) -> Result<NoteMetadata, AppError> {
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

    fn load_metadata(&self) -> Result<MetadataFile, AppError> {
        self.ensure_data_dir()?;

        // 优先从 SQLite 读取。首次启动时若 SQLite 为空且 metadata.json 存在，自动迁移
        if crate::services::db::is_initialized() {
            // unwrap_or(true): 查询失败时假设为空 → 走迁移路径，upsert 幂等安全
            if crate::services::db::db_notes_is_empty().unwrap_or(true) {
                return self.migrate_json_to_sqlite_or_rebuild();
            }

            // SQLite 中有数据，直接读取
            match crate::services::db::db_notes_get_all() {
                Ok(notes) => return Ok(MetadataFile { notes }),
                Err(e) => {
                    // SQLite 损坏 → 回退到 JSON，再不行就文件系统重建
                    eprintln!("[花笺] SQLite 读取失败 ({e})，尝试从 JSON 恢复");
                    return self.fallback_load_from_json_or_rebuild();
                }
            }
        }

        // 数据库未初始化 → JSON 回退
        self.fallback_load_from_json_or_rebuild()
    }

    /// 从 metadata.json 迁移到 SQLite（首次启动），或从文件系统重建
    fn migrate_json_to_sqlite_or_rebuild(&self) -> Result<MetadataFile, AppError> {
        let json_path = self.metadata_path();
        if json_path.exists() {
            match serde_json::from_str::<MetadataFile>(&fs::read_to_string(&json_path)?) {
                Ok(metadata) => {
                    // 事务包裹的批量迁移
                    if let Err(e) = crate::services::db::db_notes_replace_all(&metadata.notes) {
                        eprintln!("[花笺] SQLite 迁移失败 ({e})，继续使用 JSON");
                    } else {
                        eprintln!("[花笺] 已从 metadata.json 迁移 {} 条笔记到 SQLite", metadata.notes.len());
                    }
                    return Ok(metadata);
                }
                Err(_) => {
                    let corrupt_name = format!(
                        "metadata.corrupt-{}.json",
                        Utc::now().format("%Y%m%d%H%M%S")
                    );
                    let _ = fs::rename(&json_path, self.data_dir.join(&corrupt_name));
                }
            }
        }
        let rebuilt = self.rebuild_metadata()?;
        if let Err(e) = crate::services::db::db_notes_replace_all(&rebuilt.notes) {
            eprintln!("[花笺] SQLite 新建写入失败: {e}");
        }
        Ok(rebuilt)
    }

    /// JSON / 文件系统回退加载（SQLite 不可用时）
    fn fallback_load_from_json_or_rebuild(&self) -> Result<MetadataFile, AppError> {
        let path = self.metadata_path();
        if !path.exists() {
            let rebuilt = self.rebuild_metadata()?;
            self.save_metadata(&rebuilt)?;
            return Ok(rebuilt);
        }
        match serde_json::from_str(&fs::read_to_string(&path)?) {
            Ok(metadata) => Ok(metadata),
            Err(_) => {
                let corrupt_name = format!(
                    "metadata.corrupt-{}.json",
                    Utc::now().format("%Y%m%d%H%M%S")
                );
                if let Err(error) = fs::rename(&path, self.data_dir.join(&corrupt_name)) {
                    eprintln!("failed to back up corrupt metadata {}: {error}", path.display());
                }
                let rebuilt = self.rebuild_metadata()?;
                self.save_metadata(&rebuilt)?;
                Ok(rebuilt)
            }
        }
    }

    fn save_metadata(&self, metadata: &MetadataFile) -> Result<(), AppError> {
        self.ensure_data_dir()?;

        // 1. 先写 JSON（原子写入，始终保留最近完整快照，作为降级安全网）
        write_json_atomic(&self.metadata_path(), metadata)?;

        // 2. 再写 SQLite（主存储）。事务包裹保证原子性，失败时 JSON 仍是最新完整快照
        if crate::services::db::is_initialized() {
            crate::services::db::db_notes_replace_all(&metadata.notes)?;
        }

        Ok(())
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

        self.scan_dir_for_notes(&notes_dir, "", &mut notes)?;

        for entry in fs::read_dir(&notes_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let category = entry.file_name().to_string_lossy().to_string();
                self.scan_dir_for_notes(&path, &category, &mut notes)?;
            }
        }

        Ok(MetadataFile { notes })
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

        // 第二阶段：切换配置指向新目录（提交点）
        let new_store = NoteStore::new(self.config_dir.clone(), new_data_dir.to_path_buf());
        let mut config = new_store.load_config()?;
        config.background_image_path =
            remap_path_prefix(&config.background_image_path, &self.data_dir, new_data_dir);
        config.data_dir = Some(new_data_dir.to_string_lossy().to_string());
        new_store.save_config(config)?;

        // 第三阶段：清理旧位置。失败只会留下冗余副本，不影响新目录的数据，
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

        Ok(new_store)
    }

    // 跨重启自动迁移：config 持久化的 dataDir 与本次 resolve 的 self.data_dir 不一致时
    // （典型为修改 FLORAL_NOTEPAPER_DATA_DIR 环境变量），把旧位置数据搬到新位置。
    // 关键不变量：仅当新位置尚无用户数据时才迁移，否则保留两边、不合并，避免交叉污染。
    // 失败不阻断启动——记录日志后继续，旧数据仍在原地不会丢失
    fn migrate_data_dir_if_relocated(&self, config: &mut AppConfig) {
        let Some(ref last_dir) = config.data_dir else {
            return;
        };
        let old_dir = PathBuf::from(last_dir);
        if canonical_for_compare(&old_dir) == canonical_for_compare(&self.data_dir) {
            return;
        }
        if !old_dir.exists() {
            return;
        }
        match self.data_dir_has_user_data() {
            Ok(true) | Err(_) => return,
            Ok(false) => {}
        }
        eprintln!(
            "data dir relocated, migrating from {} to {}",
            old_dir.display(),
            self.data_dir.display()
        );
        for item in DATA_DIR_ITEMS {
            let src = old_dir.join(item);
            let dst = self.data_dir.join(item);
            if !src.exists() || dst.exists() {
                continue;
            }
            if let Err(error) = move_path(&src, &dst) {
                eprintln!(
                    "failed to migrate {item} from {} to {}: {}",
                    old_dir.display(),
                    self.data_dir.display(),
                    error.message
                );
            }
        }
        config.background_image_path =
            remap_path_prefix(&config.background_image_path, &old_dir, &self.data_dir);
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

fn id_from_file_name(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".md")?;
    Some(
        stem.split_once('_')
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
        assert_eq!(store.list_note_versions(&target.id).expect("history").len(), 1);
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

        let versions = store.list_note_versions(&created.id).expect("list versions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].preview, "第一版");

        let restored = store
            .restore_note_version(&created.id, &versions[0].id)
            .expect("restore version");
        assert_eq!(restored.content, "第一版");
        // 恢复前的第二版也会被保留为可再次恢复的快照。
        assert_eq!(store.list_note_versions(&created.id).expect("list restored history").len(), 2);
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

        assert_eq!(store.list_note_versions(&created.id).expect("list versions").len(), 20);
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
}
