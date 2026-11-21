pub mod git_sync;
pub mod secrets;
#[cfg(test)]
mod tests;
pub mod webdav;

use crate::{
    json_io::write_json_atomic,
    services::{
        notes::{
            default_store, validate_metadata, AppConfig, AppError, MetadataFile, NoteMetadata,
            NoteStore,
        },
        reminders::{Reminder, ReminderFile},
    },
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use webdav::WebDavTransport;

use secrets::{SecretStore, SyncSecretKind};

const STATUS_FILE_NAME: &str = ".sync-status.json";
const RUN_LOCK_FILE_NAME: &str = ".sync-run.lock";
const AUTO_SYNC_INITIAL_DELAY: Duration = Duration::from_secs(10);
const AUTO_SYNC_TICK_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SyncProvider {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "webdav")]
    WebDav,
    #[serde(rename = "git")]
    Git,
}

impl SyncProvider {
    pub fn from_config(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "webdav" => Self::WebDav,
            "git" => Self::Git,
            _ => Self::None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::WebDav => "webdav",
            Self::Git => "git",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SyncRunState {
    #[default]
    Idle,
    Syncing,
    Success,
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictItem {
    pub path: String,
    pub conflict_copy_path: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub provider: SyncProvider,
    pub state: SyncRunState,
    pub running: bool,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_message: Option<String>,
    pub last_error: Option<String>,
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    #[serde(default)]
    pub conflicts: Vec<SyncConflictItem>,
    pub has_webdav_password: bool,
    pub has_git_token: bool,
    pub keyring_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTestResult {
    pub ok: bool,
    pub provider: SyncProvider,
    pub message: String,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct SyncExecutionSummary {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    pub conflicts: Vec<SyncConflictItem>,
    pub remote_changes_applied: bool,
    pub reminders_changed: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedSyncStatus {
    pub state: SyncRunState,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_message: Option<String>,
    pub last_error: Option<String>,
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    #[serde(default)]
    pub conflicts: Vec<SyncConflictItem>,
}

#[derive(Debug, Clone)]
pub struct SyncState {
    in_flight: Arc<AtomicBool>,
    last_auto_attempt: Arc<Mutex<Option<DateTime<Utc>>>>,
    secrets: SecretStore,
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            in_flight: Arc::new(AtomicBool::new(false)),
            last_auto_attempt: Arc::new(Mutex::new(None)),
            secrets: SecretStore::default(),
        }
    }
}

struct InFlightGuard {
    flag: Arc<AtomicBool>,
    _lock_file: File,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

impl SyncState {
    #[cfg(test)]
    pub(crate) fn with_secrets(secrets: SecretStore) -> Self {
        Self {
            in_flight: Arc::new(AtomicBool::new(false)),
            last_auto_attempt: Arc::new(Mutex::new(None)),
            secrets,
        }
    }

    pub fn secrets(&self) -> &SecretStore {
        &self.secrets
    }

    fn try_begin_sync(&self, data_dir: &Path) -> Result<Option<InFlightGuard>, AppError> {
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(None);
        }

        let lock_res = (|| -> Result<File, AppError> {
            fs::create_dir_all(data_dir)?;
            let lock_path = data_dir.join(RUN_LOCK_FILE_NAME);
            let file = OpenOptions::new()
                .create(true)
                .write(true)
                .open(&lock_path)?;
            if file.try_lock_exclusive().is_err() {
                return Err(AppError {
                    code: "syncAlreadyRunning".into(),
                    message: "同步任务正在进行中，请稍后重试".into(),
                    details: Default::default(),
                });
            }
            Ok(file)
        })();

        match lock_res {
            Ok(file) => Ok(Some(InFlightGuard {
                flag: Arc::clone(&self.in_flight),
                _lock_file: file,
            })),
            Err(err) if err.code == "syncAlreadyRunning" => {
                self.in_flight.store(false, Ordering::SeqCst);
                Ok(None)
            }
            Err(err) => {
                self.in_flight.store(false, Ordering::SeqCst);
                Err(err)
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst)
    }

    fn record_auto_attempt(&self, now: DateTime<Utc>) {
        if let Ok(mut guard) = self.last_auto_attempt.lock() {
            *guard = Some(now);
        }
    }

    fn last_auto_attempt(&self) -> Option<DateTime<Utc>> {
        self.last_auto_attempt.lock().ok().and_then(|g| *g)
    }
}

pub(crate) fn app_error(code: impl Into<String>, message: impl Into<String>) -> AppError {
    AppError {
        code: code.into(),
        message: message.into(),
        details: Default::default(),
    }
}

/// 统一规范化相对路径为 `/` 分隔，并阻止路径遍历或驱动器前缀。
pub(crate) fn normalize_rel_path(raw: &str) -> Option<String> {
    let replaced = raw.trim().replace('\\', "/");
    let trimmed = replaced.trim_start_matches("./").trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') || trimmed.contains(':') {
        return None;
    }

    let mut parts = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        parts.push(seg);
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn is_excluded_file_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    file_name.starts_with('.')
        || file_name.starts_with("~$")
        || file_name.starts_with(".#")
        || file_name.ends_with('~')
        || lower == ".lock"
        || lower.ends_with(".lock")
        || lower.ends_with(".tmp")
        || lower.ends_with(".part")
        || lower.ends_with(".temp")
        || lower.ends_with(".swp")
        || lower.ends_with(".swo")
        || lower.ends_with(".bak")
        || lower == "thumbs.db"
        || lower == "desktop.ini"
}

/// 统一同步文件白名单与排除规则（WebDAV 与 Git 共用）：
/// - 同步：`notes/*.md`（含分类子目录）、`metadata.json`、`reminders.json`、`images/*`、`attachments/*`
/// - 排除：`floral.db*`、`external-*`、`.external-rev`、`.sync-*`、`.lock`、临时文件与备份/历史/派生缓存
pub fn is_syncable_relative_path(rel_path: &str) -> bool {
    let Some(normalized) = normalize_rel_path(rel_path) else {
        return false;
    };
    let segments: Vec<&str> = normalized.split('/').collect();

    for seg in &segments {
        let lower = seg.to_ascii_lowercase();
        if lower == ".git"
            || lower.starts_with(".sync-")
            || lower.starts_with(".external-rev")
            || lower.starts_with("external-")
            || lower.starts_with("floral.db")
        {
            return false;
        }
    }

    let first = segments[0];
    let last = *segments.last().unwrap_or(&"");
    if is_excluded_file_name(last) {
        return false;
    }

    if segments.len() == 1 {
        return first == "metadata.json" || first == "reminders.json";
    }

    // 禁止包含任何点前缀子目录（如 .git / .obsidian / .sync-*）
    if segments[..segments.len() - 1]
        .iter()
        .any(|dir| dir.starts_with('.'))
    {
        return false;
    }

    match first {
        "notes" => last.to_ascii_lowercase().ends_with(".md"),
        "images" | "attachments" => true,
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileDigest {
    pub blake3: String,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
}

pub(crate) fn blake3_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

pub(crate) fn digest_file(path: &Path) -> Result<SyncFileDigest, AppError> {
    let meta = fs::metadata(path)?;
    let modified_at = meta.modified().ok().map(DateTime::<Utc>::from);
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(SyncFileDigest {
        blake3: hasher.finalize().to_hex().to_string(),
        size: meta.len(),
        modified_at,
    })
}

pub(crate) fn collect_syncable_digests(
    data_dir: &Path,
) -> Result<BTreeMap<String, SyncFileDigest>, AppError> {
    let mut result = BTreeMap::new();
    if !data_dir.exists() {
        return Ok(result);
    }

    for root_file in ["metadata.json", "reminders.json"] {
        let full = data_dir.join(root_file);
        if full.is_file() {
            result.insert(root_file.to_string(), digest_file(&full)?);
        }
    }

    for dir_name in ["notes", "images", "attachments"] {
        let dir = data_dir.join(dir_name);
        if dir.is_dir() {
            collect_dir_digests(data_dir, &dir, &mut result)?;
        }
    }

    Ok(result)
}

fn collect_dir_digests(
    data_dir: &Path,
    dir: &Path,
    out: &mut BTreeMap<String, SyncFileDigest>,
) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(data_dir) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if file_type.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('.')
                || dir_name.starts_with("external-")
                || dir_name.starts_with(".sync-")
            {
                continue;
            }
            collect_dir_digests(data_dir, &path, out)?;
        } else if file_type.is_file() && is_syncable_relative_path(&rel_str) {
            out.insert(rel_str, digest_file(&path)?);
        }
    }
    Ok(())
}

/// 生成冲突副本相对路径：`.md` 文件固定输出 `*.conflict-<timestamp>.md`。
pub fn conflict_copy_relative_path(rel_path: &str, timestamp: &str) -> String {
    let normalized = normalize_rel_path(rel_path).unwrap_or_else(|| rel_path.replace('\\', "/"));
    let (dir_prefix, file_name) = match normalized.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name),
        None => (String::new(), normalized.as_str()),
    };

    if file_name.to_ascii_lowercase().ends_with(".md") && file_name.len() > 3 {
        let stem = &file_name[..file_name.len() - 3];
        return format!("{dir_prefix}{stem}.conflict-{timestamp}.md");
    }

    match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            format!("{dir_prefix}{stem}.conflict-{timestamp}.{ext}")
        }
        _ => format!("{dir_prefix}{file_name}.conflict-{timestamp}"),
    }
}

