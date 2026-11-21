use super::{
    allocate_conflict_copy_path, app_error, collect_syncable_digests, is_syncable_relative_path,
    merge_metadata_bytes, merge_reminders_bytes, normalize_rel_path, write_bytes_atomic,
    SyncConflictItem, SyncExecutionSummary,
};
use crate::services::notes::{AppConfig, AppError};
use chrono::Utc;
use reqwest::Url;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const GITIGNORE_REQUIRED_PATTERNS: &[&str] = &[
    "floral.db*",
    "external-*",
    ".external-rev",
    ".external-rev.*",
    ".sync-*",
    "backups/",
    "*.lock",
    ".lock",
    "*.tmp",
    "*.part",
    "*.temp",
    "*.swp",
    "*~",
    "~$*",
    ".DS_Store",
    "Thumbs.db",
    "search-index.json",
    "history/",
    "backgrounds/",
    "updates/",
];

#[derive(Debug, Clone)]
pub struct GitSyncConfig {
    pub remote_url: String,
    pub branch: String,
    pub username: String,
    pub token: Option<String>,
}

impl GitSyncConfig {
    pub fn from_app_config(config: &AppConfig, token: Option<String>) -> Result<Self, AppError> {
        let remote_url = config.sync_git_remote_url.trim().to_string();
        validate_git_remote_url(&remote_url)?;
        let branch = normalize_git_branch(&config.sync_git_branch)?;
        let username = config.sync_git_username.trim().to_string();
        Ok(Self {
            remote_url,
            branch,
            username,
            token: token
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty()),
        })
    }
}

pub(crate) fn validate_git_remote_url(raw: &str) -> Result<(), AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(app_error("syncConfigInvalid", "请填写 Git 远程仓库地址"));
    }
    if trimmed.contains('\n') || trimmed.contains('\r') || trimmed.contains('\0') {
        return Err(app_error(
            "syncConfigInvalid",
            "Git 远程仓库地址包含非法字符",
        ));
    }
    if let Ok(parsed) = Url::parse(trimmed) {
        if parsed.password().is_some() {
            return Err(app_error(
                "syncConfigInvalid",
                "Git 远程地址不能包含明文密码或令牌，请改用安全凭据输入框保存",
            ));
        }
    }
    Ok(())
}

fn normalize_git_branch(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok("main".to_string());
    }
    if trimmed.starts_with('-')
        || trimmed.contains("..")
        || trimmed.chars().any(char::is_whitespace)
        || trimmed.contains(['~', '^', ':', '\\', '\0'])
    {
        return Err(app_error("syncConfigInvalid", "Git 分支名称格式无效"));
    }
    Ok(trimmed.to_string())
}

/// RAII 临时 `GIT_ASKPASS` 凭据脚本守卫：
/// 仅通过环境变量向单次 `git` 子进程传递令牌，析构时立即删除临时脚本，绝不写入 `.git/config`。
pub(crate) struct AskPassGuard {
    path: PathBuf,
}

impl AskPassGuard {
    pub(crate) fn create() -> Result<Self, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        #[cfg(windows)]
        let file_name = format!("floral-git-askpass-{id}.cmd");
        #[cfg(not(windows))]
        let file_name = format!("floral-git-askpass-{id}.sh");

        let path = std::env::temp_dir().join(file_name);

        #[cfg(windows)]
        let script = "@echo off\r\nsetlocal EnableDelayedExpansion\r\nset \"PROMPT=%~1\"\r\nif /I not \"!PROMPT:username=!\"==\"!PROMPT!\" (\r\n  echo(!FLORAL_GIT_USERNAME!\r\n) else (\r\n  echo(!FLORAL_GIT_TOKEN!\r\n)\r\n";

