use super::{
    config::{default_close_tab_shortcut, default_command_palette_shortcut, resolve_data_dir},
    migration::{invalidate_data_dir_reconciliation, known_data_migration_candidates_for},
    AppConfig, MergeNotesRequest, NoteStore, NoteTemplate, SaveNoteRequest,
};
use crate::json_io::write_json_atomic;
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

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
    write_json_atomic(&store.config_path(), &store.default_config()).expect("write default config");

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
    assert_eq!(default_config.quick_capture_shortcut, "Alt+Shift+Space");
    assert_eq!(default_config.preset_theme, "default");
    assert_eq!(default_config.code_theme, "light");
    assert_eq!(default_config.editor_line_height, 1.8);
    assert_eq!(default_config.window_opacity, 1.0);
    assert!(default_config.link_preview);
    assert!(default_config.templates.is_empty());
    assert_eq!(default_config.locale, "zh-CN");
    assert!(default_config.image_compress_webp);
    assert_eq!(default_config.image_compress_quality, 0.85);
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
        command_palette_shortcut: default_command_palette_shortcut(),
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
        quick_capture_shortcut: "Ctrl+Alt+Space".into(),
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
        sync_provider: "none".into(),
        sync_auto_interval_minutes: 0,
        sync_webdav_url: String::new(),
        sync_webdav_username: String::new(),
        sync_webdav_remote_dir: "floral-notepaper".into(),
        sync_git_remote_url: String::new(),
        sync_git_branch: "main".into(),
        sync_git_username: String::new(),
        notes_dir: None,
        last_known_base_dir: None,
        image_compress_webp: false,
        image_compress_quality: 0.72,
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
    assert_eq!(loaded.quick_capture_shortcut, "Alt+Shift+Space");
}

#[test]
fn app_config_deserialization_defaults_missing_quick_capture_shortcut_and_preserves_empty() {
    let missing_json = r#"{
  "globalShortcut": "Ctrl+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split"
}"#;
    let parsed_missing: AppConfig = serde_json::from_str(missing_json)
        .expect("deserialize config without quickCaptureShortcut");
    assert_eq!(parsed_missing.quick_capture_shortcut, "Alt+Shift+Space");

    let empty_json = r#"{
  "globalShortcut": "Ctrl+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split",
  "quickCaptureShortcut": ""
}"#;
    let parsed_empty: AppConfig = serde_json::from_str(empty_json)
        .expect("deserialize config with empty quickCaptureShortcut");
    assert_eq!(parsed_empty.quick_capture_shortcut, "");
    assert!(parsed_empty.image_compress_webp);
    assert_eq!(parsed_empty.image_compress_quality, 0.85);
}

#[test]
fn app_config_clamps_image_compress_quality_on_load_and_save() {
    let store = test_store("image-compress-quality-clamp");
    fs::create_dir_all(store.config_dir.as_path()).expect("create config dir");
    fs::write(
        store.config_path(),
        r#"{
  "globalShortcut": "Ctrl+Space",
  "closeToTray": true,
  "autostart": false,
  "defaultViewMode": "split",
  "imageCompressWebp": false,
  "imageCompressQuality": 0.2
}"#,
    )
    .expect("write config with low quality");

    let loaded = store.load_config().expect("load config");
    assert!(!loaded.image_compress_webp);
    assert_eq!(loaded.image_compress_quality, 0.60);

    let mut high = loaded;
    high.image_compress_quality = 1.5;
    let saved = store
        .save_config(high)
        .expect("save config with high quality");
    assert_eq!(saved.image_compress_quality, 0.95);
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
    fs::write(custom_dir.join("分类").join("id-2_归类.md"), "# 归类").expect("write category note");

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

    let config: AppConfig =
        serde_json::from_str(&fs::read_to_string(new_store.config_path()).expect("read config"))
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
    write_json_atomic(&store.config_path(), &store.default_config()).expect("write default config");
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
    write_json_atomic(&store.config_path(), &store.default_config()).expect("write default config");
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

#[test]
fn resolves_data_dir_without_scanning_legacy_when_config_already_exists() {
    let root = test_root("isolated-env-resolve");
    let config_dir = root.join("config");
    let data_dir = root.join("data");
    let store = NoteStore::new(config_dir.clone(), data_dir.clone());
    let config = store.load_config().expect("create fresh isolated config");
    assert_eq!(
        config.data_dir.as_deref(),
        Some(data_dir.to_string_lossy().as_ref())
    );
    assert_eq!(
        resolve_data_dir(&config_dir).expect("resolve data dir"),
        data_dir
    );
}

#[test]
fn config_store_reads_and_writes_config_without_initializing_sqlite() {
    struct EnvRestore {
        config_dir: Option<std::ffi::OsString>,
        data_dir: Option<std::ffi::OsString>,
    }
    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.config_dir {
                Some(v) => std::env::set_var("FLORAL_NOTEPAPER_CONFIG_DIR", v),
                None => std::env::remove_var("FLORAL_NOTEPAPER_CONFIG_DIR"),
            }
            match &self.data_dir {
                Some(v) => std::env::set_var("FLORAL_NOTEPAPER_DATA_DIR", v),
                None => std::env::remove_var("FLORAL_NOTEPAPER_DATA_DIR"),
            }
        }
    }

    let root = test_root("config-store-no-db");
    let config_dir = root.join("config");
    let data_dir = root.join("data");
    let _restore = EnvRestore {
        config_dir: std::env::var_os("FLORAL_NOTEPAPER_CONFIG_DIR"),
        data_dir: std::env::var_os("FLORAL_NOTEPAPER_DATA_DIR"),
    };
    std::env::set_var("FLORAL_NOTEPAPER_CONFIG_DIR", &config_dir);
    std::env::set_var("FLORAL_NOTEPAPER_DATA_DIR", &data_dir);

    let store = super::config_store().expect("create config_store");
    let mut cfg = store.load_config().expect("load config");
    cfg.surface_width = Some(420);
    cfg.surface_height = Some(360);
    store.save_config(cfg).expect("save config");

    let reloaded = super::config_store()
        .expect("recreate config_store")
        .load_config()
        .expect("reload config");
    assert_eq!(reloaded.surface_width, Some(420));
    assert_eq!(reloaded.surface_height, Some(360));
    assert!(
        !data_dir.join("floral.db").exists(),
        "config_store must not initialize floral.db"
    );
}
