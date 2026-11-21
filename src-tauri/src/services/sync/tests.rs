use super::{
    build_status_dto, conflict_copy_relative_path,
    git_sync::{
        ensure_gitignore, generate_gitignore_content, sync_repo, test_connection as git_test_conn,
        validate_git_remote_url, AskPassGuard, GitSyncConfig, GITIGNORE_REQUIRED_PATTERNS,
    },
    is_syncable_relative_path, run_sync_with_store,
    secrets::{SecretStore, SyncSecretKind},
    should_run_auto_sync,
    webdav::{
        plan_three_way_sync, sync_with_transport, ConflictBaselinePair, HttpWebDavTransport,
        SyncAction, WebDavConfig, WebDavTransport,
    },
    SyncFileDigest, SyncProvider, SyncRunState, SyncState,
};
use crate::{
    json_io::write_json_atomic,
    services::notes::{AppConfig, AppError, NoteStore, SaveNoteRequest},
};
use chrono::Utc;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    thread,
};
use uuid::Uuid;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("floral-notepaper-sync-tests")
        .join(format!("{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn test_store(label: &str) -> (PathBuf, NoteStore) {
    let root = temp_dir(label);
    let store = NoteStore::new(root.clone(), root.clone());
    write_json_atomic(&store.config_path(), &store.default_config()).expect("write default config");
    (root, store)
}

fn digest(content: &[u8]) -> SyncFileDigest {
    SyncFileDigest {
        blake3: blake3::hash(content).to_hex().to_string(),
        size: content.len() as u64,
        modified_at: Some(Utc::now()),
    }
}

#[derive(Default, Clone)]
struct InMemoryWebDavTransport {
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    dirs: Arc<Mutex<Vec<String>>>,
}

impl InMemoryWebDavTransport {
    fn key(cfg: &WebDavConfig, rel_path: &str) -> String {
        format!("{}/{}", cfg.remote_dir, rel_path)
    }

    fn stored_keys(&self, remote_dir: &str) -> Vec<String> {
        let prefix = format!("{remote_dir}/");
        self.files
            .lock()
            .expect("lock files")
            .keys()
            .filter_map(|k| k.strip_prefix(&prefix).map(str::to_string))
            .collect()
    }
}

impl WebDavTransport for InMemoryWebDavTransport {
    fn test_connection(&self, _cfg: &WebDavConfig) -> Result<(), AppError> {
        Ok(())
    }

    fn ensure_dir(&self, cfg: &WebDavConfig, rel_dir: &str) -> Result<(), AppError> {
        self.dirs
            .lock()
            .expect("lock dirs")
            .push(Self::key(cfg, rel_dir));
        Ok(())
    }

    fn get_file(&self, cfg: &WebDavConfig, rel_path: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self
            .files
            .lock()
            .expect("lock files")
            .get(&Self::key(cfg, rel_path))
            .cloned())
    }

    fn put_file(&self, cfg: &WebDavConfig, rel_path: &str, bytes: &[u8]) -> Result<(), AppError> {
        self.files
            .lock()
            .expect("lock files")
            .insert(Self::key(cfg, rel_path), bytes.to_vec());
        Ok(())
    }

    fn delete_file(&self, cfg: &WebDavConfig, rel_path: &str) -> Result<(), AppError> {
        self.files
            .lock()
            .expect("lock files")
            .remove(&Self::key(cfg, rel_path));
        Ok(())
    }
}

