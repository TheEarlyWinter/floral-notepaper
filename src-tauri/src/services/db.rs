//! SQLite 派生索引层。
//!
//! `metadata.json` 与 Markdown 文件才是笔记的权威数据；SQLite 只保存可重建的
//! 元数据镜像和 FTS5 索引。这样即使数据库损坏、恢复备份或迁移数据目录，也不会
//! 让旧索引覆盖真实笔记。

use crate::services::notes::{AppError, Note, NoteMetadata};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// 一个进程可能短暂同时接触旧/新数据目录（例如迁移期间），因此连接按目录隔离。
/// 所有 Connection 都由同一把锁串行访问，满足 rusqlite Connection 的线程约束。
static DATABASES: OnceLock<Mutex<HashMap<PathBuf, Connection>>> = OnceLock::new();

fn databases() -> &'static Mutex<HashMap<PathBuf, Connection>> {
    DATABASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn db_error(message: impl Into<String>) -> AppError {
    AppError {
        code: "db".into(),
        message: message.into(),
        details: Default::default(),
    }
}

fn database_key(data_dir: &Path) -> Result<PathBuf, AppError> {
    fs::create_dir_all(data_dir).map_err(|e| db_error(format!("无法创建数据目录: {e}")))?;
    Ok(fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf()))
}

fn existing_database_key(data_dir: &Path) -> PathBuf {
    fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf())
}

/// 初始化指定数据目录的数据库连接。重复调用同一目录是幂等的；不同目录各自持有连接。
pub fn init_db(data_dir: &Path) -> Result<(), AppError> {
    let key = database_key(data_dir)?;
    let mut map = databases()
        .lock()
        .map_err(|e| db_error(format!("数据库锁获取失败: {e}")))?;
    if map.contains_key(&key) {
        return Ok(());
    }

    let db_path = key.join("floral.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| db_error(format!("无法打开数据库: {e}")))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|e| db_error(format!("WAL 模式设置失败: {e}")))?;
    migrate(&conn)?;
    map.insert(key, conn);
    Ok(())
}

/// 关闭某目录的进程内连接。数据迁移清理旧目录前必须先调用它，避免 Windows 文件锁。
pub fn close_db(data_dir: &Path) {
    let Some(databases) = DATABASES.get() else {
        return;
    };
    if let Ok(mut map) = databases.lock() {
        map.remove(&existing_database_key(data_dir));
    }
}

/// 清空一个目录的派生表。用于备份恢复后，确保旧缓存绝不会参与新数据的读取。
pub fn reset_derived_data(data_dir: &Path) -> Result<(), AppError> {
    init_db(data_dir)?;
    with_db(data_dir, |conn| {
        conn.execute_batch(
            "DELETE FROM notes;
             DELETE FROM notes_fts;
             DELETE FROM search_state;",
        )
        .map_err(|e| db_error(format!("重置派生索引失败: {e}")))?;
        Ok(())
    })
}

/// 执行数据库迁移。
fn migrate(conn: &Connection) -> Result<(), AppError> {
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| db_error(format!("数据库完整性检查失败: {e}")))?;
    if integrity != "ok" {
        eprintln!("[花笺] 数据库完整性警告: {integrity}");
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            word_count INTEGER NOT NULL DEFAULT 0,
            preview TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            pinned INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            note_id UNINDEXED,
            title,
            content,
            tokenize='trigram'
        );

        CREATE TABLE IF NOT EXISTS search_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| db_error(format!("数据库迁移失败: {e}")))?;

    Ok(())
}

fn with_db<T>(
    data_dir: &Path,
    f: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let key = existing_database_key(data_dir);
    let mut map = databases()
        .lock()
        .map_err(|e| db_error(format!("数据库锁获取失败: {e}")))?;
    let conn = map
        .get_mut(&key)
        .ok_or_else(|| db_error("数据库未初始化"))?;
    f(conn)
}

fn insert_note_metadata(conn: &Connection, note: &NoteMetadata) -> Result<(), AppError> {
    let tags_json = serde_json::to_string(&note.tags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT OR REPLACE INTO notes
         (id, title, file_name, category, created_at, updated_at,
          word_count, preview, tags, pinned)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            note.id,
            note.title,
            note.file_name,
            note.category,
            note.created_at.to_rfc3339(),
            note.updated_at.to_rfc3339(),
            note.word_count as i64,
            note.preview,
            tags_json,
            note.pinned as i64,
        ],
    )
    .map_err(|e| db_error(format!("写入笔记元数据失败: {e}")))?;
    Ok(())
}

// ── FTS5 搜索 ──

