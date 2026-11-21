use super::{
    allocate_conflict_copy_path, app_error, blake3_bytes, collect_syncable_digests,
    is_syncable_relative_path, merge_metadata_bytes, merge_reminders_bytes, normalize_rel_path,
    write_bytes_atomic, SyncConflictItem, SyncExecutionSummary, SyncFileDigest,
};
use crate::{
    json_io::write_json_atomic,
    services::notes::{AppConfig, AppError},
};
use chrono::{DateTime, Utc};
use reqwest::{
    blocking::{Client, RequestBuilder},
    Method, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::Path,
    sync::Mutex,
    time::Duration,
};

const REMOTE_MANIFEST_NAME: &str = ".sync-manifest.json";
const LOCAL_BASELINE_NAME: &str = ".sync-webdav-manifest.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct WebDavConfig {
    pub url: Url,
    pub raw_url: String,
    pub username: String,
    pub password: Option<String>,
    pub remote_dir: String,
}

impl WebDavConfig {
    pub fn from_app_config(config: &AppConfig, password: Option<String>) -> Result<Self, AppError> {
        let raw_url = config.sync_webdav_url.trim().to_string();
        if raw_url.is_empty() {
            return Err(app_error("syncConfigInvalid", "请填写 WebDAV 服务器地址"));
        }
        let url = Url::parse(&raw_url).map_err(|error| {
            app_error(
                "syncConfigInvalid",
                format!("WebDAV 服务器地址无效: {error}"),
            )
        })?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(app_error(
                "syncConfigInvalid",
                "WebDAV 服务器地址必须使用 http 或 https 协议",
            ));
        }

        let username = config.sync_webdav_username.trim().to_string();
        if !username.is_empty() && password.as_deref().is_none_or(|p| p.is_empty()) {
            return Err(app_error(
                "syncMissingCredentials",
                "已配置 WebDAV 用户名，但尚未保存密码",
            ));
        }

        let remote_dir = normalize_remote_dir(&config.sync_webdav_remote_dir)?;
        Ok(Self {
            url,
            raw_url,
            username,
            password,
            remote_dir,
        })
    }
}

pub(crate) fn normalize_remote_dir(raw: &str) -> Result<String, AppError> {
    let replaced = raw.trim().replace('\\', "/");
    let trimmed = replaced.trim_matches('/');
    if trimmed.is_empty() {
        return Ok("floral-notepaper".to_string());
    }
    let mut parts = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(':') || seg.contains('\0') {
            return Err(app_error(
                "syncConfigInvalid",
                "WebDAV 远端目录包含非法路径",
            ));
        }
        parts.push(seg);
    }
    Ok(parts.join("/"))
}