#[test]
fn sync_file_filter_includes_only_syncable_paths_and_excludes_derived_and_temp_files() {
    assert!(is_syncable_relative_path("notes/abc.md"));
    assert!(is_syncable_relative_path("notes/工作/meeting.md"));
    assert!(is_syncable_relative_path("notes\\分类\\upper.MD"));
    assert!(is_syncable_relative_path("metadata.json"));
    assert!(is_syncable_relative_path("reminders.json"));
    assert!(is_syncable_relative_path("images/note-1/photo.png"));
    assert!(is_syncable_relative_path("attachments/note-1/spec.pdf"));

    assert!(!is_syncable_relative_path("floral.db"));
    assert!(!is_syncable_relative_path("floral.db-wal"));
    assert!(!is_syncable_relative_path("floral.db-shm"));
    assert!(!is_syncable_relative_path("external-commands.json"));
    assert!(!is_syncable_relative_path("external-commands.json.lock"));
    assert!(!is_syncable_relative_path("external-previews/abc.png"));
    assert!(!is_syncable_relative_path(".external-rev"));
    assert!(!is_syncable_relative_path(".external-rev.lock"));
    assert!(!is_syncable_relative_path(".sync-webdav-manifest.json"));
    assert!(!is_syncable_relative_path(".sync-status.json"));
    assert!(!is_syncable_relative_path(".sync-run.lock"));
    assert!(!is_syncable_relative_path(".lock"));
    assert!(!is_syncable_relative_path("metadata.json.lock"));
    assert!(!is_syncable_relative_path("notes/draft.md.tmp"));
    assert!(!is_syncable_relative_path("notes/draft.lock"));
    assert!(!is_syncable_relative_path("notes/~$lock.md"));
    assert!(!is_syncable_relative_path("notes/note.md~"));
    assert!(!is_syncable_relative_path("notes/.hidden.md"));
    assert!(!is_syncable_relative_path("notes/plain.txt"));
    assert!(!is_syncable_relative_path("images/note-1/photo.png.part"));
    assert!(!is_syncable_relative_path("attachments/note-1/.DS_Store"));
    assert!(!is_syncable_relative_path("backups/auto-20261121.zip"));
    assert!(!is_syncable_relative_path("history/note-1/v1.md"));
    assert!(!is_syncable_relative_path("backgrounds/bg.png"));
    assert!(!is_syncable_relative_path("search-index.json"));
    assert!(!is_syncable_relative_path("config.json"));
    assert!(!is_syncable_relative_path(".git/config"));
    assert!(!is_syncable_relative_path("../escape.md"));
}

#[test]
fn three_way_sync_planner_handles_all_cases_including_acknowledged_conflicts() {
    let mut local = BTreeMap::new();
    let mut baseline = BTreeMap::new();
    let mut remote = BTreeMap::new();
    let mut ack = BTreeMap::new();

    // 1. New local -> Upload
    local.insert("notes/new-local.md".into(), digest(b"local"));
    // 2. New remote -> Download
    remote.insert("notes/new-remote.md".into(), digest(b"remote"));
    // 3. Local unchanged, remote updated -> Download
    baseline.insert("notes/remote-edit.md".into(), digest(b"v0"));
    local.insert("notes/remote-edit.md".into(), digest(b"v0"));
    remote.insert("notes/remote-edit.md".into(), digest(b"v1"));
    // 4. Remote unchanged, local updated -> Upload
    baseline.insert("notes/local-edit.md".into(), digest(b"v0"));
    local.insert("notes/local-edit.md".into(), digest(b"v1"));
    remote.insert("notes/local-edit.md".into(), digest(b"v0"));
    // 5. Remote deleted, local unchanged -> DeleteLocal
    baseline.insert("notes/remote-del.md".into(), digest(b"v0"));
    local.insert("notes/remote-del.md".into(), digest(b"v0"));
    // 6. Local deleted, remote unchanged -> DeleteRemote
    baseline.insert("notes/local-del.md".into(), digest(b"v0"));
    remote.insert("notes/local-del.md".into(), digest(b"v0"));
    // 7. Two-sided conflict -> Conflict
    baseline.insert("notes/both.md".into(), digest(b"v0"));
    local.insert("notes/both.md".into(), digest(b"vA"));
    remote.insert("notes/both.md".into(), digest(b"vB"));
    // 8. Already acknowledged conflict with unchanged local/remote -> NoOp
    baseline.insert("notes/ack.md".into(), digest(b"vB"));
    local.insert("notes/ack.md".into(), digest(b"vA"));
    remote.insert("notes/ack.md".into(), digest(b"vB"));
    ack.insert(
        "notes/ack.md".into(),
        ConflictBaselinePair {
            local_blake3: digest(b"vA").blake3,
            remote_blake3: digest(b"vB").blake3,
        },
    );
    // 9. Resolved locally after acknowledged conflict -> Upload
    baseline.insert("notes/resolved.md".into(), digest(b"vB"));
    local.insert("notes/resolved.md".into(), digest(b"vMerged"));
    remote.insert("notes/resolved.md".into(), digest(b"vB"));
    ack.insert(
        "notes/resolved.md".into(),
        ConflictBaselinePair {
            local_blake3: digest(b"vA").blake3,
            remote_blake3: digest(b"vB").blake3,
        },
    );

    let plan = plan_three_way_sync(&local, &baseline, &remote, &ack);
    assert_eq!(plan.get("notes/new-local.md"), Some(&SyncAction::Upload));
    assert_eq!(plan.get("notes/new-remote.md"), Some(&SyncAction::Download));
    assert_eq!(
        plan.get("notes/remote-edit.md"),
        Some(&SyncAction::Download)
    );
    assert_eq!(plan.get("notes/local-edit.md"), Some(&SyncAction::Upload));
    assert_eq!(
        plan.get("notes/remote-del.md"),
        Some(&SyncAction::DeleteLocal)
    );
    assert_eq!(
        plan.get("notes/local-del.md"),
        Some(&SyncAction::DeleteRemote)
    );
    assert_eq!(plan.get("notes/both.md"), Some(&SyncAction::Conflict));
    assert_eq!(plan.get("notes/ack.md"), Some(&SyncAction::NoOp));
    assert_eq!(plan.get("notes/resolved.md"), Some(&SyncAction::Upload));
}