        #[cfg(not(windows))]
        let script = "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%s\\n' \"$FLORAL_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$FLORAL_GIT_TOKEN\" ;;\nesac\n";

        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)?;
            file.write_all(script.as_bytes())?;
            file.sync_all()?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o700);
            fs::set_permissions(&path, perms)?;
        }

        Ok(Self { path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for AskPassGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn scrub_secret(text: &str, token: Option<&str>) -> String {
    match token {
        Some(secret) if !secret.is_empty() => text.replace(secret, "***"),
        _ => text.to_string(),
    }
}

fn build_git_command(cwd: &Path, auth: Option<(&str, &str, &Path)>) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .arg("-c")
        .arg("core.quotepath=false")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_EDITOR", "true");

    if let Some((username, token, askpass_path)) = auth {
        let effective_user = if username.trim().is_empty() {
            "x-access-token"
        } else {
            username.trim()
        };
        cmd.arg("-c")
            .arg("credential.helper=")
            .env("GIT_ASKPASS", askpass_path)
            .env("FLORAL_GIT_USERNAME", effective_user)
            .env("FLORAL_GIT_TOKEN", token);
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd
}

fn run_git_raw(
    cwd: &Path,
    args: &[&str],
    username: &str,
    token: Option<&str>,
) -> Result<Output, AppError> {
    let _guard = if let Some(tok) = token {
        Some((tok, AskPassGuard::create()?))
    } else {
        None
    };

    let auth = _guard
        .as_ref()
        .map(|(tok, guard)| (username, *tok, guard.path()));

    let mut cmd = build_git_command(cwd, auth);
    cmd.args(args);

    cmd.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            app_error(
                "syncGitNotFound",
                "未检测到系统 Git，请先安装 Git 并确保其在 PATH 中可用",
            )
        } else {
            app_error("syncGitFailed", format!("执行 git 命令失败: {error}"))
        }
    })
}

fn run_git_checked(
    cwd: &Path,
    args: &[&str],
    username: &str,
    token: Option<&str>,
    context: &str,
) -> Result<String, AppError> {
    let output = run_git_raw(cwd, args, username, token)?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = scrub_secret(&String::from_utf8_lossy(&output.stderr), token);
    let stdout = scrub_secret(&String::from_utf8_lossy(&output.stdout), token);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let lower = detail.to_ascii_lowercase();
    let code = if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("invalid username or password")
        || lower.contains("permission denied")
    {
        "syncAuthFailed"
    } else {
        "syncGitFailed"
    };
    Err(app_error(
        code,
        if detail.is_empty() {
            format!("{context}失败")
        } else {
            format!("{context}失败: {detail}")
        },
    ))
}

pub fn ensure_git_available() -> Result<(), AppError> {
    let mut cmd = Command::new("git");
    cmd.arg("--version").env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            app_error(
                "syncGitNotFound",
                "未检测到系统 Git，请先安装 Git 并确保其在 PATH 中可用",
            )
        } else {
            app_error("syncGitFailed", format!("无法检测 Git 版本: {error}"))
        }
    })?;

    if !output.status.success() {
        return Err(app_error("syncGitFailed", "系统 Git 检测异常"));
    }
    Ok(())
}

pub fn generate_gitignore_content(existing: Option<&str>) -> String {
    let mut lines: Vec<String> = existing
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();
    let existing_trimmed: HashSet<String> = lines.iter().map(|l| l.trim().to_string()).collect();

    let missing: Vec<&str> = GITIGNORE_REQUIRED_PATTERNS
        .iter()
        .copied()
        .filter(|pattern| !existing_trimmed.contains(*pattern))
        .collect();

    if !missing.is_empty() {
        if !lines.is_empty() && !lines.last().is_some_and(|l| l.is_empty()) {
            lines.push(String::new());
        }
        if !existing_trimmed.contains("# Floral Notepaper sync exclusions") {
            lines.push("# Floral Notepaper sync exclusions".to_string());
        }
        for pattern in missing {
            lines.push(pattern.to_string());
        }
    }

    let mut content = lines.join("\n");
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content
}

pub fn ensure_gitignore(data_dir: &Path) -> Result<(), AppError> {
    let path = data_dir.join(".gitignore");
    let existing = if path.is_file() {
        Some(fs::read_to_string(&path)?)
    } else {
        None
    };
    let next = generate_gitignore_content(existing.as_deref());
    if existing.as_deref() != Some(next.as_str()) {
        write_bytes_atomic(&path, next.as_bytes())?;
    }
    Ok(())
}

pub fn test_connection(cfg: &GitSyncConfig) -> Result<(), AppError> {
    ensure_git_available()?;
    let cwd = std::env::temp_dir();
    run_git_checked(
        &cwd,
        &["ls-remote", "--heads", &cfg.remote_url, &cfg.branch],
        &cfg.username,
        cfg.token.as_deref(),
        "Git 远程仓库连接测试",
    )?;
    Ok(())
}