pub(crate) fn build_remote_url(
    base: &Url,
    remote_dir: &str,
    rel_path: Option<&str>,
    as_dir: bool,
) -> Result<Url, AppError> {
    let mut url = base.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| app_error("syncConfigInvalid", "WebDAV 服务器地址不支持路径拼接"))?;
        segments.pop_if_empty();
        for seg in remote_dir.split('/').filter(|s| !s.is_empty()) {
            segments.push(seg);
        }
        if let Some(rel) = rel_path {
            for seg in rel.split('/').filter(|s| !s.is_empty()) {
                segments.push(seg);
            }
        }
        if as_dir {
            segments.push("");
        }
    }
    Ok(url)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    pub version: u32,
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub files: BTreeMap<String, SyncFileDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBaselinePair {
    pub local_blake3: String,
    pub remote_blake3: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalBaselineManifest {
    pub version: u32,
    #[serde(default)]
    pub remote_url: String,
    #[serde(default)]
    pub remote_dir: String,
    #[serde(default)]
    pub files: BTreeMap<String, SyncFileDigest>,
    #[serde(default)]
    pub acknowledged_conflicts: BTreeMap<String, ConflictBaselinePair>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    Upload,
    Download,
    DeleteLocal,
    DeleteRemote,
    Conflict,
    NoOp,
}

pub trait WebDavTransport {
    fn test_connection(&self, cfg: &WebDavConfig) -> Result<(), AppError>;
    fn ensure_dir(&self, cfg: &WebDavConfig, rel_dir: &str) -> Result<(), AppError>;
    fn get_file(&self, cfg: &WebDavConfig, rel_path: &str) -> Result<Option<Vec<u8>>, AppError>;
    fn put_file(&self, cfg: &WebDavConfig, rel_path: &str, bytes: &[u8]) -> Result<(), AppError>;
    fn delete_file(&self, cfg: &WebDavConfig, rel_path: &str) -> Result<(), AppError>;
}

pub struct HttpWebDavTransport {
    client: Client,
    verified_dirs: Mutex<HashSet<String>>,
}

impl HttpWebDavTransport {
    pub fn new() -> Result<Self, AppError> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| {
                app_error(
                    "syncClientError",
                    format!("无法初始化 WebDAV 客户端: {error}"),
                )
            })?;
        Ok(Self {
            client,
            verified_dirs: Mutex::new(HashSet::new()),
        })
    }

    fn with_auth(&self, builder: RequestBuilder, cfg: &WebDavConfig) -> RequestBuilder {
        if !cfg.username.is_empty() || cfg.password.is_some() {
            builder.basic_auth(&cfg.username, cfg.password.as_deref())
        } else {
            builder
        }
    }

    fn propfind_method() -> Result<Method, AppError> {
        Method::from_bytes(b"PROPFIND")
            .map_err(|error| app_error("syncClientError", format!("无效 HTTP 方法: {error}")))
    }

    fn mkcol_method() -> Result<Method, AppError> {
        Method::from_bytes(b"MKCOL")
            .map_err(|error| app_error("syncClientError", format!("无效 HTTP 方法: {error}")))
    }

    fn map_http_status(status: StatusCode, context: &str) -> AppError {
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return app_error(
                "syncAuthFailed",
                "WebDAV 认证失败，请检查用户名和密码是否正确",
            );
        }
        app_error(
            "syncRemoteError",
            format!("{context}失败（HTTP {}）", status.as_u16()),
        )
    }

    fn ensure_single_dir(&self, cfg: &WebDavConfig, rel_dir: &str) -> Result<(), AppError> {
        let cache_key = format!("{}|{}|{rel_dir}", cfg.raw_url, cfg.remote_dir);
        if let Ok(guard) = self.verified_dirs.lock() {
            if guard.contains(&cache_key) {
                return Ok(());
            }
        }

        let dir_url = if rel_dir.is_empty() {
            build_remote_url(&cfg.url, &cfg.remote_dir, None, true)?
        } else {
            build_remote_url(&cfg.url, &cfg.remote_dir, Some(rel_dir), true)?
        };

        let propfind = self.propfind_method_request(cfg, dir_url.clone())?;
        let resp = propfind
            .send()
            .map_err(|error| app_error("syncNetworkError", format!("WebDAV 请求失败: {error}")))?;
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(Self::map_http_status(status, "WebDAV 目录检查"));
        }
        if status.is_success() || status == StatusCode::MULTI_STATUS {
            if let Ok(mut guard) = self.verified_dirs.lock() {
                guard.insert(cache_key);
            }
            return Ok(());
        }

        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            let mkcol_req =
                self.with_auth(self.client.request(Self::mkcol_method()?, dir_url), cfg);
            let mkcol_resp = mkcol_req.send().map_err(|error| {
                app_error("syncNetworkError", format!("创建 WebDAV 目录失败: {error}"))
            })?;
            let mkcol_status = mkcol_resp.status();
            if mkcol_status.is_success() || mkcol_status == StatusCode::METHOD_NOT_ALLOWED {
                if let Ok(mut guard) = self.verified_dirs.lock() {
                    guard.insert(cache_key);
                }
                return Ok(());
            }
            return Err(Self::map_http_status(mkcol_status, "创建 WebDAV 目录"));
        }

        Err(Self::map_http_status(status, "WebDAV 目录检查"))
    }

    fn propfind_method_request(
        &self,
        cfg: &WebDavConfig,
        url: Url,
    ) -> Result<RequestBuilder, AppError> {
        let req = self
            .client
            .request(Self::propfind_method()?, url)
            .header("Depth", "0")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(
                r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#,
            );
        Ok(self.with_auth(req, cfg))
    }
}