#[test]
fn webdav_sync_transfers_files_excludes_derived_and_handles_two_sided_conflicts_non_destructively()
{
    let dir_a = temp_dir("webdav-a");
    let dir_b = temp_dir("webdav-b");
    fs::create_dir_all(dir_a.join("notes")).expect("create notes a");
    fs::create_dir_all(dir_b.join("notes")).expect("create notes b");
    fs::create_dir_all(dir_a.join("images/n1")).expect("create images a");

    fs::write(dir_a.join("notes/n1.md"), "Initial content").expect("write n1");
    fs::write(dir_a.join("images/n1/pic.png"), b"png-bytes").expect("write pic");
    fs::write(dir_a.join("floral.db"), b"sqlite-should-not-sync").expect("write db");
    fs::write(dir_a.join("external-commands.json"), b"{}").expect("write external");
    fs::write(dir_a.join(".external-rev"), b"1\n").expect("write rev");
    fs::write(dir_a.join("notes/temp.tmp"), b"tmp").expect("write tmp");

    let transport = InMemoryWebDavTransport::default();
    let cfg = WebDavConfig {
        url: reqwest::Url::parse("https://dav.example.com").expect("valid url"),
        raw_url: "https://dav.example.com".into(),
        username: "alice".into(),
        password: Some("secret".into()),
        remote_dir: "floral-notepaper".into(),
    };

    let sum_a1 = sync_with_transport(&dir_a, &cfg, &transport).expect("sync a1");
    assert_eq!(sum_a1.uploaded, 2);
    let remote_keys = transport.stored_keys("floral-notepaper");
    assert!(remote_keys.contains(&"notes/n1.md".to_string()));
    assert!(remote_keys.contains(&"images/n1/pic.png".to_string()));
    assert!(!remote_keys.iter().any(|k| k.contains("floral.db")));
    assert!(!remote_keys.iter().any(|k| k.contains("external-")));
    assert!(!remote_keys.iter().any(|k| k.contains(".external-rev")));
    assert!(!remote_keys.iter().any(|k| k.contains("temp.tmp")));

    // Device B pulls initial state
    let sum_b1 = sync_with_transport(&dir_b, &cfg, &transport).expect("sync b1");
    assert_eq!(sum_b1.downloaded, 2);
    assert_eq!(
        fs::read_to_string(dir_b.join("notes/n1.md")).expect("read b n1"),
        "Initial content"
    );

    // Concurrent edits on A and B
    fs::write(dir_a.join("notes/n1.md"), "Edited on A").expect("edit a");
    let sum_a2 = sync_with_transport(&dir_a, &cfg, &transport).expect("sync a2");
    assert_eq!(sum_a2.uploaded, 1);

    fs::write(dir_b.join("notes/n1.md"), "Edited on B").expect("edit b");
    let sum_b2 = sync_with_transport(&dir_b, &cfg, &transport).expect("sync b2 conflict");
    assert_eq!(sum_b2.conflicts.len(), 1);
    assert_eq!(sum_b2.conflicts[0].path, "notes/n1.md");
    assert!(sum_b2.conflicts[0]
        .conflict_copy_path
        .starts_with("notes/n1.conflict-"));
    assert!(sum_b2.conflicts[0].conflict_copy_path.ends_with(".md"));

    // Local content preserved, remote saved as *.conflict-<ts>.md
    assert_eq!(
        fs::read_to_string(dir_b.join("notes/n1.md")).expect("local preserved"),
        "Edited on B"
    );
    assert_eq!(
        fs::read_to_string(dir_b.join(&sum_b2.conflicts[0].conflict_copy_path))
            .expect("conflict copy"),
        "Edited on A"
    );

    // Re-running sync on B without edits must not duplicate conflict files
    let sum_b3 = sync_with_transport(&dir_b, &cfg, &transport).expect("sync b3 repeat");
    assert!(sum_b3.conflicts.is_empty());

    let _ = fs::remove_dir_all(dir_a);
    let _ = fs::remove_dir_all(dir_b);
}