fn ensure_repo_initialized(data_dir: &Path, cfg: &GitSyncConfig) -> Result<(), AppError> {
    fs::create_dir_all(data_dir)?;
    if !data_dir.join(".git").exists() {
        let init_with_branch =
            run_git_raw(data_dir, &["init", "-b", &cfg.branch], &cfg.username, None)?;
        if !init_with_branch.status.success() {
            run_git_checked(data_dir, &["init"], &cfg.username, None, "初始化 Git 仓库")?;
            let _ = run_git_raw(
                data_dir,
                &[
                    "symbolic-ref",
                    "HEAD",
                    &format!("refs/heads/{}", cfg.branch),
                ],
                &cfg.username,
                None,
            );
        }
    }

    // 若用户未设置全局或本地 Git 身份，配置仅限当前仓库的提交者标识（非凭据）
    let has_name = run_git_raw(data_dir, &["config", "--get", "user.name"], "", None)?
        .status
        .success();
    if !has_name {
        run_git_checked(
            data_dir,
            &["config", "--local", "user.name", "Floral Notepaper"],
            "",
            None,
            "设置本地 Git 用户名",
        )?;
    }
    let has_email = run_git_raw(data_dir, &["config", "--get", "user.email"], "", None)?
        .status
        .success();
    if !has_email {
        run_git_checked(
            data_dir,
            &[
                "config",
                "--local",
                "user.email",
                "sync@floral-notepaper.local",
            ],
            "",
            None,
            "设置本地 Git 邮箱",
        )?;
    }

    ensure_gitignore(data_dir)?;

    let existing_origin = run_git_raw(data_dir, &["remote", "get-url", "origin"], "", None)?;
    if existing_origin.status.success() {
        let current = String::from_utf8_lossy(&existing_origin.stdout)
            .trim()
            .to_string();
        if current != cfg.remote_url {
            run_git_checked(
                data_dir,
                &["remote", "set-url", "origin", &cfg.remote_url],
                "",
                None,
                "更新 Git 远程地址",
            )?;
        }
    } else {
        run_git_checked(
            data_dir,
            &["remote", "add", "origin", &cfg.remote_url],
            "",
            None,
            "添加 Git 远程仓库",
        )?;
    }

    Ok(())
}

fn rev_parse(data_dir: &Path, rev: &str) -> Result<Option<String>, AppError> {
    let out = run_git_raw(data_dir, &["rev-parse", "--verify", rev], "", None)?;
    if out.status.success() {
        let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok((!sha.is_empty()).then_some(sha))
    } else {
        Ok(None)
    }
}

fn split_nul_paths(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|&b| b == 0)
        .filter(|slice| !slice.is_empty())
        .map(|slice| String::from_utf8_lossy(slice).to_string())
        .collect()
}

fn run_git_paths_batched(
    data_dir: &Path,
    prefix_args: &[&str],
    paths: &[String],
    context: &str,
) -> Result<(), AppError> {
    if paths.is_empty() {
        return Ok(());
    }
    for chunk in paths.chunks(150) {
        let mut args: Vec<&str> = prefix_args.to_vec();
        args.push("--");
        for path in chunk {
            args.push(path.as_str());
        }
        run_git_checked(data_dir, &args, "", None, context)?;
    }
    Ok(())
}

fn stage_syncable_changes(data_dir: &Path) -> Result<usize, AppError> {
    let tracked_out = run_git_raw(data_dir, &["ls-files", "-z"], "", None)?;
    let tracked = if tracked_out.status.success() {
        split_nul_paths(&tracked_out.stdout)
    } else {
        Vec::new()
    };

    let mut untrack_excluded = Vec::new();
    let mut deleted_syncable = Vec::new();
    for rel in &tracked {
        let norm = normalize_rel_path(rel).unwrap_or_else(|| rel.clone());
        if norm != ".gitignore" && !is_syncable_relative_path(&norm) {
            untrack_excluded.push(rel.clone());
        } else if norm != ".gitignore" && !data_dir.join(&norm).is_file() {
            deleted_syncable.push(rel.clone());
        }
    }

    run_git_paths_batched(
        data_dir,
        &["rm", "--cached", "--ignore-unmatch"],
        &untrack_excluded,
        "清理非同步跟踪文件",
    )?;
    run_git_paths_batched(
        data_dir,
        &["rm", "--cached", "--ignore-unmatch"],
        &deleted_syncable,
        "暂存已删除同步文件",
    )?;

    let syncable = collect_syncable_digests(data_dir)?;
    let mut to_add: Vec<String> = syncable.into_keys().collect();
    if data_dir.join(".gitignore").is_file() {
        to_add.push(".gitignore".to_string());
    }
    run_git_paths_batched(data_dir, &["add"], &to_add, "暂存同步文件")?;

    let status_out = run_git_checked(
        data_dir,
        &["status", "--porcelain", "-z"],
        "",
        None,
        "检查 Git 状态",
    )?;
    let changed_count = status_out
        .as_bytes()
        .split(|&b| b == 0)
        .filter(|entry| !entry.is_empty())
        .count();
    Ok(changed_count)
}

