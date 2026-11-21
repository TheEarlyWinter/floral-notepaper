use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt, fs, io,
    path::{Component, Path},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "super::config::default_locale")]
    pub locale: String,
    // 读入时可缺省（旧 config 无此字段），但返回前端前必在 load_config / save_config
    // 中被设为 Some。不加 skip_serializing_if：保证 dataDir 字段始终序列化输出，
    // 与前端 `dataDir: string` 契约一致，避免 None 时省略字段导致前端收到 undefined
    #[serde(default)]
    pub data_dir: Option<String>,
    pub global_shortcut: String,
    pub close_to_tray: bool,
    #[serde(default = "super::config::default_close_tab_shortcut")]
    pub close_tab_shortcut: String,
    #[serde(default = "super::config::default_command_palette_shortcut")]
    pub command_palette_shortcut: String,
    pub autostart: bool,
    pub default_view_mode: String,
    #[serde(default = "super::config::default_note_auto_save")]
    pub note_auto_save: bool,
    #[serde(default = "super::config::default_note_surface_auto_save")]
    pub note_surface_auto_save: bool,
    #[serde(default = "super::config::default_tile_color")]
    pub tile_color: String,
    #[serde(default = "super::config::default_tile_color_mode")]
    pub tile_color_mode: String,
    #[serde(default = "super::config::default_theme")]
    pub theme: String,
    #[serde(default = "super::config::default_font_size")]
    pub font_size: u32,
    #[serde(default = "super::config::default_surface_font_size")]
    pub surface_font_size: u32,
    #[serde(default = "super::config::default_tab_indent_size")]
    pub tab_indent_size: u32,
    #[serde(default = "super::config::default_external_file_auto_save")]
    pub external_file_auto_save: bool,
    #[serde(default)]
    pub background_image_path: String,
    #[serde(default = "super::config::default_background_fit")]
    pub background_fit: String,
    #[serde(default = "super::config::default_background_dim")]
    pub background_dim: f64,
    #[serde(default = "super::config::default_background_blur")]
    pub background_blur: f64,
    #[serde(default = "super::config::default_background_scale")]
    pub background_scale: f64,
    #[serde(default = "super::config::default_background_position")]
    pub background_position_x: f64,
    #[serde(default = "super::config::default_background_position")]
    pub background_position_y: f64,
    #[serde(default = "super::config::default_remember_surface_size")]
    pub remember_surface_size: bool,
    #[serde(default = "super::config::default_tile_ctrl_close")]
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
    #[serde(default = "super::config::default_split_scroll_sync")]
    pub split_scroll_sync: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_height: Option<u32>,
    #[serde(default = "super::config::default_toggle_visibility_shortcut")]
    pub toggle_visibility_shortcut: String,
    #[serde(default = "super::config::default_quick_capture_shortcut")]
    pub quick_capture_shortcut: String,
    #[serde(default = "super::config::default_open_at_cursor")]
    pub open_at_cursor: bool,
    #[serde(default = "super::config::default_preset_theme")]
    pub preset_theme: String,
    #[serde(default)]
    pub accent_color: String,
    #[serde(default = "super::config::default_code_theme")]
    pub code_theme: String,
    #[serde(default)]
    pub editor_font_family: String,
    #[serde(default = "super::config::default_editor_line_height")]
    pub editor_line_height: f64,
    #[serde(default)]
    pub editor_paragraph_spacing: u32,
    #[serde(default = "super::config::default_editor_width")]
    pub editor_width: String,
    #[serde(default = "super::config::default_sidebar_position")]
    pub sidebar_position: String,
    #[serde(default = "super::config::default_window_opacity")]
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
    #[serde(default = "super::config::default_link_preview")]
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
    #[serde(default = "super::config::default_image_compress_webp")]
    pub image_compress_webp: bool,
    #[serde(default = "super::config::default_image_compress_quality")]
    pub image_compress_quality: f64,
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
    pub(super) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: BTreeMap::new(),
        }
    }

    pub(super) fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }

    pub(super) fn note_not_found(id: &str) -> Self {
        Self::new("noteNotFound", format!("Note {id} was not found")).with_detail("noteId", id)
    }

    pub(super) fn unsupported_file() -> Self {
        Self::new("unsupportedFile", "只支持导入 .md 文件")
    }

    pub(super) fn category_name_empty() -> Self {
        Self::new("categoryNameEmpty", "分类名不能为空")
    }

    pub(super) fn category_name_invalid_chars() -> Self {
        Self::new("categoryNameInvalidChars", "分类名不能包含特殊字符")
    }

    pub(super) fn category_not_found(name: &str) -> Self {
        Self::new("categoryNotFound", format!("分类「{name}」不存在")).with_detail("category", name)
    }

    pub(super) fn category_already_exists(name: &str) -> Self {
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
pub(super) struct MetadataFile {
    pub(super) notes: Vec<NoteMetadata>,
}

pub(super) fn unsafe_path_error(field: &str) -> AppError {
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

pub(super) fn validate_metadata(metadata: &MetadataFile) -> Result<(), AppError> {
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