#[test]
fn webdav_sync_merges_metadata_conflicts_non_destructively() {
    let dir_a = temp_dir("webdav-meta-a");
    let dir_b = temp_dir("webdav-meta-b");
    let store_a = NoteStore::new(dir_a.clone(), dir_a.clone());
    let store_b = NoteStore::new(dir_b.clone(), dir_b.clone());
    write_json_atomic(&store_a.config_path(), &store_a.default_config()).expect("cfg a");
    write_json_atomic(&store_b.config_path(), &store_b.default_config()).expect("cfg b");

    let note_a = store_a
        .create_note(SaveNoteRequest {
            title: "来自 A".into(),
            content: "内容 A".into(),
            category: String::new(),
            tags: vec!["a".into()],
            pinned: false,
        })
        .expect("create note a");
    let note_b = store_b
        .create_note(SaveNoteRequest {
            title: "来自 B".into(),
            content: "内容 B".into(),
            category: String::new(),
            tags: vec!["b".into()],
            pinned: true,
        })
        .expect("create note b");

    let transport = InMemoryWebDavTransport::default();
    let cfg = WebDavConfig {
        url: reqwest::Url::parse("https://dav.example.com").expect("valid url"),
        raw_url: "https://dav.example.com".into(),
        username: String::new(),
        password: None,
        remote_dir: "floral-notepaper".into(),
    };

    sync_with_transport(&dir_a, &cfg, &transport).expect("sync a");
    sync_with_transport(&dir_b, &cfg, &transport).expect("sync b");

    let notes_b = store_b.list_notes().expect("list notes on b");
    let ids_b: Vec<&str> = notes_b.iter().map(|n| n.id.as_str()).collect();
    assert!(ids_b.contains(&note_a.id.as_str()));
    assert!(ids_b.contains(&note_b.id.as_str()));

    let conflict_meta_exists = fs::read_dir(&dir_b)
        .expect("read dir b")
        .filter_map(|e| e.ok())
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("metadata.conflict-")
        });
    assert!(conflict_meta_exists);

    let _ = fs::remove_dir_all(dir_a);
    let _ = fs::remove_dir_all(dir_b);
}