/// 更新指定笔记的 FTS5 索引。
pub fn db_fts_upsert(
    data_dir: &Path,
    id: &str,
    title: &str,
    content: &str,
) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| db_error(format!("FTS 事务开启失败: {e}")))?;
        tx.execute("DELETE FROM notes_fts WHERE note_id = ?1", params![id])
            .map_err(|e| db_error(format!("删除 FTS 旧索引失败: {e}")))?;
        tx.execute(
            "INSERT INTO notes_fts (note_id, title, content) VALUES (?1, ?2, ?3)",
            params![id, title, content],
        )
        .map_err(|e| db_error(format!("插入 FTS 索引失败: {e}")))?;
        tx.commit()
            .map_err(|e| db_error(format!("FTS 事务提交失败: {e}")))?;
        Ok(())
    })
}

/// 从 FTS5 索引中删除指定笔记。
pub fn db_fts_delete(data_dir: &Path, id: &str) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        conn.execute("DELETE FROM notes_fts WHERE note_id = ?1", params![id])
            .map_err(|e| db_error(format!("FTS 删除失败: {e}")))?;
        Ok(())
    })
}

/// 用权威 Markdown 全量重建元数据镜像和 FTS。两张表与指纹在同一事务提交。
pub fn db_rebuild_from_notes(
    data_dir: &Path,
    notes: &[Note],
    fingerprint: &str,
) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| db_error(format!("重建索引事务开启失败: {e}")))?;
        tx.execute("DELETE FROM notes", [])
            .map_err(|e| db_error(format!("清空笔记元数据失败: {e}")))?;
        tx.execute("DELETE FROM notes_fts", [])
            .map_err(|e| db_error(format!("清空 FTS 索引失败: {e}")))?;

        for note in notes {
            let metadata = NoteMetadata {
                id: note.id.clone(),
                title: note.title.clone(),
                file_name: note.file_name.clone(),
                category: note.category.clone(),
                created_at: note.created_at,
                updated_at: note.updated_at,
                word_count: note.word_count,
                preview: note
                    .content
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(140)
                    .collect(),
                tags: note.tags.clone(),
                pinned: note.pinned,
            };
            let tags_json = serde_json::to_string(&metadata.tags).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT INTO notes
                 (id, title, file_name, category, created_at, updated_at,
                  word_count, preview, tags, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    metadata.id,
                    metadata.title,
                    metadata.file_name,
                    metadata.category,
                    metadata.created_at.to_rfc3339(),
                    metadata.updated_at.to_rfc3339(),
                    metadata.word_count as i64,
                    metadata.preview,
                    tags_json,
                    metadata.pinned as i64,
                ],
            )
            .map_err(|e| db_error(format!("重建笔记元数据失败: {e}")))?;
            tx.execute(
                "INSERT INTO notes_fts (note_id, title, content) VALUES (?1, ?2, ?3)",
                params![note.id, note.title, note.content],
            )
            .map_err(|e| db_error(format!("重建 FTS 索引失败: {e}")))?;
        }

        tx.execute(
            "INSERT INTO search_state (key, value) VALUES ('fts_fingerprint', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![fingerprint],
        )
        .map_err(|e| db_error(format!("保存 FTS 状态失败: {e}")))?;
        tx.commit()
            .map_err(|e| db_error(format!("重建索引事务提交失败: {e}")))?;
        Ok(())
    })
}

pub fn db_fts_is_current(data_dir: &Path, fingerprint: &str) -> Result<bool, AppError> {
    with_db(data_dir, |conn| {
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM search_state WHERE key = 'fts_fingerprint'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| db_error(format!("读取 FTS 状态失败: {e}")))?;
        Ok(stored.as_deref() == Some(fingerprint))
    })
}

/// 在增量更新 FTS 完成后提交对应的权威数据指纹。
pub fn db_set_fts_fingerprint(data_dir: &Path, fingerprint: &str) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        conn.execute(
            "INSERT INTO search_state (key, value) VALUES ('fts_fingerprint', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![fingerprint],
        )
        .map_err(|e| db_error(format!("保存 FTS 状态失败: {e}")))?;
        Ok(())
    })
}

pub fn db_search_fts(data_dir: &Path, query: &str) -> Result<Vec<String>, AppError> {
    with_db(data_dir, |conn| {
        let fts_query = escape_fts_query(query);
        let mut stmt = conn
            .prepare(
                "SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT 50",
            )
            .map_err(|e| db_error(format!("FTS 查询准备失败: {e}")))?;
        let ids: Vec<String> = stmt
            .query_map(params![fts_query], |row| row.get(0))
            .map_err(|e| db_error(format!("FTS 查询执行失败: {e}")))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    })
}

/// 转义 FTS5 查询字符串。每个用户词都作为严格短语，再用 AND 连接；
/// 既不暴露 FTS 的 OR/NOT/通配符语法，也不会把普通的多词搜索误解为一段带空格的文本。
fn escape_fts_query(query: &str) -> String {
    let terms = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        // FTS5 的空字符串短语会匹配全表：改用必然无结果的占位词
        "\"__floral_no_match__\"".into()
    } else {
        terms.join(" AND ")
    }
}