impl WebDavTransport for HttpWebDavTransport {
    fn test_connection(&self, cfg: &WebDavConfig) -> Result<(), AppError> {
        let base_resp = self
            .propfind_method_request(cfg, cfg.url.clone())?
            .send()
            .map_err(|error| app_error("syncNetworkError", format!("WebDAV 连接失败: {error}")))?;
        let base_status = base_resp.status();

        if base_status == StatusCode::UNAUTHORIZED || base_status == StatusCode::FORBIDDEN {
            return Err(Self::map_http_status(base_status, "WebDAV 连接测试"));
        }

        if base_status == StatusCode::METHOD_NOT_ALLOWED
            || base_status == StatusCode::NOT_IMPLEMENTED
        {
            let opt_resp = self
                .with_auth(self.client.request(Method::OPTIONS, cfg.url.clone()), cfg)
                .send()
                .map_err(|error| {
                    app_error(
                        "syncNetworkError",
                        format!("WebDAV OPTIONS 请求失败: {error}"),
                    )
                })?;
            if !opt_resp.status().is_success() {
                return Err(Self::map_http_status(opt_resp.status(), "WebDAV 连接测试"));
            }
        } else if !base_status.is_success() && base_status != StatusCode::MULTI_STATUS {
            return Err(Self::map_http_status(base_status, "WebDAV 连接测试"));
        }

        // 同时探查目标同步子目录权限（允许 404，表示首次同步时再创建）
        let remote_dir_url = build_remote_url(&cfg.url, &cfg.remote_dir, None, true)?;
        let dir_resp = self
            .propfind_method_request(cfg, remote_dir_url)?
            .send()
            .map_err(|error| {
                app_error(
                    "syncNetworkError",
                    format!("WebDAV 远端目录探测失败: {error}"),
                )
            })?;
        let dir_status = dir_resp.status();
        if dir_status == StatusCode::UNAUTHORIZED || dir_status == StatusCode::FORBIDDEN {
            return Err(Self::map_http_status(dir_status, "WebDAV 远端目录探测"));
        }
        if !dir_status.is_success()
            && dir_status != StatusCode::MULTI_STATUS
            && dir_status != StatusCode::NOT_FOUND
            && dir_status != StatusCode::METHOD_NOT_ALLOWED
        {
            return Err(Self::map_http_status(dir_status, "WebDAV 远端目录探测"));
        }

        Ok(())
    }