fn show_stage_bytes(
    data_dir: &Path,
    stage: u8,
    rel_path: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    let spec = format!(":{stage}:{rel_path}");
    let out = run_git_raw(data_dir, &["show", &spec], "", None)?;
    if out.status.success() {
        Ok(Some(out.stdout))
    } else {
        Ok(None)
    }
}

fn count_diff_changes(
    data_dir: &Path,
    from_rev: &str,
    to_rev: &str,
) -> Result<(usize, usize, bool), AppError> {
    let out = run_git_raw(
        data_dir,
        &["diff", "--name-status", "-z", from_rev, to_rev],
        "",
        None,
    )?;
    if !out.status.success() {
        return Ok((0, 0, false));
    }
    let tokens = split_nul_paths(&out.stdout);
    let mut downloaded = 0usize;
    let mut deleted_local = 0usize;
    let mut reminders_changed = false;
    let mut iter = tokens.into_iter();
    while let Some(status) = iter.next() {
        let Some(path) = iter.next() else {
            break;
        };
        if status.starts_with('R') || status.starts_with('C') {
            let Some(new_path) = iter.next() else {
                break;
            };
            if new_path == "reminders.json" || path == "reminders.json" {
                reminders_changed = true;
            }
            downloaded += 1;
            continue;
        }
        if path == ".gitignore" {
            continue;
        }
        if path == "reminders.json" {
            reminders_changed = true;
        }
        if status == "D" {
            deleted_local += 1;
        } else {
            downloaded += 1;
        }
    }
    Ok((downloaded, deleted_local, reminders_changed))
}