#[test]
fn http_webdav_transport_roundtrips_requests_and_surfaces_auth_errors() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.set_nonblocking(true).expect("set nonblocking");
    let addr = listener.local_addr().expect("local addr");
    let store: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let store_server = Arc::clone(&store);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_server = Arc::clone(&stop);

    let handle = thread::spawn(move || {
        while !stop_server.load(Ordering::Relaxed) {
            let mut stream = match listener.accept() {
                Ok((s, _)) => s,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                }
                Err(_) => break,
            };
            let _ = stream.set_nonblocking(false);
            let mut buf = [0u8; 8192];
            let read = stream.read(&mut buf).unwrap_or(0);
            if read == 0 {
                continue;
            }
            let req_text = String::from_utf8_lossy(&buf[..read]);
            let first_line = req_text.lines().next().unwrap_or("");
            let mut parts = first_line.split_whitespace();
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("/");

            let has_valid_auth = req_text.lines().any(|l| {
                l.split_once(':').is_some_and(|(name, value)| {
                    name.trim().eq_ignore_ascii_case("authorization")
                        && value.trim() == "Basic dXNlcjpwYXNz"
                })
            });

            let response = if !has_valid_auth {
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string()
            } else {
                match method {
                    "PROPFIND" => {
                        if path.ends_with("/missing-dir/") {
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_string()
                        } else {
                            "HTTP/1.1 207 Multi-Status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_string()
                        }
                    }
                    "MKCOL" => "HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string(),
                    "PUT" => {
                        let body = req_text.split("\r\n\r\n").nth(1).unwrap_or("").as_bytes();
                        store_server
                            .lock()
                            .expect("lock")
                            .insert(path.to_string(), body.to_vec());
                        "HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_string()
                    }
                    "GET" => {
                        if let Some(body) = store_server.lock().expect("lock").get(path).cloned() {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                String::from_utf8_lossy(&body)
                            )
                        } else {
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_string()
                        }
                    }
                    "DELETE" => {
                        store_server.lock().expect("lock").remove(path);
                        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_string()
                    }
                    _ => "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string(),
                }
            };
            let _ = stream.write_all(response.as_bytes());
        }
    });

    let transport = HttpWebDavTransport::new().expect("client");
    let bad_cfg = WebDavConfig {
        url: reqwest::Url::parse(&format!("http://{addr}/dav")).expect("url"),
        raw_url: format!("http://{addr}/dav"),
        username: "user".into(),
        password: Some("wrong".into()),
        remote_dir: "floral-notepaper".into(),
    };
    let err = transport
        .test_connection(&bad_cfg)
        .expect_err("wrong auth should fail");
    assert_eq!(err.code, "syncAuthFailed");

    let good_cfg = WebDavConfig {
        password: Some("pass".into()),
        ..bad_cfg
    };
    transport
        .test_connection(&good_cfg)
        .expect("propfind connection ok");
    transport
        .put_file(&good_cfg, "notes/hello.md", b"hello webdav")
        .expect("put file");
    let fetched = transport
        .get_file(&good_cfg, "notes/hello.md")
        .expect("get file");
    assert_eq!(fetched.as_deref(), Some(b"hello webdav".as_slice()));
    transport
        .delete_file(&good_cfg, "notes/hello.md")
        .expect("delete file");

    stop.store(true, Ordering::Relaxed);
    let _ = handle.join();
}