pub(crate) fn allocate_conflict_copy_path(
    data_dir: &Path,
    rel_path: &str,
    timestamp: &str,
) -> String {
    let base = conflict_copy_relative_path(rel_path, timestamp);
    if !data_dir.join(&base).exists() {
        return base;
    }
    for index in 2..=100 {
        let suffix = format!("{timestamp}-{index}");
        let candidate = conflict_copy_relative_path(rel_path, &suffix);
        if !data_dir.join(&candidate).exists() {
            return candidate;
        }
    }
    conflict_copy_relative_path(
        rel_path,
        &format!("{timestamp}-{}", &uuid::Uuid::new_v4().to_string()[..8]),
    )
}

pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sync-file");
    let temp_path = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let mut temp_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp_path)?;
    temp_file.write_all(bytes)?;
    temp_file.sync_all()?;
    drop(temp_file);
    fs::rename(&temp_path, path)?;
    Ok(())
}

fn note_file_exists(data_dir: &Path, note: &NoteMetadata) -> bool {
    let path = if note.category.is_empty() {
        data_dir.join("notes").join(&note.file_name)
    } else {
        data_dir
            .join("notes")
            .join(&note.category)
            .join(&note.file_name)
    };
    path.is_file()
}

fn note_rel_path(note: &NoteMetadata) -> String {
    if note.category.is_empty() {
        format!("notes/{}", note.file_name)
    } else {
        format!("notes/{}/{}", note.category, note.file_name)
    }
}

