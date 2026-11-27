mod config;
mod migration;
mod store;
#[cfg(test)]
mod tests;
mod types;
mod versions;

pub(crate) use config::default_config_dir;
pub use store::NoteStore;
#[allow(unused_imports)]
pub(crate) use types::{validate_category_name, validate_note_file_name};
pub(crate) use types::{
    validate_metadata, validate_metadata_json, validate_note_id, validate_relative_file_name,
    MetadataFile,
};
pub use types::{
    AppConfig, AppError, MergeNotesRequest, Note, NoteMetadata, NoteTemplate, NoteVersion,
    SaveNoteRequest,
};

pub fn default_store() -> Result<NoteStore, AppError> {
    let config_dir = default_config_dir()?;
    let data_dir = config::resolve_data_dir(&config_dir)?;
    let store = NoteStore::new(config_dir, data_dir);
    // 必须先处理可能存在的数据目录迁移。若先创建 floral.db，空目标目录会被误判为
    // "已有用户数据"，从而跳过旧 JSON/Markdown 的迁移。
    store.load_config()?;
    if let Err(e) = crate::services::db::init_db(store.data_dir()) {
        eprintln!("[花笺] 数据库初始化失败，FTS5 搜索不可用: {e}");
    }
    Ok(store)
}

/// 仅用于读写 `config.json` 的轻量 store：不重复调用 `load_config()`，也不初始化
/// SQLite 派生库 `floral.db`。适用于窗口关闭/回收等仅需读写配置的场景。
pub fn config_store() -> Result<NoteStore, AppError> {
    let config_dir = default_config_dir()?;
    let data_dir = config::resolve_data_dir(&config_dir)?;
    Ok(NoteStore::new(config_dir, data_dir))
}