#[test]
fn gitignore_generation_includes_required_patterns_and_is_idempotent() {
    let dir = temp_dir("gitignore");
    fs::write(dir.join(".gitignore"), "# custom rule\nmy-custom.log\n").expect("seed gitignore");
    ensure_gitignore(&dir).expect("ensure gitignore");
    let content = fs::read_to_string(dir.join(".gitignore")).expect("read gitignore");

    assert!(content.contains("my-custom.log"));
    for required in GITIGNORE_REQUIRED_PATTERNS {
        assert!(
            content.lines().any(|line| line.trim() == *required),
            "missing gitignore pattern: {required}"
        );
    }

    let again = generate_gitignore_content(Some(&content));
    assert_eq!(again, content);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn git_validation_rejects_embedded_credentials_and_askpass_cleans_up_on_drop() {
    let err = validate_git_remote_url("https://alice:topsecret@github.com/alice/notes.git")
        .expect_err("embedded password must be rejected");
    assert_eq!(err.code, "syncConfigInvalid");

    let script_path = {
        let guard = AskPassGuard::create().expect("create askpass script");
        let path = guard.path().to_path_buf();
        assert!(path.is_file());
        path
    };
    assert!(
        !script_path.exists(),
        "askpass script must be removed on Drop"
    );
}

#[test]
fn git_sync_end_to_end_with_local_bare_repo_and_conflict_backup() {
    let bare = temp_dir("git-bare");
    let status = Command::new("git")
        .args(["init", "--bare"])
        .current_dir(&bare)
        .status()
        .expect("init bare repo");
    assert!(status.success());

    let (dir_a, store_a) = test_store("git-dev-a");
    let (dir_b, store_b) = test_store("git-dev-b");

    // Seed Device A with a note + excluded artifacts
    let note = store_a
        .create_note(SaveNoteRequest {
            title: "中文笔记".into(),
            content: "来自设备 A 的初始内容".into(),
            category: "工作".into(),
            tags: vec!["同步".into()],
            pinned: false,
        })
        .expect("create note a");
    fs::write(dir_a.join("floral.db"), b"sqlite").expect("db");
    fs::write(dir_a.join("external-commands.json"), b"{}").expect("external");
    fs::write(dir_a.join(".external-rev"), b"1\n").expect("rev");
    fs::write(dir_a.join(".sync-status.json"), b"{}").expect("sync status");
    fs::create_dir_all(dir_a.join("backups")).expect("backups");
    fs::write(dir_a.join("backups/auto.zip"), b"zip").expect("backup zip");
    fs::write(dir_a.join("notes/tmp.lock"), b"lock").expect("lock");
    fs::write(dir_a.join("notes/draft.tmp"), b"tmp").expect("tmp");

    let remote_url = bare.to_string_lossy().to_string();
    let git_cfg = GitSyncConfig {
        remote_url: remote_url.clone(),
        branch: "main".into(),
        username: String::new(),
        token: None,
    };

    git_test_conn(&git_cfg).expect("git ls-remote succeeds");
    let sum_a1 = sync_repo(&dir_a, &git_cfg).expect("sync a1");
    assert!(sum_a1.uploaded > 0);

    // Verify excluded files were NEVER tracked and .git/config has no credentials
    let tracked = Command::new("git")
        .args(["-c", "core.quotepath=false", "ls-files"])
        .current_dir(&dir_a)
        .output()
        .expect("ls-files");
    let tracked_list = String::from_utf8_lossy(&tracked.stdout);
    assert!(tracked_list.contains(&note.file_name));
    assert!(tracked_list.contains("metadata.json"));
    assert!(!tracked_list.contains("floral.db"));
    assert!(!tracked_list.contains("external-commands.json"));
    assert!(!tracked_list.contains(".external-rev"));
    assert!(!tracked_list.contains(".sync-status.json"));
    assert!(!tracked_list.contains("backups/"));
    assert!(!tracked_list.contains("tmp.lock"));
    assert!(!tracked_list.contains("draft.tmp"));

    // Device B syncs via run_sync_with_store -> pulls note and rebuilds FTS5
    let mut cfg_b = store_b.load_config().expect("load cfg b");
    cfg_b.sync_provider = "git".into();
    cfg_b.sync_git_remote_url = remote_url.clone();
    cfg_b.sync_git_branch = "main".into();
    store_b.save_config(cfg_b.clone()).expect("save cfg b");

    let state_b = SyncState::with_secrets(SecretStore::in_memory_for_tests());
    let status_b1 = run_sync_with_store(&store_b, &cfg_b, &state_b, None).expect("run sync on b");
    assert_eq!(status_b1.state, SyncRunState::Success);
    assert!(status_b1.downloaded > 0);
    let hits = store_b
        .search_content("初始内容")
        .expect("search pulled note");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, note.id);

    // Two-sided Git conflict on the same note
    let rel_note_path = format!("notes/工作/{}", note.file_name);
    fs::write(dir_a.join(&rel_note_path), "A 的冲突更新").expect("edit on a");
    sync_repo(&dir_a, &git_cfg).expect("push conflict from a");

    fs::write(dir_b.join(&rel_note_path), "B 的本地更新").expect("edit on b");
    let sum_b2 = sync_repo(&dir_b, &git_cfg).expect("sync b conflict");
    assert_eq!(sum_b2.conflicts.len(), 1);
    assert_eq!(sum_b2.conflicts[0].path, rel_note_path);
    assert!(sum_b2.conflicts[0]
        .conflict_copy_path
        .contains(".conflict-"));
    assert!(sum_b2.conflicts[0].conflict_copy_path.ends_with(".md"));
    assert_eq!(
        fs::read_to_string(dir_b.join(&rel_note_path)).expect("b local preserved"),
        "B 的本地更新"
    );
    assert_eq!(
        fs::read_to_string(dir_b.join(&sum_b2.conflicts[0].conflict_copy_path))
            .expect("a remote saved as conflict copy"),
        "A 的冲突更新"
    );

    let _ = fs::remove_dir_all(bare);
    let _ = fs::remove_dir_all(dir_a);
    let _ = fs::remove_dir_all(dir_b);
}