fn resolve_merge_conflicts(
    data_dir: &Path,
    summary: &mut SyncExecutionSummary,
) -> Result<(), AppError> {
    let conflicted_out = run_git_raw(
        data_dir,
        &["diff", "--name-only", "-z", "--diff-filter=U"],
        "",
        None,
    )?;
    let conflicted_paths = split_nul_paths(&conflicted_out.stdout);
    if conflicted_paths.is_empty() {
        let _ = run_git_raw(data_dir, &["merge", "--abort"], "", None);
        return Err(app_error(
            "syncGitFailed",
            "Git 合并失败且未检测到具体冲突文件",
        ));
    }

    let ts = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut deferred_json = Vec::new();
    let mut conflicted_note_paths = HashSet::new();

    for rel_path in conflicted_paths {
        let norm = normalize_rel_path(&rel_path).unwrap_or_else(|| rel_path.clone());
        if norm == ".gitignore" {
            let ours =
                show_stage_bytes(data_dir, 2, &norm)?.and_then(|b| String::from_utf8(b).ok());
            let theirs =
                show_stage_bytes(data_dir, 3, &norm)?.and_then(|b| String::from_utf8(b).ok());
            let mut combined = ours.unwrap_or_default();
            if let Some(t) = theirs {
                if !combined.ends_with('\n') && !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(&t);
            }
            let merged_ignore = generate_gitignore_content(Some(&combined));
            write_bytes_atomic(&data_dir.join(".gitignore"), merged_ignore.as_bytes())?;
            run_git_checked(
                data_dir,
                &["add", "--", ".gitignore"],
                "",
                None,
                "合并 .gitignore",
            )?;
            continue;
        }
        if norm == "metadata.json" || norm == "reminders.json" {
            deferred_json.push(norm);
            continue;
        }

        let ours = show_stage_bytes(data_dir, 2, &norm)?;
        let theirs = show_stage_bytes(data_dir, 3, &norm)?;

        if let Some(remote_bytes) = theirs.as_ref() {
            let conflict_rel = allocate_conflict_copy_path(data_dir, &norm, &ts);
            write_bytes_atomic(&data_dir.join(&conflict_rel), remote_bytes)?;
            conflicted_note_paths.insert(norm.clone());

            if ours.is_some() {
                run_git_checked(
                    data_dir,
                    &["checkout", "--ours", "--", &norm],
                    "",
                    None,
                    "保留本地冲突版本",
                )?;
            } else {
                run_git_checked(
                    data_dir,
                    &["checkout", "--theirs", "--", &norm],
                    "",
                    None,
                    "检出远端文件",
                )?;
            }
            run_git_checked(data_dir, &["add", "--", &norm], "", None, "标记冲突已解决")?;
            if is_syncable_relative_path(&conflict_rel) {
                run_git_checked(
                    data_dir,
                    &["add", "--", &conflict_rel],
                    "",
                    None,
                    "暂存冲突副本",
                )?;
            }

            summary.conflicts.push(SyncConflictItem {
                path: norm,
                conflict_copy_path: conflict_rel,
                timestamp: Utc::now(),
            });
        } else if ours.is_some() {
            run_git_checked(
                data_dir,
                &["checkout", "--ours", "--", &norm],
                "",
                None,
                "保留本地修改",
            )?;
            run_git_checked(data_dir, &["add", "--", &norm], "", None, "标记冲突已解决")?;
        } else {
            run_git_checked(
                data_dir,
                &["rm", "-f", "--ignore-unmatch", "--", &norm],
                "",
                None,
                "确认双方删除",
            )?;
        }
    }

    deferred_json.sort_by_key(|p| if p == "reminders.json" { 0 } else { 1 });
    for json_path in deferred_json {
        let ours = show_stage_bytes(data_dir, 2, &json_path)?;
        let theirs = show_stage_bytes(data_dir, 3, &json_path)?;
        match (ours, theirs) {
            (Some(local_bytes), Some(remote_bytes)) => {
                let backup_rel = allocate_conflict_copy_path(data_dir, &json_path, &ts);
                write_bytes_atomic(&data_dir.join(&backup_rel), &remote_bytes)?;

                let merged = if json_path == "metadata.json" {
                    merge_metadata_bytes(
                        data_dir,
                        &local_bytes,
                        &remote_bytes,
                        &conflicted_note_paths,
                    )
                } else {
                    merge_reminders_bytes(&local_bytes, &remote_bytes)
                };

                if let Some(merged_bytes) = merged {
                    write_bytes_atomic(&data_dir.join(&json_path), &merged_bytes)?;
                    if json_path == "reminders.json" {
                        summary.reminders_changed = true;
                    }
                } else {
                    write_bytes_atomic(&data_dir.join(&json_path), &local_bytes)?;
                    summary.conflicts.push(SyncConflictItem {
                        path: json_path.clone(),
                        conflict_copy_path: backup_rel,
                        timestamp: Utc::now(),
                    });
                }
                run_git_checked(
                    data_dir,
                    &["add", "--", &json_path],
                    "",
                    None,
                    "暂存合并后的索引",
                )?;
            }
            (Some(local_bytes), None) => {
                write_bytes_atomic(&data_dir.join(&json_path), &local_bytes)?;
                run_git_checked(
                    data_dir,
                    &["add", "--", &json_path],
                    "",
                    None,
                    "保留本地索引",
                )?;
            }
            (None, Some(remote_bytes)) => {
                write_bytes_atomic(&data_dir.join(&json_path), &remote_bytes)?;
                run_git_checked(
                    data_dir,
                    &["add", "--", &json_path],
                    "",
                    None,
                    "应用远端索引",
                )?;
            }
            (None, None) => {
                let _ = run_git_raw(
                    data_dir,
                    &["rm", "-f", "--ignore-unmatch", "--", &json_path],
                    "",
                    None,
                );
            }
        }
    }

    run_git_checked(
        data_dir,
        &["commit", "--no-edit"],
        "",
        None,
        "提交冲突解决合并",
    )?;
    Ok(())
}