/// 当 `metadata.json` 发生双端冲突时：远端副本已另存为 `metadata.conflict-<ts>.json`，
/// 此处按笔记 ID 合并双方条目（仅保留磁盘上实际存在 `.md` 文件的笔记），避免远端新增笔记失踪。
pub(crate) fn merge_metadata_bytes(
    data_dir: &Path,
    local_bytes: &[u8],
    remote_bytes: &[u8],
    conflicted_paths: &HashSet<String>,
) -> Option<Vec<u8>> {
    let local: MetadataFile = serde_json::from_slice(local_bytes).ok()?;
    let remote: MetadataFile = serde_json::from_slice(remote_bytes).ok()?;
    validate_metadata(&local).ok()?;
    validate_metadata(&remote).ok()?;

    let mut local_map: HashMap<String, NoteMetadata> = HashMap::new();
    let mut order = Vec::new();
    for note in local.notes {
        order.push(note.id.clone());
        local_map.insert(note.id.clone(), note);
    }

    let mut remote_map: HashMap<String, NoteMetadata> = HashMap::new();
    for note in remote.notes {
        if !local_map.contains_key(&note.id) {
            order.push(note.id.clone());
        }
        remote_map.insert(note.id.clone(), note);
    }

    let mut merged = Vec::new();
    for id in order {
        let chosen = match (local_map.remove(&id), remote_map.remove(&id)) {
            (Some(l), Some(r)) => {
                let l_rel = note_rel_path(&l);
                let l_exists = note_file_exists(data_dir, &l);
                let r_exists = note_file_exists(data_dir, &r);
                let l_conflicted = conflicted_paths.contains(&l_rel);
                if l_conflicted && l_exists {
                    Some(l)
                } else if r_exists && (!l_exists || r.updated_at > l.updated_at) {
                    Some(r)
                } else if l_exists {
                    Some(l)
                } else if r_exists {
                    Some(r)
                } else {
                    None
                }
            }
            (Some(l), None) => note_file_exists(data_dir, &l).then_some(l),
            (None, Some(r)) => note_file_exists(data_dir, &r).then_some(r),
            (None, None) => None,
        };
        if let Some(item) = chosen {
            merged.push(item);
        }
    }

    let mut out = serde_json::to_vec_pretty(&MetadataFile { notes: merged }).ok()?;
    out.push(b'\n');
    Some(out)
}