pub fn is_initialized(data_dir: &Path) -> bool {
    let key = existing_database_key(data_dir);
    DATABASES
        .get()
        .and_then(|databases| databases.lock().ok())
        .is_some_and(|map| map.contains_key(&key))
}

// ── Notes 元数据镜像 CRUD ──

pub fn db_notes_get_all(data_dir: &Path) -> Result<Vec<NoteMetadata>, AppError> {
    with_db(data_dir, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, file_name, category, created_at, updated_at,
                        word_count, preview, tags, pinned
                 FROM notes ORDER BY updated_at DESC",
            )
            .map_err(|e| db_error(format!("查询笔记列表失败: {e}")))?;
        let notes: Vec<NoteMetadata> = stmt
            .query_map([], |row| {
                let created_at_str: String = row.get("created_at")?;
                let updated_at_str: String = row.get("updated_at")?;
                let tags_json: String = row.get("tags")?;
                let id: String = row.get("id")?;
                let id_for_log = id.clone();
                Ok(NoteMetadata {
                    id,
                    title: row.get("title")?,
                    file_name: row.get("file_name")?,
                    category: row.get("category")?,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
                        .unwrap_or_else(|_| {
                            eprintln!("[花笺] 警告: 笔记 {id_for_log} 的 created_at 损坏: '{created_at_str}'");
                            chrono::DateTime::parse_from_rfc3339("1970-01-01T00:00:00+00:00").expect("valid epoch")
                        })
                        .with_timezone(&chrono::Utc),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at_str)
                        .unwrap_or_else(|_| {
                            eprintln!("[花笺] 警告: 笔记 {id_for_log} 的 updated_at 损坏: '{updated_at_str}'");
                            chrono::DateTime::parse_from_rfc3339("1970-01-01T00:00:00+00:00").expect("valid epoch")
                        })
                        .with_timezone(&chrono::Utc),
                    word_count: row.get::<_, i64>("word_count")? as usize,
                    preview: row.get("preview")?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_else(|_| {
                        eprintln!("[花笺] 警告: 笔记 {id_for_log} 的 tags 解析失败");
                        vec![]
                    }),
                    pinned: row.get::<_, i64>("pinned")? != 0,
                })
            })
            .map_err(|e| db_error(format!("读取笔记元数据失败: {e}")))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(notes)
    })
}

pub fn db_notes_upsert(data_dir: &Path, note: &NoteMetadata) -> Result<(), AppError> {
    with_db(data_dir, |conn| insert_note_metadata(conn, note))
}

pub fn db_notes_delete(data_dir: &Path, id: &str) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .map_err(|e| db_error(format!("删除笔记元数据失败: {e}")))?;
        Ok(())
    })
}

pub fn db_notes_clear(data_dir: &Path) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        conn.execute("DELETE FROM notes", [])
            .map_err(|e| db_error(format!("清空笔记元数据失败: {e}")))?;
        Ok(())
    })
}

pub fn db_notes_is_empty(data_dir: &Path) -> Result<bool, AppError> {
    with_db(data_dir, |conn| {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .map_err(|e| db_error(format!("查询笔记计数失败: {e}")))?;
        Ok(count == 0)
    })
}

/// 权威 JSON 写入成功后的镜像更新。调用者可将失败降级为日志，因为 JSON/Markdown
/// 本身已经完整持久化，后续会由 FTS 指纹校验自动重建。
pub fn db_notes_replace_all(data_dir: &Path, notes: &[NoteMetadata]) -> Result<(), AppError> {
    with_db(data_dir, |conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| db_error(format!("事务开始失败: {e}")))?;
        tx.execute("DELETE FROM notes", [])
            .map_err(|e| db_error(format!("清空笔记元数据失败: {e}")))?;
        for note in notes {
            let tags_json = serde_json::to_string(&note.tags).unwrap_or_else(|_| "[]".into());
            tx.execute(
                "INSERT OR REPLACE INTO notes
                 (id, title, file_name, category, created_at, updated_at,
                  word_count, preview, tags, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    note.id,
                    note.title,
                    note.file_name,
                    note.category,
                    note.created_at.to_rfc3339(),
                    note.updated_at.to_rfc3339(),
                    note.word_count as i64,
                    note.preview,
                    tags_json,
                    note.pinned as i64,
                ],
            )
            .map_err(|e| db_error(format!("写入笔记元数据失败: {e}")))?;
        }
        tx.commit()
            .map_err(|e| db_error(format!("事务提交失败: {e}")))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::escape_fts_query;

    #[test]
    fn escapes_each_search_term_without_exposing_fts_operators() {
        assert_eq!(escape_fts_query("齿轮 强度"), "\"齿轮\" AND \"强度\"");
        assert_eq!(
            escape_fts_query("a\"b OR c"),
            "\"a\"\"b\" AND \"OR\" AND \"c\""
        );
    }
}
