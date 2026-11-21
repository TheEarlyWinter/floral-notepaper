use crate::{
    desktop,
    json_io::write_json_atomic,
    services::notes::{default_store, AppError},
};
use chrono::{DateTime, Utc};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub const DEFAULT_PIN_TILE_TTL_SECS: u64 = 300;
pub const MAX_EXTERNAL_ACTIVITY_ENTRIES: usize = 50;

const COMMANDS_FILE: &str = "external-commands.json";
const COMMANDS_LOCK_FILE: &str = "external-commands.json.lock";
const ACTIVITY_FILE: &str = "external-activity.json";
const ACTIVITY_LOCK_FILE: &str = "external-activity.json.lock";
const REV_FILE: &str = ".external-rev";
const REV_LOCK_FILE: &str = ".external-rev.lock";
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_ACTIVITY_ACTION_CHARS: usize = 64;
const MAX_ACTIVITY_TARGET_CHARS: usize = 120;
const MAX_ACTIVITY_SUMMARY_CHARS: usize = 200;

static COMMANDS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static ACTIVITY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static REV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum ExternalCommand {
    PinTile {
        #[serde(rename = "noteId", alias = "note_id")]
        note_id: String,
        #[serde(
            default,
            rename = "createdAtEpochSecs",
            alias = "created_at_epoch_secs"
        )]
        created_at_epoch_secs: i64,
        #[serde(default, rename = "ttlSecs", alias = "ttl_secs")]
        ttl_secs: Option<u64>,
    },
}

pub fn now_epoch_secs() -> i64 {
    Utc::now().timestamp()
}

impl ExternalCommand {
    pub fn pin_tile(note_id: impl Into<String>, ttl_secs: Option<u64>) -> Self {
        Self::PinTile {
            note_id: note_id.into(),
            created_at_epoch_secs: now_epoch_secs(),
            ttl_secs,
        }
    }

    pub fn is_expired_at(&self, now_epoch: i64) -> bool {
        match self {
            Self::PinTile {
                created_at_epoch_secs,
                ttl_secs: Some(ttl),
                ..
            } => {
                let expires_at =
                    created_at_epoch_secs.saturating_add(i64::try_from(*ttl).unwrap_or(i64::MAX));
                now_epoch > expires_at
            }
            Self::PinTile { ttl_secs: None, .. } => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExternalCommandQueue {
    #[serde(default)]
    commands: Vec<ExternalCommand>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalActivitySource {
    Cli,
    Mcp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalActivityEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub source: ExternalActivitySource,
    pub action: String,
    pub target: String,
    pub summary: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExternalActivityLog {
    #[serde(default)]
    entries: Vec<ExternalActivityEntry>,
}

struct FileLockGuard {
    _process: MutexGuard<'static, ()>,
    _file: File,
}

fn acquire_cross_process_lock(
    process_lock: &'static OnceLock<Mutex<()>>,
    lock_path: PathBuf,
    label: &str,
) -> Result<FileLockGuard, AppError> {
    let process = process_lock
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| AppError {
            code: "externalSyncLock".into(),
            message: format!("{label} 锁已中毒"),
            details: Default::default(),
        })?;
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
        .map_err(|err| AppError {
            code: "externalSyncLock".into(),
            message: format!("无法打开 {label} 锁文件: {err}"),
            details: Default::default(),
        })?;
    file.lock_exclusive().map_err(|err| AppError {
        code: "externalSyncLock".into(),
        message: format!("无法获取 {label} 锁: {err}"),
        details: Default::default(),
    })?;
    Ok(FileLockGuard {
        _process: process,
        _file: file,
    })
}

fn commands_path(data_dir: &Path) -> PathBuf {
    data_dir.join(COMMANDS_FILE)
}

fn activity_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ACTIVITY_FILE)
}

fn rev_path(data_dir: &Path) -> PathBuf {
    data_dir.join(REV_FILE)
}

fn sanitize_activity_text(raw: &str, max_chars: usize) -> String {
    let single_line: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = single_line.chars().count();
    if count <= max_chars {
        return single_line;
    }
    if max_chars <= 1 {
        return single_line.chars().take(max_chars).collect();
    }
    let mut out: String = single_line.chars().take(max_chars - 1).collect();
    out.push('…');
    out
}

pub fn enqueue_command(data_dir: &Path, command: ExternalCommand) -> Result<(), AppError> {
    let _guard = acquire_cross_process_lock(
        &COMMANDS_LOCK,
        data_dir.join(COMMANDS_LOCK_FILE),
        "external-commands",
    )?;
    fs::create_dir_all(data_dir)?;
    let path = commands_path(data_dir);
    let mut queue = if path.exists() {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ExternalCommandQueue>(&raw).ok())
        {
            Some(existing) => existing,
            None => ExternalCommandQueue::default(),
        }
    } else {
        ExternalCommandQueue::default()
    };
    queue.commands.push(command);
    write_json_atomic(&path, &queue)
}

pub fn drain_commands(data_dir: &Path) -> Result<Vec<ExternalCommand>, AppError> {
    drain_commands_at(data_dir, now_epoch_secs())
}

pub fn drain_commands_at(
    data_dir: &Path,
    now_epoch: i64,
) -> Result<Vec<ExternalCommand>, AppError> {
    let path = commands_path(data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let _guard = acquire_cross_process_lock(
        &COMMANDS_LOCK,
        data_dir.join(COMMANDS_LOCK_FILE),
        "external-commands",
    )?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let queue = match fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ExternalCommandQueue>(&raw).ok())
    {
        Some(existing) => existing,
        None => ExternalCommandQueue::default(),
    };
    if !queue.commands.is_empty() {
        write_json_atomic(&path, &ExternalCommandQueue::default())?;
    }
    Ok(queue
        .commands
        .into_iter()
        .filter(|command| !command.is_expired_at(now_epoch))
        .collect())
}

pub fn record_activity(
    data_dir: &Path,
    source: ExternalActivitySource,
    action: &str,
    target: &str,
    summary: &str,
    ok: bool,
) -> Result<ExternalActivityEntry, AppError> {
    let _guard = acquire_cross_process_lock(
        &ACTIVITY_LOCK,
        data_dir.join(ACTIVITY_LOCK_FILE),
        "external-activity",
    )?;
    fs::create_dir_all(data_dir)?;
    let path = activity_path(data_dir);
    let mut log = if path.exists() {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ExternalActivityLog>(&raw).ok())
        {
            Some(existing) => existing,
            None => ExternalActivityLog::default(),
        }
    } else {
        ExternalActivityLog::default()
    };