/// 当 `reminders.json` 发生双端冲突时：按提醒 ID 合并并保留 `notified = local || remote`。
pub(crate) fn merge_reminders_bytes(local_bytes: &[u8], remote_bytes: &[u8]) -> Option<Vec<u8>> {
    let local: ReminderFile = serde_json::from_slice(local_bytes).ok()?;
    let remote: ReminderFile = serde_json::from_slice(remote_bytes).ok()?;

    let mut map: HashMap<String, Reminder> = HashMap::new();
    let mut order = Vec::new();

    for item in local.reminders {
        order.push(item.id.clone());
        map.insert(item.id.clone(), item);
    }
    for item in remote.reminders {
        if let Some(existing) = map.get_mut(&item.id) {
            existing.notified = existing.notified || item.notified;
            if item.remind_at > existing.remind_at {
                existing.remind_at = item.remind_at;
                existing.message = item.message;
                existing.note_id = item.note_id;
            }
        } else {
            order.push(item.id.clone());
            map.insert(item.id.clone(), item);
        }
    }

    let reminders: Vec<Reminder> = order.into_iter().filter_map(|id| map.remove(&id)).collect();
    let mut out = serde_json::to_vec_pretty(&ReminderFile { reminders }).ok()?;
    out.push(b'\n');
    Some(out)
}

fn status_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STATUS_FILE_NAME)
}