    fn ensure_dir(&self, cfg: &WebDavConfig, rel_dir: &str) -> Result<(), AppError> {
        self.ensure_single_dir(cfg, "")?;
        let clean = rel_dir.trim_matches('/');
        if clean.is_empty() {
            return Ok(());
        }
        let mut prefix = String::new();
        for seg in clean.split('/').filter(|s| !s.is_empty()) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(seg);
            self.ensure_single_dir(cfg, &prefix)?;
        }
        Ok(())
    }

    fn get_file(&self, cfg: &WebDavConfig, rel_path: &str) -> Result<Option<Vec<u8>>, AppError> {
        let url = build_remote_url(&cfg.url, &cfg.remote_dir, Some(rel_path), false)?;
        let resp = self
            .with_auth(self.client.get(url), cfg)
            .send()
            .map_err(|error| {
                app_error(
                    "syncNetworkError",
                    format!("下载远端文件 {rel_path} 失败: {error}"),
                )
            })?;
        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Self::map_http_status(
                status,
                &format!("下载远端文件 {rel_path}"),
            ));
        }
        let bytes = resp.bytes().map_err(|error| {
            app_error(
                "syncNetworkError",
                format!("读取远端文件 {rel_path} 失败: {error}"),
            )
        })?;
        Ok(Some(bytes.to_vec()))
    }

    fn put_file(&self, cfg: &WebDavConfig, rel_path: &str, bytes: &[u8]) -> Result<(), AppError> {
        if let Some((parent, _)) = rel_path.rsplit_once('/') {
            self.ensure_dir(cfg, parent)?;
        } else {
            self.ensure_dir(cfg, "")?;
        }
        let url = build_remote_url(&cfg.url, &cfg.remote_dir, Some(rel_path), false)?;
        let resp = self
            .with_auth(self.client.put(url), cfg)
            .header("Content-Type", "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .map_err(|error| {
                app_error(
                    "syncNetworkError",
                    format!("上传文件 {rel_path} 失败: {error}"),
                )
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_http_status(
                status,
                &format!("上传文件 {rel_path}"),
            ));
        }
        Ok(())
    }

    fn delete_file(&self, cfg: &WebDavConfig, rel_path: &str) -> Result<(), AppError> {
        let url = build_remote_url(&cfg.url, &cfg.remote_dir, Some(rel_path), false)?;
        let resp = self
            .with_auth(self.client.delete(url), cfg)
            .send()
            .map_err(|error| {
                app_error(
                    "syncNetworkError",
                    format!("删除远端文件 {rel_path} 失败: {error}"),
                )
            })?;
        let status = resp.status();
        if status.is_success() || status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(Self::map_http_status(
            status,
            &format!("删除远端文件 {rel_path}"),
        ))
    }
}

/// 纯三路差异规划（可在单元测试中不依赖网络直接覆盖全部 8+ 状态组合）。
pub fn plan_three_way_sync(
    local: &BTreeMap<String, SyncFileDigest>,
    baseline: &BTreeMap<String, SyncFileDigest>,
    remote: &BTreeMap<String, SyncFileDigest>,
    acknowledged_conflicts: &BTreeMap<String, ConflictBaselinePair>,
) -> BTreeMap<String, SyncAction> {
    let mut all_paths = BTreeSet::new();
    all_paths.extend(local.keys().cloned());
    all_paths.extend(baseline.keys().cloned());
    all_paths.extend(remote.keys().cloned());

    let mut plan = BTreeMap::new();
    for path in all_paths {
        let l = local.get(&path).map(|d| d.blake3.as_str());
        let b = baseline.get(&path).map(|d| d.blake3.as_str());
        let r = remote.get(&path).map(|d| d.blake3.as_str());

        let action = match (l, r) {
            (None, None) => SyncAction::NoOp,
            (Some(lh), Some(rh)) if lh == rh => SyncAction::NoOp,
            (Some(lh), Some(rh)) => {
                if let Some(ack) = acknowledged_conflicts.get(&path) {
                    if ack.local_blake3 == lh && ack.remote_blake3 == rh {
                        SyncAction::NoOp
                    } else if ack.remote_blake3 == rh && ack.local_blake3 != lh {
                        SyncAction::Upload
                    } else {
                        SyncAction::Conflict
                    }
                } else if b == Some(lh) {
                    SyncAction::Download
                } else if b == Some(rh) {
                    SyncAction::Upload
                } else {
                    SyncAction::Conflict
                }
            }
            (Some(lh), None) => {
                if b == Some(lh) {
                    SyncAction::DeleteLocal
                } else {
                    SyncAction::Upload
                }
            }
            (None, Some(rh)) => {
                if b == Some(rh) {
                    SyncAction::DeleteRemote
                } else {
                    SyncAction::Download
                }
            }
        };
        plan.insert(path, action);
    }

    plan
}