pub fn sync_repo(data_dir: &Path, cfg: &GitSyncConfig) -> Result<SyncExecutionSummary, AppError> {
    ensure_git_available()?;
    ensure_repo_initialized(data_dir, cfg)?;

    let mut summary = SyncExecutionSummary::default();

    // 若当前已有提交但不在目标分支，先切到目标分支
    if rev_parse(data_dir, "HEAD")?.is_some() {
        let current_branch = run_git_raw(data_dir, &["symbolic-ref", "--short", "HEAD"], "", None)?;
        let current_name = String::from_utf8_lossy(&current_branch.stdout)
            .trim()
            .to_string();
        if current_name != cfg.branch {
            run_git_checked(
                data_dir,
                &["checkout", "-B", &cfg.branch],
                "",
                None,
                "切换同步分支",
            )?;
        }
    }

    let staged_count = stage_syncable_changes(data_dir)?;
    if staged_count > 0 {
        let msg = format!(
            "chore(sync): floral notepaper sync {}",
            Utc::now().to_rfc3339()
        );
        run_git_checked(data_dir, &["commit", "-m", &msg], "", None, "提交本地更改")?;
        summary.uploaded += staged_count;
    }

    let head_before = rev_parse(data_dir, "HEAD")?;

    // 检查远端分支是否存在并拉取
    let ls_remote = run_git_checked(
        data_dir,
        &["ls-remote", "--heads", "origin", &cfg.branch],
        &cfg.username,
        cfg.token.as_deref(),
        "检查 Git 远端分支",
    )?;
    let remote_branch_exists = !ls_remote.trim().is_empty();

    let mut fetch_head_sha: Option<String> = None;
    if remote_branch_exists {
        run_git_checked(
            data_dir,
            &["fetch", "origin", &cfg.branch],
            &cfg.username,
            cfg.token.as_deref(),
            "拉取 Git 远端更新",
        )?;
        fetch_head_sha = rev_parse(data_dir, "FETCH_HEAD")?;

        if let Some(remote_sha) = &fetch_head_sha {
            if let Some(before_sha) = &head_before {
                let is_ancestor = run_git_raw(
                    data_dir,
                    &["merge-base", "--is-ancestor", remote_sha, before_sha],
                    "",
                    None,
                )?
                .status
                .success();

                if !is_ancestor {
                    let shares_history =
                        run_git_raw(data_dir, &["merge-base", before_sha, remote_sha], "", None)?
                            .status
                            .success();

                    let merge_args: Vec<&str> = if shares_history {
                        vec!["merge", "--no-edit", "FETCH_HEAD"]
                    } else {
                        vec![
                            "merge",
                            "--no-edit",
                            "--allow-unrelated-histories",
                            "FETCH_HEAD",
                        ]
                    };

                    let merge_out = run_git_raw(data_dir, &merge_args, "", None)?;
                    if !merge_out.status.success() {
                        resolve_merge_conflicts(data_dir, &mut summary)?;
                    }
                    let (pulled, deleted_local, rem_changed) =
                        count_diff_changes(data_dir, before_sha, "HEAD")?;
                    summary.downloaded += pulled;
                    summary.deleted_local += deleted_local;
                    summary.reminders_changed |= rem_changed;
                    summary.remote_changes_applied = true;
                }
            } else {
                // 本地尚无提交，直接基于 FETCH_HEAD 创建分支
                run_git_checked(
                    data_dir,
                    &["checkout", "-B", &cfg.branch, "FETCH_HEAD"],
                    "",
                    None,
                    "检出远端笔记",
                )?;
                let files_out = run_git_raw(data_dir, &["ls-files", "-z"], "", None)?;
                let count = split_nul_paths(&files_out.stdout)
                    .into_iter()
                    .filter(|p| p != ".gitignore")
                    .count();
                summary.downloaded += count;
                summary.reminders_changed = data_dir.join("reminders.json").is_file();
                summary.remote_changes_applied = true;
            }
        }
    }

    let head_after = rev_parse(data_dir, "HEAD")?;
    if let Some(head_sha) = head_after {
        let needs_push = fetch_head_sha.as_deref() != Some(head_sha.as_str());
        if needs_push {
            let refspec = format!("HEAD:refs/heads/{}", cfg.branch);
            run_git_checked(
                data_dir,
                &["push", "-u", "origin", &refspec],
                &cfg.username,
                cfg.token.as_deref(),
                "推送 Git 同步",
            )?;
            if summary.uploaded == 0 && !remote_branch_exists {
                summary.uploaded = 1;
            }
        }
    }

    summary.message = if summary.conflicts.is_empty() {
        format!(
            "Git 同步完成（提交变更 {}，拉取变更 {}，本地删除 {}）",
            summary.uploaded, summary.downloaded, summary.deleted_local
        )
    } else {
        format!(
            "Git 同步完成，发现 {} 处冲突已保留本地并另存远端副本",
            summary.conflicts.len()
        )
    };

    Ok(summary)
}