fn load_persisted_status(data_dir: &Path) -> PersistedSyncStatus {
    let path = status_path(data_dir);
    if !path.is_file() {
        return PersistedSyncStatus::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_persisted_status(data_dir: &Path, status: &PersistedSyncStatus) -> Result<(), AppError> {
    write_json_atomic(&status_path(data_dir), status)
}

fn build_status_dto(config: &AppConfig, data_dir: &Path, state: &SyncState) -> SyncStatusDto {
    let persisted = load_persisted_status(data_dir);
    let mut keyring_available = true;
    let has_webdav_password = match state.secrets.has_secret(SyncSecretKind::WebDavPassword) {
        Ok(val) => val,
        Err(_) => {
            keyring_available = false;
            false
        }
    };
    let has_git_token = match state.secrets.has_secret(SyncSecretKind::GitToken) {
        Ok(val) => val,
        Err(_) => {
            keyring_available = false;
            false
        }
    };

    SyncStatusDto {
        provider: SyncProvider::from_config(&config.sync_provider),
        state: persisted.state,
        running: state.is_running(),
        last_sync_at: persisted.last_sync_at,
        last_success_at: persisted.last_success_at,
        last_message: persisted.last_message,
        last_error: persisted.last_error,
        uploaded: persisted.uploaded,
        downloaded: persisted.downloaded,
        deleted_local: persisted.deleted_local,
        deleted_remote: persisted.deleted_remote,
        conflicts: persisted.conflicts,
        has_webdav_password,
        has_git_token,
        keyring_available,
    }
}

pub fn get_status(state: &SyncState) -> Result<SyncStatusDto, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    Ok(build_status_dto(&config, store.data_dir(), state))
}

pub fn test_connection(state: &SyncState) -> Result<SyncTestResult, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    let provider = SyncProvider::from_config(&config.sync_provider);
    let started = std::time::Instant::now();

    match provider {
        SyncProvider::None => Err(app_error("syncDisabled", "未启用同步，请先选择同步方式")),
        SyncProvider::WebDav => {
            let password = if config.sync_webdav_username.trim().is_empty() {
                state
                    .secrets
                    .get_secret(SyncSecretKind::WebDavPassword)
                    .ok()
                    .flatten()
            } else {
                state.secrets.get_secret(SyncSecretKind::WebDavPassword)?
            };
            let transport = webdav::HttpWebDavTransport::new()?;
            let wd_cfg = webdav::WebDavConfig::from_app_config(&config, password)?;
            transport.test_connection(&wd_cfg)?;
            Ok(SyncTestResult {
                ok: true,
                provider,
                message: "WebDAV 连接测试成功".into(),
                latency_ms: started.elapsed().as_millis() as u64,
            })
        }
        SyncProvider::Git => {
            let token = if config.sync_git_username.trim().is_empty() {
                state
                    .secrets
                    .get_secret(SyncSecretKind::GitToken)
                    .ok()
                    .flatten()
            } else {
                state.secrets.get_secret(SyncSecretKind::GitToken)?
            };
            let git_cfg = git_sync::GitSyncConfig::from_app_config(&config, token)?;
            git_sync::test_connection(&git_cfg)?;
            Ok(SyncTestResult {
                ok: true,
                provider,
                message: "Git 远程仓库连接测试成功".into(),
                latency_ms: started.elapsed().as_millis() as u64,
            })
        }
    }
}