fn load_local_baseline(data_dir: &Path, cfg: &WebDavConfig) -> LocalBaselineManifest {
    let path = data_dir.join(LOCAL_BASELINE_NAME);
    if !path.is_file() {
        return LocalBaselineManifest {
            version: 1,
            remote_url: cfg.raw_url.clone(),
            remote_dir: cfg.remote_dir.clone(),
            ..Default::default()
        };
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return LocalBaselineManifest {
            version: 1,
            remote_url: cfg.raw_url.clone(),
            remote_dir: cfg.remote_dir.clone(),
            ..Default::default()
        };
    };
    let parsed: LocalBaselineManifest = serde_json::from_str(&raw).unwrap_or_default();
    if parsed.remote_url != cfg.raw_url || parsed.remote_dir != cfg.remote_dir {
        return LocalBaselineManifest {
            version: 1,
            remote_url: cfg.raw_url.clone(),
            remote_dir: cfg.remote_dir.clone(),
            ..Default::default()
        };
    }
    parsed
}

fn load_remote_manifest<T: WebDavTransport>(
    transport: &T,
    cfg: &WebDavConfig,
) -> Result<(SyncManifest, bool), AppError> {
    match transport.get_file(cfg, REMOTE_MANIFEST_NAME)? {
        None => Ok((
            SyncManifest {
                version: 1,
                updated_at: None,
                files: BTreeMap::new(),
            },
            false,
        )),
        Some(bytes) => {
            let mut manifest: SyncManifest = serde_json::from_slice(&bytes).map_err(|error| {
                app_error(
                    "syncManifestInvalid",
                    format!("远端同步清单 {REMOTE_MANIFEST_NAME} 解析失败: {error}"),
                )
            })?;
            // 防御性过滤远端清单中的非法路径或被排除的派生文件
            manifest.files.retain(|path, _| {
                normalize_rel_path(path)
                    .is_some_and(|norm| norm == *path && is_syncable_relative_path(&norm))
            });
            Ok((manifest, true))
        }
    }
}

fn apply_digest_from_bytes(bytes: &[u8]) -> SyncFileDigest {
    SyncFileDigest {
        blake3: blake3_bytes(bytes),
        size: bytes.len() as u64,
        modified_at: Some(Utc::now()),
    }
}

