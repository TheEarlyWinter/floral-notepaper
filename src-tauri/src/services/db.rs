//! SQLite 数据库层。
//! 管理连接、schema 迁移、FTS5 全文搜索。
//!
//! 数据库文件：{data_dir}/floral.db
//! 使用 WAL 模式支持多窗口并发读。
//!
//! 注意：当前 notes 元数据仍走 metadata.json。
//! notes 表和 db_insert_note/db_delete_note 留待 Phase 2c（metadata→SQLite）实现。
//! 目前只有 FTS5 索引（notes_fts）在生产中使用。

use crate::services::notes::AppError;
use rusqlite::{params, Connection, OpenFlags};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

/// 初始化数据库连接。必须在确定 data_dir 后调用一次。
/// 幂等：重复调用不会重新打开（OnceLock 保证单次初始化）。
pub fn init_db(data_dir: &Path) -> Result<(), AppError> {
    if DB.get().is_some() {
        return Ok(());
    }

    // 确保父目录存在（首次启动时 data_dir 可能尚未创建）
    fs::create_dir_all(data_dir).map_err(|e| AppError {
        code: "db".into(),
        message: format!("无法创建数据目录: {e}"),
        details: Default::default(),
    })?;

    let db_path = data_dir.join("floral.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| AppError {
        code: "db".into(),
        message: format!("无法打开数据库: {e}"),
        details: Default::default(),
    })?;

    // WAL 模式：支持并发读
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| AppError {
            code: "db".into(),
            message: format!("WAL 模式设置失败: {e}"),
            details: Default::default(),
        })?;

    // 创建 schema
    migrate(&conn)?;

    // OnceLock::set 在已设置时返回 Err，说明存在竞态——此时 DB 已被另一线程初始化，忽略即可
    let _ = DB.set(Mutex::new(conn));

    Ok(())
}

/// 执行数据库迁移
fn migrate(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            note_id UNINDEXED,
            title,
            content,
            tokenize='trigram'
        );",
    )
    .map_err(|e| AppError {
        code: "db".into(),
        message: format!("数据库迁移失败: {e}"),
        details: Default::default(),
    })?;

    Ok(())
}

/// 获取数据库连接的锁。如果尚未初始化则返回错误。
fn with_db<T>(f: impl FnOnce(&Connection) -> Result<T, AppError>) -> Result<T, AppError> {
    let guard = DB.get().ok_or_else(|| AppError {
        code: "db".into(),
        message: "数据库未初始化".into(),
        details: Default::default(),
    })?;

    let conn = guard.lock().map_err(|e| AppError {
        code: "db".into(),
        message: format!("数据库锁获取失败: {e}"),
        details: Default::default(),
    })?;

    f(&conn)
}

// ── FTS5 搜索 ──

/// 更新指定笔记的 FTS5 索引
pub fn db_fts_upsert(id: &str, title: &str, content: &str) -> Result<(), AppError> {
    with_db(|conn| {
        // 显式事务：避免 DELETE/INSERT 之间的窗口期被并发搜索看到空结果
        conn.execute("BEGIN", [])
            .map_err(|e| AppError {
                code: "db".into(),
                message: format!("事务开启失败: {e}"),
                details: Default::default(),
            })?;

        let result = (|| -> Result<(), AppError> {
            conn.execute("DELETE FROM notes_fts WHERE note_id = ?1", params![id])
                .map_err(|e| AppError {
                    code: "db".into(),
                    message: format!("删除 FTS 旧索引失败: {e}"),
                    details: Default::default(),
                })?;
            conn.execute(
                "INSERT INTO notes_fts (note_id, title, content) VALUES (?1, ?2, ?3)",
                params![id, title, content],
            )
            .map_err(|e| AppError {
                code: "db".into(),
                message: format!("插入 FTS 索引失败: {e}"),
                details: Default::default(),
            })?;
            Ok(())
        })();

        if result.is_err() {
            let _ = conn.execute("ROLLBACK", []);
            return result;
        }

        conn.execute("COMMIT", [])
            .map_err(|e| AppError {
                code: "db".into(),
                message: format!("事务提交失败: {e}"),
                details: Default::default(),
            })?;

        Ok(())
    })
}

/// 从 FTS5 索引中删除指定笔记
pub fn db_fts_delete(id: &str) -> Result<(), AppError> {
    with_db(|conn| {
        conn.execute("DELETE FROM notes_fts WHERE note_id = ?1", params![id])
            .map_err(|e| AppError {
                code: "db".into(),
                message: format!("FTS 删除失败: {e}"),
                details: Default::default(),
            })?;
        Ok(())
    })
}

pub fn db_search_fts(query: &str) -> Result<Vec<String>, AppError> {
    with_db(|conn| {
        let fts_query = escape_fts_query(query);

        let mut stmt = conn
            .prepare(
                "SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?1 ORDER BY rank LIMIT 50",
            )
            .map_err(|e| AppError {
                code: "db".into(),
                message: format!("FTS 查询准备失败: {e}"),
                details: Default::default(),
            })?;

        let ids: Vec<String> = stmt
            .query_map(params![fts_query], |row| row.get(0))
            .map_err(|e| AppError {
                code: "db".into(),
                message: format!("FTS 查询执行失败: {e}"),
                details: Default::default(),
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(ids)
    })
}

/// 转义 FTS5 查询字符串。
///
/// 当前策略：双引号包裹为严格短语匹配，转义内部双引号。
/// 不支持 FTS5 通配符（*）、布尔操作符（AND/OR/NOT）等高级语法。
/// 这是有意为之——防止用户输入的特殊字符意外触发 FTS5 语法。
fn escape_fts_query(query: &str) -> String {
    let escaped = query.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// 检查数据库是否已初始化
pub fn is_initialized() -> bool {
    DB.get().is_some()
}