pub(crate) fn run_sync_with_store(
    store: &NoteStore,
    config: &AppConfig,
    state: &SyncState,
    app: Option<&AppHandle>,
) -> Result<SyncStatusDto, AppError> {
    let provider = SyncProvider::from_config(&config.sync_provider);
    if provider == SyncProvider::None {
        return Err(app_error("syncDisabled", "未启用同步，请先选择同步方式"));
    }

    let data_dir = store.data_dir();
    let Some(_guard) = state.try_begin_sync(data_dir)? else {
        return Err(app_error(
            "syncAlreadyRunning",
            "同步任务正在进行中，请稍后重试",
        ));
    };

    let now = Utc::now();
    state.record_auto_attempt(now);

    let result: Result<SyncExecutionSummary, AppError> = match provider {
        SyncProvider::None => unreachable!(),
        SyncProvider::WebDav => (|| {
            let password = if config.sync_webdav_username.trim().is_empty() {
                state
                    .secrets
                    .get_secret(SyncSecretKind::WebDavPassword)
                    .ok()
                    .flatten()
            } else {
                state.secrets.get_secret(SyncSecretKind::WebDavPassword)?
            };
            let wd_cfg = webdav::WebDavConfig::from_app_config(config, password)?;
            let transport = webdav::HttpWebDavTransport::new()?;
            webdav::sync_with_transport(data_dir, &wd_cfg, &transport)
        })(),
        SyncProvider::Git => (|| {
            let token = if config.sync_git_username.trim().is_empty() {
                state
                    .secrets
                    .get_secret(SyncSecretKind::GitToken)
                    .ok()
                    .flatten()
            } else {
                state.secrets.get_secret(SyncSecretKind::GitToken)?
            };
            let git_cfg = git_sync::GitSyncConfig::from_app_config(config, token)?;
            git_sync::sync_repo(data_dir, &git_cfg)
        })(),
    };

    let prev = load_persisted_status(data_dir);
    let next_persisted = match &result {
        Ok(summary) => {
            if summary.remote_changes_applied {
                if let Err(err) = store.reload_indexes_after_sync() {
                    eprintln!("[花笺] 同步后重建 FTS5 索引失败: {err}");
                }
                if let Some(app_handle) = app {
                    let _ = app_handle.emit("notes-external-changed", ());
                    if summary.reminders_changed {
                        let _ = app_handle.emit("reminders-external-changed", ());
                    }
                }
            }
            let run_state = if summary.conflicts.is_empty() {
                SyncRunState::Success
            } else {
                SyncRunState::Conflict
            };
            PersistedSyncStatus {
                state: run_state,
                last_sync_at: Some(now),
                last_success_at: Some(now),
                last_message: Some(summary.message.clone()),
                last_error: None,
                uploaded: summary.uploaded,
                downloaded: summary.downloaded,
                deleted_local: summary.deleted_local,
                deleted_remote: summary.deleted_remote,
                conflicts: summary.conflicts.clone(),
            }
        }
        Err(error) => PersistedSyncStatus {
            state: SyncRunState::Error,
            last_sync_at: Some(now),
            last_success_at: prev.last_success_at,
            last_message: None,
            last_error: Some(error.message.clone()),
            uploaded: 0,
            downloaded: 0,
            deleted_local: 0,
            deleted_remote: 0,
            conflicts: prev.conflicts,
        },
    };

    if let Err(save_err) = save_persisted_status(data_dir, &next_persisted) {
        eprintln!("[花笺] 保存同步状态失败: {save_err}");
    }

    drop(_guard);
    let dto = build_status_dto(config, data_dir, state);
    if let Some(app_handle) = app {
        let _ = app_handle.emit("sync://status-changed", &dto);
    }

    match result {
        Ok(_) => Ok(dto),
        Err(error) => Err(error),
    }
}

pub fn run_now(app: &AppHandle, state: &SyncState) -> Result<SyncStatusDto, AppError> {
    let store = default_store()?;
    let config = store.load_config()?;
    run_sync_with_store(&store, &config, state, Some(app))
}

fn should_run_auto_sync(
    config: &AppConfig,
    last_sync: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if SyncProvider::from_config(&config.sync_provider) == SyncProvider::None {
        return false;
    }
    if config.sync_auto_interval_minutes == 0 {
        return false;
    }
    let Some(prev) = last_sync else {
        return true;
    };
    now.signed_duration_since(prev)
        >= ChronoDuration::minutes(i64::from(config.sync_auto_interval_minutes))
}

pub fn start_auto_sync_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTO_SYNC_INITIAL_DELAY).await;
        let mut ticker = tokio::time::interval(AUTO_SYNC_TICK_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let app_clone = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let Some(sync_state) = app_clone.try_state::<SyncState>() else {
                    return;
                };
                if sync_state.is_running() {
                    return;
                }
                let Ok(store) = default_store() else {
                    return;
                };
                let Ok(config) = store.load_config() else {
                    return;
                };
                let persisted_last = load_persisted_status(store.data_dir()).last_sync_at;
                let last_attempt = match (sync_state.last_auto_attempt(), persisted_last) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                };
                if !should_run_auto_sync(&config, last_attempt, Utc::now()) {
                    return;
                }
                if let Err(error) =
                    run_sync_with_store(&store, &config, sync_state.inner(), Some(&app_clone))
                {
                    if error.code != "syncAlreadyRunning" {
                        eprintln!("[花笺] 自动同步失败: {error}");
                    }
                }
            })
            .await;
        }
    });
}