#[test]
fn app_config_deserializes_legacy_json_with_strict_opt_in_sync_defaults() {
    let legacy_json = r#"{
        "locale": "zh-CN",
        "globalShortcut": "Ctrl+Space",
        "closeToTray": true,
        "autostart": false,
        "defaultViewMode": "split"
    }"#;
    let parsed: AppConfig = serde_json::from_str(legacy_json).expect("deserialize legacy config");
    assert_eq!(parsed.sync_provider, "none");
    assert_eq!(parsed.sync_auto_interval_minutes, 0);
    assert_eq!(parsed.sync_webdav_url, "");
    assert_eq!(parsed.sync_webdav_username, "");
    assert_eq!(parsed.sync_webdav_remote_dir, "floral-notepaper");
    assert_eq!(parsed.sync_git_remote_url, "");
    assert_eq!(parsed.sync_git_branch, "main");
    assert_eq!(parsed.sync_git_username, "");

    // Opt-in scheduler guard
    assert!(!should_run_auto_sync(&parsed, None, Utc::now()));
    let mut enabled_zero = parsed.clone();
    enabled_zero.sync_provider = "webdav".into();
    assert!(!should_run_auto_sync(&enabled_zero, None, Utc::now()));
    enabled_zero.sync_auto_interval_minutes = 15;
    assert!(should_run_auto_sync(&enabled_zero, None, Utc::now()));
}

#[test]
fn secrets_handle_unavailable_keyring_and_validation_gracefully() {
    let unavailable = SecretStore::unavailable_for_tests();
    let set_err = unavailable
        .set_secret(SyncSecretKind::WebDavPassword, "pw")
        .expect_err("unavailable keyring should fail clearly");
    assert_eq!(set_err.code, "syncSecureStoreUnavailable");

    let has_err = unavailable
        .has_secret(SyncSecretKind::GitToken)
        .expect_err("unavailable keyring has_secret");
    assert_eq!(has_err.code, "syncSecureStoreUnavailable");

    let get_err = unavailable
        .get_secret(SyncSecretKind::GitToken)
        .expect_err("unavailable keyring get_secret");
    assert_eq!(get_err.code, "syncSecureStoreUnavailable");

    let clear_err = unavailable
        .clear_secret(SyncSecretKind::GitToken)
        .expect_err("unavailable keyring clear_secret");
    assert_eq!(clear_err.code, "syncSecureStoreUnavailable");

    // Empty secret & invalid kind
    let mem = SecretStore::in_memory_for_tests();
    let empty_err = mem
        .set_secret(SyncSecretKind::WebDavPassword, "   ")
        .expect_err("empty secret rejected");
    assert_eq!(empty_err.code, "syncSecretEmpty");
    assert_eq!(
        SyncSecretKind::parse("unknown")
            .expect_err("invalid kind")
            .code,
        "syncSecretInvalidKind"
    );

    // Status DTO tolerates unavailable keyring without failing
    let (dir, store) = test_store("status-unavailable-keyring");
    let cfg = store.load_config().expect("load cfg");
    let state = SyncState::with_secrets(SecretStore::unavailable_for_tests());
    let dto = build_status_dto(&cfg, store.data_dir(), &state);
    assert_eq!(dto.provider, SyncProvider::None);
    assert!(!dto.keyring_available);
    assert!(!dto.has_webdav_password);
    assert!(!dto.has_git_token);

    assert_eq!(
        conflict_copy_relative_path("notes/工作/日记.md", "20261121T120000Z"),
        "notes/工作/日记.conflict-20261121T120000Z.md"
    );

    let _ = fs::remove_dir_all(dir);
}
