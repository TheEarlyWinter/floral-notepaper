use super::migration::{
    canonical_for_compare, copy_dir_recursive, known_data_migration_candidates, remap_path_prefix,
};
use super::types::{AppConfig, AppError};
use super::NoteStore;
use crate::json_io::write_json_atomic;
use serde::Deserialize;
use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};

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
pub(super) const MACOS_SHORTCUT_MIGRATION_MARKER: &str = ".macos-shortcut-default-v3";

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

// config.json 是唯一没有独立写锁的 JSON：多窗口并发保存设置会互相覆盖。
static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_config() -> Result<MutexGuard<'static, ()>, AppError> {
    CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| AppError::new("configLock", "配置锁已中毒，请重启应用后重试"))
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    env::var(name).ok().and_then(|path| {
        let trimmed = path.trim();
        (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
    })
}

pub(super) fn has_isolated_env_override() -> bool {
    non_empty_env_path("FLORAL_NOTEPAPER_CONFIG_DIR").is_some()
        || non_empty_env_path("FLORAL_NOTEPAPER_DATA_DIR").is_some()
}

pub(crate) fn default_config_dir() -> Result<PathBuf, AppError> {
    if let Some(dir) = non_empty_env_path("FLORAL_NOTEPAPER_CONFIG_DIR") {
        return Ok(dir);
    }
    if let Some(dir) = dirs::config_dir() {
        return Ok(dir.join("floral-notepaper"));
    }
    Ok(env::current_dir()?.join("floral-notepaper"))
}

fn default_data_dir() -> Result<PathBuf, AppError> {
    if let Some(dir) = non_empty_env_path("FLORAL_NOTEPAPER_DATA_DIR") {
        return Ok(dir);
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

pub(super) fn resolve_data_dir(config_dir: &Path) -> Result<PathBuf, AppError> {
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

    if !cfg!(test) && !has_isolated_env_override() {
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
    }

    default_data_dir()
}

pub(super) fn data_dir_from_notes_dir(notes_dir: &str) -> PathBuf {
    let path = Path::new(notes_dir);
    if path.file_name().and_then(|n| n.to_str()) == Some("notes") {
        if let Some(parent) = path.parent() {
            return parent.to_path_buf();
        }
    }
    path.to_path_buf()
}

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
    #[cfg(target_os = "macos")]
    pub(super) fn macos_shortcut_migration_path(&self) -> PathBuf {
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
            config.image_compress_quality =
                normalize_image_compress_quality(config.image_compress_quality);
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
        config.image_compress_quality =
            normalize_image_compress_quality(config.image_compress_quality);
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
        config.image_compress_quality =
            normalize_image_compress_quality(config.image_compress_quality);
        is_safe_data_dir(&self.data_dir)?;
        fs::create_dir_all(self.data_dir.join("notes"))?;
        write_json_atomic(&self.config_path(), &config)?;
        Ok(config)
    }

    pub(crate) fn default_config(&self) -> AppConfig {
        AppConfig {
            locale: default_locale(),
            data_dir: Some(self.data_dir.to_string_lossy().to_string()),
            #[cfg(target_os = "macos")]
            global_shortcut: DEFAULT_MACOS_GLOBAL_SHORTCUT.into(),
            #[cfg(not(target_os = "macos"))]
            global_shortcut: "Ctrl+Space".into(),
            close_to_tray: true,
            close_tab_shortcut: default_close_tab_shortcut(),
            command_palette_shortcut: default_command_palette_shortcut(),
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
            quick_capture_shortcut: default_quick_capture_shortcut(),
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
            sync_provider: default_sync_provider(),
            sync_auto_interval_minutes: 0,
            sync_webdav_url: String::new(),
            sync_webdav_username: String::new(),
            sync_webdav_remote_dir: default_sync_webdav_remote_dir(),
            sync_git_remote_url: String::new(),
            sync_git_branch: default_sync_git_branch(),
            sync_git_username: String::new(),
            notes_dir: None,
            last_known_base_dir: None,
            image_compress_webp: default_image_compress_webp(),
            image_compress_quality: default_image_compress_quality(),
        }
    }

    fn ensure_config_dir(&self) -> Result<(), AppError> {
        fs::create_dir_all(&self.config_dir)?;
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

pub(super) fn default_note_auto_save() -> bool {
    true
}

pub(super) fn default_note_surface_auto_save() -> bool {
    true
}

pub(super) fn default_tile_color() -> String {
    "#f6f3ec".into()
}

pub(super) fn default_close_tab_shortcut() -> String {
    "Ctrl+W".into()
}

pub(super) fn default_command_palette_shortcut() -> String {
    "Ctrl+K".into()
}

pub(super) fn default_tile_color_mode() -> String {
    "system".into()
}

pub(super) fn default_theme() -> String {
    "system".into()
}

pub(super) fn default_font_size() -> u32 {
    14
}

pub(super) fn default_surface_font_size() -> u32 {
    14
}

pub(super) fn default_tab_indent_size() -> u32 {
    2
}

pub(super) fn default_external_file_auto_save() -> bool {
    true
}

pub(super) fn default_background_fit() -> String {
    "cover".into()
}

pub(super) fn default_background_dim() -> f64 {
    0.25
}

pub(super) fn default_background_blur() -> f64 {
    0.0
}

pub(super) fn default_background_scale() -> f64 {
    1.0
}

pub(super) fn default_background_position() -> f64 {
    50.0
}

pub(super) fn default_remember_surface_size() -> bool {
    true
}

pub(super) fn default_tile_ctrl_close() -> bool {
    true
}

pub(super) fn default_split_scroll_sync() -> bool {
    true
}

pub(super) fn default_toggle_visibility_shortcut() -> String {
    String::new()
}

pub(super) fn default_quick_capture_shortcut() -> String {
    "Alt+Shift+Space".into()
}

pub(super) fn default_open_at_cursor() -> bool {
    true
}

pub(super) fn default_preset_theme() -> String {
    "default".into()
}

pub(super) fn default_code_theme() -> String {
    "light".into()
}

pub(super) fn default_editor_line_height() -> f64 {
    1.8
}

pub(super) fn default_editor_width() -> String {
    "normal".into()
}

pub(super) fn default_sidebar_position() -> String {
    "left".into()
}

pub(super) fn default_window_opacity() -> f64 {
    1.0
}

pub(super) fn default_link_preview() -> bool {
    true
}

pub(super) fn default_locale() -> String {
    "zh-CN".into()
}

pub(super) fn default_image_compress_webp() -> bool {
    true
}

pub(super) fn default_image_compress_quality() -> f64 {
    0.85
}

fn normalize_image_compress_quality(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.60, 0.95)
    } else {
        default_image_compress_quality()
    }
}

pub(super) fn default_sync_provider() -> String {
    "none".into()
}

pub(super) fn default_sync_webdav_remote_dir() -> String {
    "floral-notepaper".into()
}

pub(super) fn default_sync_git_branch() -> String {
    "main".into()
}