pub fn sync_with_transport<T: WebDavTransport>(
    data_dir: &Path,
    cfg: &WebDavConfig,
    transport: &T,
) -> Result<SyncExecutionSummary, AppError> {
    fs::create_dir_all(data_dir)?;
    transport.ensure_dir(cfg, "")?;

    let local_files = collect_syncable_digests(data_dir)?;
    let baseline = load_local_baseline(data_dir, cfg);
    let (remote_manifest, remote_manifest_existed) = load_remote_manifest(transport, cfg)?;

    let plan = plan_three_way_sync(
        &local_files,
        &baseline.files,
        &remote_manifest.files,
        &baseline.acknowledged_conflicts,
    );

    let mut next_baseline = baseline.files.clone();
    let mut next_remote = remote_manifest.files.clone();
    let mut next_ack = baseline.acknowledged_conflicts.clone();
    let mut summary = SyncExecutionSummary::default();
    let mut conflicted_paths = HashSet::new();
    let mut remote_manifest_dirty = !remote_manifest_existed;
    let ts = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();

    // 1) 优先处理除 metadata.json / reminders.json 之外的所有文件，确保笔记 .md 全部落盘后再合并元数据
    let mut deferred_json = Vec::new();
    for (rel_path, action) in &plan {
        if rel_path == "metadata.json" || rel_path == "reminders.json" {
            deferred_json.push((rel_path.clone(), *action));
            continue;
        }
        apply_single_file_action(
            data_dir,
            cfg,
            transport,
            rel_path,
            *action,
            &local_files,
            &remote_manifest.files,
            &ts,
            &mut next_baseline,
            &mut next_remote,
            &mut next_ack,
            &mut conflicted_paths,
            &mut remote_manifest_dirty,
            &mut summary,
        )?;
    }

    // 2) 再处理 reminders.json 与 metadata.json
    deferred_json.sort_by_key(|(p, _)| if p == "reminders.json" { 0 } else { 1 });
    for (rel_path, action) in deferred_json {
        if action == SyncAction::Conflict {
            let Some(remote_bytes) = transport.get_file(cfg, &rel_path)? else {
                continue;
            };
            let local_bytes = fs::read(data_dir.join(&rel_path))?;
            let backup_rel = allocate_conflict_copy_path(data_dir, &rel_path, &ts);
            write_bytes_atomic(&data_dir.join(&backup_rel), &remote_bytes)?;

            let merged = if rel_path == "metadata.json" {
                merge_metadata_bytes(data_dir, &local_bytes, &remote_bytes, &conflicted_paths)
            } else {
                merge_reminders_bytes(&local_bytes, &remote_bytes)
            };

            if let Some(merged_bytes) = merged {
                write_bytes_atomic(&data_dir.join(&rel_path), &merged_bytes)?;
                transport.put_file(cfg, &rel_path, &merged_bytes)?;
                let digest = apply_digest_from_bytes(&merged_bytes);
                next_baseline.insert(rel_path.clone(), digest.clone());
                next_remote.insert(rel_path.clone(), digest);
                next_ack.remove(&rel_path);
                remote_manifest_dirty = true;
                summary.uploaded += 1;
                summary.downloaded += 1;
                summary.remote_changes_applied = true;
                if rel_path == "reminders.json" {
                    summary.reminders_changed = true;
                }
            } else {
                // 解析失败时降级为纯非破坏性冲突保留：保留本地并将远端保存为冲突副本
                let local_entry = local_files.get(&rel_path).cloned();
                let remote_entry = remote_manifest.files.get(&rel_path).cloned();
                if let (Some(le), Some(re)) = (local_entry, remote_entry) {
                    next_baseline.insert(rel_path.clone(), re.clone());
                    next_ack.insert(
                        rel_path.clone(),
                        ConflictBaselinePair {
                            local_blake3: le.blake3,
                            remote_blake3: re.blake3,
                        },
                    );
                }
                summary.conflicts.push(SyncConflictItem {
                    path: rel_path.clone(),
                    conflict_copy_path: backup_rel,
                    timestamp: Utc::now(),
                });
                summary.remote_changes_applied = true;
            }
        } else {
            apply_single_file_action(
                data_dir,
                cfg,
                transport,
                &rel_path,
                action,
                &local_files,
                &remote_manifest.files,
                &ts,
                &mut next_baseline,
                &mut next_remote,
                &mut next_ack,
                &mut conflicted_paths,
                &mut remote_manifest_dirty,
                &mut summary,
            )?;
        }
    }

    if remote_manifest_dirty {
        let updated_remote = SyncManifest {
            version: 1,
            updated_at: Some(Utc::now()),
            files: next_remote.clone(),
        };
        let mut bytes = serde_json::to_vec_pretty(&updated_remote)?;
        bytes.push(b'\n');
        transport.put_file(cfg, REMOTE_MANIFEST_NAME, &bytes)?;
    }

    let updated_baseline = LocalBaselineManifest {
        version: 1,
        remote_url: cfg.raw_url.clone(),
        remote_dir: cfg.remote_dir.clone(),
        files: next_baseline,
        acknowledged_conflicts: next_ack,
    };
    write_json_atomic(&data_dir.join(LOCAL_BASELINE_NAME), &updated_baseline)?;

    summary.message = if summary.conflicts.is_empty() {
        format!(
            "WebDAV 同步完成（上传 {}，下载 {}，本地删除 {}，远端删除 {}）",
            summary.uploaded, summary.downloaded, summary.deleted_local, summary.deleted_remote
        )
    } else {
        format!(
            "WebDAV 同步完成，发现 {} 处冲突已保留本地并另存远端副本",
            summary.conflicts.len()
        )
    };

    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
fn apply_single_file_action<T: WebDavTransport>(
    data_dir: &Path,
    cfg: &WebDavConfig,
    transport: &T,
    rel_path: &str,
    action: SyncAction,
    local_files: &BTreeMap<String, SyncFileDigest>,
    remote_files: &BTreeMap<String, SyncFileDigest>,
    ts: &str,
    next_baseline: &mut BTreeMap<String, SyncFileDigest>,
    next_remote: &mut BTreeMap<String, SyncFileDigest>,
    next_ack: &mut BTreeMap<String, ConflictBaselinePair>,
    conflicted_paths: &mut HashSet<String>,
    remote_manifest_dirty: &mut bool,
    summary: &mut SyncExecutionSummary,
) -> Result<(), AppError> {
    match action {
        SyncAction::NoOp => {
            if let Some(entry) = local_files.get(rel_path) {
                if remote_files.get(rel_path).map(|r| &r.blake3) == Some(&entry.blake3) {
                    next_baseline.insert(rel_path.to_string(), entry.clone());
                    next_ack.remove(rel_path);
                }
            } else if !remote_files.contains_key(rel_path) {
                next_baseline.remove(rel_path);
                next_ack.remove(rel_path);
            }
        }
        SyncAction::Upload => {
            let local_path = data_dir.join(rel_path);
            let bytes = fs::read(&local_path)?;
            transport.put_file(cfg, rel_path, &bytes)?;
            let digest = local_files
                .get(rel_path)
                .cloned()
                .unwrap_or_else(|| apply_digest_from_bytes(&bytes));
            next_baseline.insert(rel_path.to_string(), digest.clone());
            next_remote.insert(rel_path.to_string(), digest);
            next_ack.remove(rel_path);
            *remote_manifest_dirty = true;
            summary.uploaded += 1;
        }
        SyncAction::Download => {
            let Some(bytes) = transport.get_file(cfg, rel_path)? else {
                return Ok(());
            };
            write_bytes_atomic(&data_dir.join(rel_path), &bytes)?;
            let digest = remote_files
                .get(rel_path)
                .cloned()
                .unwrap_or_else(|| apply_digest_from_bytes(&bytes));
            next_baseline.insert(rel_path.to_string(), digest);
            next_ack.remove(rel_path);
            summary.downloaded += 1;
            summary.remote_changes_applied = true;
            if rel_path == "reminders.json" {
                summary.reminders_changed = true;
            }
        }
        SyncAction::DeleteLocal => {
            let local_path = data_dir.join(rel_path);
            if local_path.is_file() {
                fs::remove_file(&local_path)?;
            }
            next_baseline.remove(rel_path);
            next_ack.remove(rel_path);
            summary.deleted_local += 1;
            summary.remote_changes_applied = true;
            if rel_path == "reminders.json" {
                summary.reminders_changed = true;
            }
        }
        SyncAction::DeleteRemote => {
            transport.delete_file(cfg, rel_path)?;
            next_baseline.remove(rel_path);
            next_remote.remove(rel_path);
            next_ack.remove(rel_path);
            *remote_manifest_dirty = true;
            summary.deleted_remote += 1;
        }
        SyncAction::Conflict => {
            let Some(remote_bytes) = transport.get_file(cfg, rel_path)? else {
                return Ok(());
            };
            let conflict_rel = allocate_conflict_copy_path(data_dir, rel_path, ts);
            write_bytes_atomic(&data_dir.join(&conflict_rel), &remote_bytes)?;
            conflicted_paths.insert(rel_path.to_string());

            if let (Some(le), Some(re)) = (local_files.get(rel_path), remote_files.get(rel_path)) {
                next_baseline.insert(rel_path.to_string(), re.clone());
                next_ack.insert(
                    rel_path.to_string(),
                    ConflictBaselinePair {
                        local_blake3: le.blake3.clone(),
                        remote_blake3: re.blake3.clone(),
                    },
                );
            }

            summary.conflicts.push(SyncConflictItem {
                path: rel_path.to_string(),
                conflict_copy_path: conflict_rel,
                timestamp: Utc::now(),
            });
            summary.remote_changes_applied = true;
        }
    }
    Ok(())
}