    let entry = ExternalActivityEntry {
        id: Uuid::new_v4().to_string(),
        timestamp: Utc::now(),
        source,
        action: sanitize_activity_text(action, MAX_ACTIVITY_ACTION_CHARS),
        target: sanitize_activity_text(target, MAX_ACTIVITY_TARGET_CHARS),
        summary: sanitize_activity_text(summary, MAX_ACTIVITY_SUMMARY_CHARS),
        ok,
    };
    log.entries.insert(0, entry.clone());
    log.entries.truncate(MAX_EXTERNAL_ACTIVITY_ENTRIES);
    write_json_atomic(&path, &log)?;
    Ok(entry)
}

pub fn record_activity_best_effort(
    data_dir: &Path,
    source: ExternalActivitySource,
    action: &str,
    target: &str,
    summary: &str,
    ok: bool,
) {
    if let Err(err) = record_activity(data_dir, source, action, target, summary, ok) {
        eprintln!("failed to record external activity ({action}): {err}");
    }
}

pub fn list_activity(data_dir: &Path) -> Result<Vec<ExternalActivityEntry>, AppError> {
    let path = activity_path(data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let _guard = acquire_cross_process_lock(
        &ACTIVITY_LOCK,
        data_dir.join(ACTIVITY_LOCK_FILE),
        "external-activity",
    )?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut entries = match fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ExternalActivityLog>(&raw).ok())
    {
        Some(existing) => existing.entries,
        None => Vec::new(),
    };
    entries.truncate(MAX_EXTERNAL_ACTIVITY_ENTRIES);
    Ok(entries)
}

pub fn clear_activity(data_dir: &Path) -> Result<(), AppError> {
    let path = activity_path(data_dir);
    if !path.exists() {
        return Ok(());
    }
    let _guard = acquire_cross_process_lock(
        &ACTIVITY_LOCK,
        data_dir.join(ACTIVITY_LOCK_FILE),
        "external-activity",
    )?;
    if !path.exists() {
        return Ok(());
    }
    write_json_atomic(&path, &ExternalActivityLog::default())
}

