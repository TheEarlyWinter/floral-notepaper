use crate::{
    desktop,
    json_io::write_json_atomic,
    services::notes::{default_store, AppError},
};
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

const COMMANDS_FILE: &str = "external-commands.json";
const COMMANDS_LOCK_FILE: &str = "external-commands.json.lock";
const REV_FILE: &str = ".external-rev";
const REV_LOCK_FILE: &str = ".external-rev.lock";
const POLL_INTERVAL: Duration = Duration::from_secs(1);

static COMMANDS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static REV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum ExternalCommand {
    PinTile {
        #[serde(rename = "noteId", alias = "note_id")]
        note_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExternalCommandQueue {
    #[serde(default)]
    commands: Vec<ExternalCommand>,
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

fn rev_path(data_dir: &Path) -> PathBuf {
    data_dir.join(REV_FILE)
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
    Ok(queue.commands)
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
            ExternalCommand::PinTile { note_id } => {
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
    use uuid::Uuid;

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

        enqueue_command(
            &dir,
            ExternalCommand::PinTile {
                note_id: "note-1".into(),
            },
        )
        .expect("enqueue first");
        enqueue_command(
            &dir,
            ExternalCommand::PinTile {
                note_id: "note-2".into(),
            },
        )
        .expect("enqueue second");

        let drained = drain_commands(&dir).expect("drain queued commands");
        assert_eq!(
            drained,
            vec![
                ExternalCommand::PinTile {
                    note_id: "note-1".into()
                },
                ExternalCommand::PinTile {
                    note_id: "note-2".into()
                }
            ]
        );

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

        enqueue_command(
            &dir,
            ExternalCommand::PinTile {
                note_id: "note-ok".into(),
            },
        )
        .expect("enqueue after corrupt");
        let drained = drain_commands(&dir).expect("drain after recover");
        assert_eq!(
            drained,
            vec![ExternalCommand::PinTile {
                note_id: "note-ok".into()
            }]
        );
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