pub fn read_external_rev(data_dir: &Path) -> Result<Option<String>, AppError> {
    let path = rev_path(data_dir);
    match fs::read_to_string(&path) {
        Ok(content) => {
            let trimmed = content.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Bumps the `.external-rev` marker in `<data_dir>` atomically after an external
/// CLI/MCP write so a running GUI instance detects the change cleanly.
pub fn touch_external_rev(data_dir: &Path) -> Result<(), AppError> {
    let _guard =
        acquire_cross_process_lock(&REV_LOCK, data_dir.join(REV_LOCK_FILE), "external-rev")?;
    fs::create_dir_all(data_dir)?;
    let path = rev_path(data_dir);
    let current = match fs::read_to_string(&path) {
        Ok(raw) => raw.trim().parse::<u64>().unwrap_or(0),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(err.into()),
    };
    let next = current.saturating_add(1).max(1);

    let temp_path = data_dir.join(format!("{REV_FILE}.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)?;
    file.write_all(format!("{next}\n").as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp_path, &path)?;
    Ok(())
}

fn poll_external_sync(app: &AppHandle, last_rev: &mut Option<String>) -> Result<(), AppError> {
    let store = default_store()?;
    let data_dir = store.data_dir();

    if let Some(current_rev) = read_external_rev(data_dir)? {
        if last_rev.as_deref() != Some(current_rev.as_str()) {
            *last_rev = Some(current_rev);
            let _ = app.emit("notes-external-changed", ());
            let _ = app.emit("reminders-external-changed", ());
        }
    }

    for command in drain_commands(data_dir)? {
        match command {
            ExternalCommand::PinTile { note_id, .. } => {
                if store.read_note(&note_id).is_ok() {
                    let app_handle = app.clone();
                    if let Err(err) = app.run_on_main_thread(move || {
                        if let Err(err) = desktop::open_tile_window_now(&app_handle, &note_id, None)
                        {
                            eprintln!("failed to open tile window from external command: {err}");
                        }
                    }) {
                        eprintln!("failed to dispatch external pin_tile to main thread: {err}");
                    }
                }
            }
        }
    }

    Ok(())
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_rev = tauri::async_runtime::spawn_blocking(|| {
            default_store()
                .ok()
                .and_then(|store| read_external_rev(store.data_dir()).ok().flatten())
        })
        .await
        .unwrap_or(None);

        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the immediate first tick so startup windows settle before polling.
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let app_for_poll = app.clone();
            let prev_rev = last_rev.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                let mut rev = prev_rev;
                let res = poll_external_sync(&app_for_poll, &mut rev);
                (rev, res)
            })
            .await
            {
                Ok((next_rev, Ok(()))) => {
                    last_rev = next_rev;
                }
                Ok((_, Err(err))) => {
                    eprintln!("failed to poll external sync: {err}");
                }
                Err(err) => {
                    eprintln!("external sync task join error: {err}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_data_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("floral-external-sync-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn enqueue_and_drain_commands_atomically() {
        let dir = temp_data_dir();
        assert!(drain_commands(&dir).expect("empty drain").is_empty());

        let cmd1 = ExternalCommand::pin_tile("note-1", Some(DEFAULT_PIN_TILE_TTL_SECS));
        let cmd2 = ExternalCommand::pin_tile("note-2", None);
        enqueue_command(&dir, cmd1.clone()).expect("enqueue first");
        enqueue_command(&dir, cmd2.clone()).expect("enqueue second");

        let drained = drain_commands(&dir).expect("drain queued commands");
        assert_eq!(drained, vec![cmd1, cmd2]);

        assert!(drain_commands(&dir)
            .expect("subsequent drain is empty")
            .is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn drain_recovers_from_corrupt_commands_file() {
        let dir = temp_data_dir();
        fs::write(dir.join(COMMANDS_FILE), "{not valid json").expect("write corrupt queue");
        assert!(drain_commands(&dir)
            .expect("recover from corrupt")
            .is_empty());

        let cmd = ExternalCommand::pin_tile("note-ok", Some(DEFAULT_PIN_TILE_TTL_SECS));
        enqueue_command(&dir, cmd.clone()).expect("enqueue after corrupt");
        let drained = drain_commands(&dir).expect("drain after recover");
        assert_eq!(drained, vec![cmd]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn drain_commands_prunes_expired_ttl_and_keeps_valid_and_persistent_entries() {
        let dir = temp_data_dir();

        // Expired at t = 1301 (created 1000 + ttl 300 = 1300)
        enqueue_command(
            &dir,
            ExternalCommand::PinTile {
                note_id: "expired-note".into(),
                created_at_epoch_secs: 1000,
                ttl_secs: Some(300),
            },
        )
        .expect("enqueue expired");

        // Exactly at boundary t = 1301 (created 1001 + ttl 300 = 1301) -> still valid
        enqueue_command(
            &dir,
            ExternalCommand::PinTile {
                note_id: "boundary-valid-note".into(),
                created_at_epoch_secs: 1001,
                ttl_secs: Some(300),
            },
        )
        .expect("enqueue boundary valid");

        // Persistent (ttl_secs: None) -> survives days later
        enqueue_command(
            &dir,
            ExternalCommand::PinTile {
                note_id: "persistent-note".into(),
                created_at_epoch_secs: 1000,
                ttl_secs: None,
            },
        )
        .expect("enqueue persistent");

        let drained = drain_commands_at(&dir, 1301).expect("drain with ttl pruning");
        let note_ids: Vec<&str> = drained
            .iter()
            .map(|cmd| match cmd {
                ExternalCommand::PinTile { note_id, .. } => note_id.as_str(),
            })
            .collect();
        assert_eq!(note_ids, vec!["boundary-valid-note", "persistent-note"]);

        // Queue file is cleared even for discarded commands
        assert!(drain_commands_at(&dir, 1301)
            .expect("queue cleared")
            .is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_pin_tile_json_without_ttl_deserializes_safely() {
        let dir = temp_data_dir();
        let legacy_json = json!({
            "commands": [
                { "command": "pin_tile", "noteId": "legacy-note" },
                { "command": "pin_tile", "note_id": "stale-note", "created_at_epoch_secs": 100, "ttl_secs": 300 }
            ]
        });
        fs::write(dir.join(COMMANDS_FILE), legacy_json.to_string()).expect("write legacy json");

        let drained = drain_commands_at(&dir, 1_000_000).expect("drain legacy queue");
        assert_eq!(
            drained,
            vec![ExternalCommand::PinTile {
                note_id: "legacy-note".into(),
                created_at_epoch_secs: 0,
                ttl_secs: None,
            }]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn external_activity_ring_buffer_caps_at_50_and_clears() {
        let dir = temp_data_dir();
        assert!(list_activity(&dir).expect("empty activity").is_empty());

        for i in 1..=65usize {
            let source = if i % 2 == 0 {
                ExternalActivitySource::Mcp
            } else {
                ExternalActivitySource::Cli
            };
            record_activity(
                &dir,
                source,
                &format!("action-{i}"),
                &format!("note-{i}"),
                &format!("summary-{i}"),
                i % 5 != 0,
            )
            .expect("record activity");
        }

        let entries = list_activity(&dir).expect("list capped activity");
        assert_eq!(entries.len(), MAX_EXTERNAL_ACTIVITY_ENTRIES);
        assert_eq!(entries[0].action, "action-65");
        assert_eq!(entries[0].source, ExternalActivitySource::Cli);
        assert_eq!(entries[0].ok, false);
        assert_eq!(entries[1].action, "action-64");
        assert_eq!(entries[1].source, ExternalActivitySource::Mcp);
        assert_eq!(entries[49].action, "action-16");
        assert!(!entries.iter().any(|e| e.action == "action-15"));

        // Sanitization strips newlines and caps overly long summary/target
        let huge = "line1\nline2\t".repeat(40);
        let sanitized = record_activity(
            &dir,
            ExternalActivitySource::Mcp,
            "create_note",
            &huge,
            &huge,
            true,
        )
        .expect("record sanitized entry");
        assert!(!sanitized.summary.contains('\n'));
        assert!(sanitized.summary.chars().count() <= MAX_ACTIVITY_SUMMARY_CHARS);
        assert!(sanitized.target.chars().count() <= MAX_ACTIVITY_TARGET_CHARS);
        assert_eq!(
            list_activity(&dir).expect("still capped at 50").len(),
            MAX_EXTERNAL_ACTIVITY_ENTRIES
        );

        clear_activity(&dir).expect("clear activity");
        assert!(list_activity(&dir).expect("empty after clear").is_empty());

        // Corrupt activity file recovers cleanly
        fs::write(dir.join(ACTIVITY_FILE), "{bad json").expect("write corrupt activity");
        assert!(list_activity(&dir)
            .expect("corrupt recovers empty")
            .is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn touch_external_rev_is_strictly_monotonic() {
        let dir = temp_data_dir();
        assert_eq!(read_external_rev(&dir).expect("initial none"), None);

        let mut seen = Vec::new();
        for expected in 1..=5u64 {
            touch_external_rev(&dir).expect("bump external rev");
            let rev = read_external_rev(&dir)
                .expect("read external rev")
                .expect("rev exists");
            assert_eq!(rev, expected.to_string());
            seen.push(rev);
        }

        assert_eq!(seen, vec!["1", "2", "3", "4", "5"]);
        let _ = fs::remove_dir_all(dir);
    }
}
