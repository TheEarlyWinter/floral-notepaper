pub mod cli;
pub mod desktop;
pub mod json_io;
pub mod locales;
pub mod reminder_scheduler;
pub mod services;
pub mod updater;

use encoding_rs::{Encoding, GBK, UTF_16BE, UTF_16LE};
use locales::Locale;
use serde::{Deserialize, Serialize};
use services::{
    library::{Attachment, BackupInfo, SearchResult},
    notes::{
        default_store, AppConfig, AppError, MergeNotesRequest, Note, NoteMetadata, SaveNoteRequest,
    },
    reminders::{self, Reminder},
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, env, fs, io::Write, path::PathBuf, sync::Mutex};
use uuid::Uuid;

const MAX_EXTERNAL_TEXT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PDF_MARKDOWN_BYTES: usize = 25 * 1024 * 1024;
const PDF_EXPORT_TIMEOUT_SECS: u64 = 90;
pub(crate) const PDF_EXPORT_WINDOW_PREFIX: &str = "pdf-export-";
const EXTERNAL_TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "html", "htm"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportRequest {
    path: String,
    title: String,
    markdown: String,
    #[serde(default)]
    font_size: Option<u32>,
    #[serde(default)]
    render_html: bool,
    #[serde(default)]
    image_base_dir: Option<String>,
    #[serde(default)]
    external_image_base_dir: Option<String>,
    #[serde(default)]
    external_file_path: Option<String>,
}

struct PdfExportSession {
    request: Option<PdfExportRequest>,
    sender: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
}

#[derive(Default)]
struct PdfExportState {
    sessions: Mutex<HashMap<String, PdfExportSession>>,
}

fn io_error(message: impl Into<String>) -> AppError {
    AppError {
        code: "io".into(),
        message: message.into(),
        details: Default::default(),
    }
}

/// 外部文件是用户显式打开/保存的文本文档，而不是通用文件系统 API。
/// 限制绝对路径、文本扩展名、常规文件和大小，保留编辑 Markdown/TXT 与导出 HTML。
fn validate_external_text_path(raw_path: &str, allow_new_file: bool) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(raw_path.trim());
    if !path.is_absolute() {
        return Err(io_error("外部文件路径必须是绝对路径"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !EXTERNAL_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(io_error("外部文件仅支持 Markdown、TXT 或 HTML"));
    }

    match fs::metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(io_error("外部文件必须是普通文件"));
            }
            if metadata.len() > MAX_EXTERNAL_TEXT_BYTES {
                return Err(io_error("外部文本文件不能超过 25 MB"));
            }
        }
        Err(error) if allow_new_file && error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| io_error("外部文件没有有效父目录"))?;
            if !parent.is_dir() {
                return Err(io_error("外部文件的目标文件夹不存在"));
            }
        }
        Err(error) => return Err(io_error(error.to_string())),
    }
    Ok(path)
}

fn validate_pdf_export_path(raw_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(raw_path.trim());
    if !path.is_absolute() {
        return Err(io_error("PDF 导出路径必须是绝对路径"));
    }
    let is_pdf = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err(io_error("PDF 导出路径必须使用 .pdf 扩展名"));
    }

    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(io_error("PDF 导出目标必须是普通文件")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| io_error("PDF 导出路径没有有效父目录"))?;
            if !parent.is_dir() {
                return Err(io_error("PDF 导出目标文件夹不存在"));
            }
        }
        Err(error) => return Err(io_error(error.to_string())),
    }
    Ok(path)
}

fn decode_external_text_with_encoding(
    bytes: &[u8],
    encoding: &'static Encoding,
) -> Result<String, AppError> {
    let (decoded, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(io_error(
            "外部文本文件编码不受支持，请另存为 UTF-8、UTF-16 或 GBK 后再打开",
        ));
    }
    Ok(decoded.into_owned())
}

/// External TXT files on Windows are commonly GBK or UTF-16, while Rust's
/// `read_to_string` accepts UTF-8 only. Prefer an explicit BOM; otherwise keep
/// valid UTF-8 verbatim and use GBK only as the legacy fallback.
fn decode_external_text_bytes(bytes: Vec<u8>) -> Result<String, AppError> {
    if bytes.starts_with(&[0xff, 0xfe]) {
        return decode_external_text_with_encoding(&bytes[2..], UTF_16LE);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return decode_external_text_with_encoding(&bytes[2..], UTF_16BE);
    }

    match String::from_utf8(bytes) {
        Ok(text) => Ok(text
            .strip_prefix('\u{feff}')
            .unwrap_or(text.as_str())
            .to_string()),
        Err(error) => decode_external_text_with_encoding(&error.into_bytes(), GBK),
    }
}

fn validate_image_source_path(raw_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(raw_path.trim());
    if !path.is_absolute() {
        return Err(io_error("图片路径必须是绝对路径"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(io_error("不支持的图片格式"));
    }
    let metadata = fs::metadata(&path).map_err(|error| io_error(error.to_string()))?;
    if !metadata.is_file() {
        return Err(io_error("图片源必须是普通文件"));
    }
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err(io_error("单张图片不能超过 50 MB"));
    }
    Ok(path)
}
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn app_name() -> Result<String, AppError> {
    let locale = Locale::from_tag(&default_store()?.load_config()?.locale);
    Ok(locales::app_name(locale).to_string())
}

#[tauri::command]
fn notes_list() -> Result<Vec<NoteMetadata>, AppError> {
    default_store()?.list_notes()
}

#[tauri::command]
fn notes_get(id: String) -> Result<Note, AppError> {
    default_store()?.read_note(&id)
}

#[tauri::command]
fn notes_create(app: AppHandle, request: SaveNoteRequest) -> Result<Note, AppError> {
    let note = default_store()?.create_note(request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_update(app: AppHandle, id: String, request: SaveNoteRequest) -> Result<Note, AppError> {
    let note = default_store()?.update_note(&id, request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

/// 主窗口 JS 侧完成保存后的收尾：销毁主窗口（不触发 CloseRequested，避免
/// Tauri 对同一次 close 请求的重入保护吞掉二次 close），随后 Destroyed 回调
/// 里的退出协调会等待其余窗口（便签池）落盘再整体退出。
#[tauri::command]
fn window_main_close_finished(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.destroy();
    }
}

#[tauri::command]
fn notes_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let store = default_store()?;
    store.delete_note(&id)?;
    // A deleted note can no longer receive a reminder. Clean these records
    // only after deletion succeeds; cleanup failure must not misreport the
    // already-completed note deletion as a failure.
    if let Err(error) = reminders::delete_for_note(store.data_dir(), &id) {
        eprintln!("failed to remove reminders for deleted note {id}: {error}");
    }
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn notes_merge(app: AppHandle, request: MergeNotesRequest) -> Result<Note, AppError> {
    let note = default_store()?.merge_notes(request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_open_daily(app: AppHandle) -> Result<Note, AppError> {
    let note = default_store()?.open_daily_note()?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_list_versions(id: String) -> Result<Vec<services::notes::NoteVersion>, AppError> {
    default_store()?.list_note_versions(&id)
}

#[tauri::command]
fn notes_restore_version(app: AppHandle, id: String, version_id: String) -> Result<Note, AppError> {
    let note = default_store()?.restore_note_version(&id, &version_id)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn reminders_list() -> Result<Vec<Reminder>, AppError> {
    let store = default_store()?;
    reminders::list(store.data_dir())
}

#[tauri::command]
fn reminders_create(
    note_id: String,
    message: String,
    remind_at: chrono::DateTime<chrono::Utc>,
) -> Result<Reminder, AppError> {
    let store = default_store()?;
    reminders::create(store.data_dir(), note_id, message, remind_at)
}

#[tauri::command]
fn reminders_delete(id: String) -> Result<(), AppError> {
    let store = default_store()?;
    reminders::delete(store.data_dir(), &id)
}

/// 前端确认提醒已送达后调用：只有这里才把提醒标记为已通知，
/// 未确认的提醒会由调度器持续重投，避免“先标记后送达”导致提醒丢失。
#[tauri::command]
fn reminders_ack(id: String) -> Result<(), AppError> {
    let store = default_store()?;
    reminders::mark_notified(store.data_dir(), &id)
}

#[tauri::command]
fn notes_import_markdown(
    app: AppHandle,
    path: String,
    category: Option<String>,
) -> Result<Note, AppError> {
    let note = default_store()?
        .import_markdown_file(&PathBuf::from(path), &category.unwrap_or_default())?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_export_markdown(id: String, path: String) -> Result<(), AppError> {
    default_store()?.export_markdown_file(&id, &PathBuf::from(path))
}

#[tauri::command]
fn notes_search(query: String) -> Result<Vec<SearchResult>, AppError> {
    default_store()?.search_content(&query)
}

#[tauri::command]
fn notes_rebuild_search_index() -> Result<(), AppError> {
    default_store()?.rebuild_search_index()
}

#[tauri::command]
fn attachments_add(
    app: AppHandle,
    note_id: String,
    source_path: String,
) -> Result<Attachment, AppError> {
    let attachment = default_store()?.add_attachment(&note_id, &PathBuf::from(source_path))?;
    let _ = app.emit("notes-changed", ());
    Ok(attachment)
}

#[tauri::command]
fn attachments_list(note_id: String) -> Result<Vec<Attachment>, AppError> {
    default_store()?.list_attachments(&note_id)
}

#[tauri::command]
fn attachments_delete(
    app: AppHandle,
    note_id: String,
    attachment_id: String,
) -> Result<(), AppError> {
    default_store()?.delete_attachment(&note_id, &attachment_id)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn attachments_get_path(note_id: String, attachment_id: String) -> Result<String, AppError> {
    default_store()?
        .attachment_path(&note_id, &attachment_id)?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError {
            code: "path".into(),
            message: "invalid attachment path".into(),
            details: Default::default(),
        })
}

#[tauri::command]
fn backups_create(path: String) -> Result<(), AppError> {
    default_store()?.create_backup(&PathBuf::from(path))
}

#[tauri::command]
fn backups_list() -> Result<Vec<BackupInfo>, AppError> {
    default_store()?.list_backups()
}

#[tauri::command]
fn backups_restore(app: AppHandle, path: String) -> Result<(), AppError> {
    default_store()?.restore_backup(&PathBuf::from(path))?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn read_external_file(path: String) -> Result<String, AppError> {
    let path = validate_external_text_path(&path, false)?;
    let bytes = fs::read(path).map_err(|error| io_error(error.to_string()))?;
    decode_external_text_bytes(bytes)
}

/// Return the canonical parent directory for an explicitly opened external
/// document. This command deliberately does not grant that directory to the
/// asset protocol: external images are copied into the app-owned preview cache.
#[tauri::command]
fn external_file_image_base_dir(_app: AppHandle, path: String) -> Result<String, AppError> {
    let file = validate_external_text_path(&path, false)?;
    let canonical_file = fs::canonicalize(&file).map_err(|error| io_error(error.to_string()))?;
    let parent = canonical_file
        .parent()
        .ok_or_else(|| io_error("外部文件没有有效父目录"))?;
    Ok(parent.to_string_lossy().to_string())
}

#[tauri::command]
fn cache_external_markdown_image(
    markdown_path: String,
    image_path: String,
) -> Result<String, AppError> {
    let markdown = validate_external_text_path(&markdown_path, false)?;
    let canonical_markdown =
        fs::canonicalize(&markdown).map_err(|error| io_error(error.to_string()))?;
    let parent = canonical_markdown
        .parent()
        .ok_or_else(|| io_error("外部文件没有有效父目录"))?;

    let requested_image = PathBuf::from(image_path.trim());
    if !requested_image.is_absolute() {
        return Err(io_error("外部图片路径必须是绝对路径"));
    }
    let canonical_image =
        fs::canonicalize(&requested_image).map_err(|error| io_error(error.to_string()))?;
    if !canonical_image.starts_with(parent) {
        return Err(io_error("外部图片必须位于 Markdown 文件所在目录内"));
    }
    validate_image_source_path(&canonical_image.to_string_lossy())?;

    let bytes = fs::read(&canonical_image).map_err(|error| io_error(error.to_string()))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(io_error("单张图片不能超过 50 MB"));
    }
    let extension = canonical_image
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| io_error("外部图片没有有效扩展名"))?;
    let cache_dir = default_store()?.data_dir().join("external-previews");
    fs::create_dir_all(&cache_dir).map_err(|error| io_error(error.to_string()))?;

    let digest = Sha256::digest(&bytes);
    let file_name = format!("{:x}.{}", digest, extension);
    let cached_path = cache_dir.join(file_name);
    if !cached_path.exists() {
        fs::write(&cached_path, bytes).map_err(|error| io_error(error.to_string()))?;
    }
    Ok(cached_path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_file_modified_time(path: String) -> Result<f64, AppError> {
    let path = validate_external_text_path(&path, false)?;
    let modified = fs::metadata(path)
        .map_err(|error| io_error(error.to_string()))?
        .modified()
        .map_err(|error| io_error(error.to_string()))?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(duration.as_secs_f64() * 1000.0)
}

#[tauri::command]
fn save_external_file(path: String, content: String) -> Result<(), AppError> {
    if content.len() > MAX_EXTERNAL_TEXT_BYTES as usize {
        return Err(io_error("外部文本文件不能超过 25 MB"));
    }
    let path = validate_external_text_path(&path, true)?;
    // 文件选择器已选择目标目录；这里不再递归创建任意目录，避免命令被滥用为写入 API。
    fs::write(path, content).map_err(|error| io_error(error.to_string()))
}

fn lock_pdf_sessions(
    state: &PdfExportState,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, PdfExportSession>>, AppError> {
    state
        .sessions
        .lock()
        .map_err(|_| io_error("PDF 导出状态锁已中毒，请重启应用后重试"))
}

fn validate_pdf_job_window(window: &tauri::WebviewWindow, job_id: &str) -> Result<(), AppError> {
    if Uuid::parse_str(job_id).is_err()
        || window.label() != format!("{PDF_EXPORT_WINDOW_PREFIX}{job_id}")
    {
        return Err(io_error("PDF 导出任务标识无效"));
    }
    Ok(())
}

pub(crate) fn abort_pdf_export(app: &AppHandle, job_id: &str) {
    let Some(state) = app.try_state::<PdfExportState>() else {
        return;
    };
    let Ok(mut sessions) = lock_pdf_sessions(&state) else {
        return;
    };
    if let Some(session) = sessions.get_mut(job_id) {
        if let Some(sender) = session.sender.take() {
            let _ = sender.send(Err("PDF 导出窗口意外关闭".into()));
        }
    }
}

#[tauri::command]
fn take_pdf_export(
    window: tauri::WebviewWindow,
    state: State<'_, PdfExportState>,
    job_id: String,
) -> Result<PdfExportRequest, AppError> {
    validate_pdf_job_window(&window, &job_id)?;
    let mut sessions = lock_pdf_sessions(&state)?;
    let session = sessions
        .get_mut(&job_id)
        .ok_or_else(|| io_error("PDF 导出任务不存在或已过期"))?;
    session
        .request
        .take()
        .ok_or_else(|| io_error("PDF 导出任务已被领取"))
}

#[tauri::command]
fn finish_pdf_export(
    window: tauri::WebviewWindow,
    state: State<'_, PdfExportState>,
    job_id: String,
    success: bool,
    error: Option<String>,
) -> Result<(), AppError> {
    validate_pdf_job_window(&window, &job_id)?;
    let mut sessions = lock_pdf_sessions(&state)?;
    let session = sessions
        .get_mut(&job_id)
        .ok_or_else(|| io_error("PDF 导出任务不存在或已过期"))?;
    if let Some(sender) = session.sender.take() {
        let result = if success {
            Ok(())
        } else {
            Err(error.unwrap_or_else(|| "PDF 导出失败".into()))
        };
        let _ = sender.send(result);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_pdf_export(
    window: tauri::WebviewWindow,
    app: AppHandle,
    mut request: PdfExportRequest,
) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(io_error("PDF 导出只能从主窗口发起"));
    }
    let path = validate_pdf_export_path(&request.path)?;
    if request.markdown.len() > MAX_PDF_MARKDOWN_BYTES {
        return Err(io_error("PDF 导出内容不能超过 25 MB"));
    }
    request.path = path.to_string_lossy().into_owned();

    let job_id = Uuid::new_v4().to_string();
    let label = format!("{PDF_EXPORT_WINDOW_PREFIX}{job_id}");
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<PdfExportState>();
        let mut sessions = lock_pdf_sessions(&state)?;
        if !sessions.is_empty() {
            return Err(io_error("PDF 正在导出，请稍候"));
        }
        sessions.insert(
            job_id.clone(),
            PdfExportSession {
                request: Some(request),
                sender: Some(sender),
            },
        );
    }

    let url = format!("index.html?view=pdf-export&jobId={job_id}");
    let window = match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("PDF Export")
        .inner_size(794.0, 1123.0)
        .min_inner_size(794.0, 1123.0)
        .resizable(false)
        .decorations(false)
        .transparent(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .shadow(false)
        .build()
    {
        Ok(window) => window,
        Err(error) => {
            let state = app.state::<PdfExportState>();
            {
                let mut sessions = match lock_pdf_sessions(&state) {
                    Ok(sessions) => sessions,
                    Err(_) => return Err(io_error("PDF 导出状态锁已中毒，请重启应用后重试")),
                };
                sessions.remove(&job_id);
            }
            return Err(io_error(format!("无法创建 PDF 导出窗口: {error}")));
        }
    };

    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(PDF_EXPORT_TIMEOUT_SECS),
        receiver,
    )
    .await
    {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(io_error(message)),
        Ok(Err(_)) => Err(io_error("PDF 导出任务意外结束")),
        Err(_) => Err(io_error("PDF 导出超时")),
    };

    {
        let state = app.state::<PdfExportState>();
        {
            if let Ok(mut sessions) = lock_pdf_sessions(&state) {
                sessions.remove(&job_id);
            };
        }
    }
    let _ = window.destroy();
    result
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn start_pdf_export(_app: AppHandle, _request: PdfExportRequest) -> Result<(), AppError> {
    Err(io_error("当前系统暂不支持直接导出 PDF"))
}

#[cfg(target_os = "windows")]
type PdfExportSender = std::sync::Arc<
    std::sync::Mutex<Option<tokio::sync::oneshot::Sender<std::result::Result<(), String>>>>,
>;

#[cfg(target_os = "windows")]
fn complete_pdf_export(sender: &PdfExportSender, result: std::result::Result<(), String>) {
    if let Ok(mut sender) = sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), AppError> {
    if !window.label().starts_with(PDF_EXPORT_WINDOW_PREFIX) {
        return Err(io_error("PDF 导出只能由专用导出窗口执行"));
    }

    use std::{iter, os::windows::ffi::OsStrExt, sync::Arc, time::Duration};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7},
        PrintToPdfCompletedHandler,
    };
    use windows_core::{Interface, PCWSTR};

    let path = validate_pdf_export_path(&path)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(std::sync::Mutex::new(Some(sender)));
    let dispatch_sender = Arc::clone(&sender);

    window
        .with_webview(move |webview| {
            let callback_sender = Arc::clone(&dispatch_sender);
            let start_result = (|| -> std::result::Result<(), String> {
                let core = unsafe { webview.controller().CoreWebView2() }
                    .map_err(|error| format!("无法获取 WebView2 实例: {error}"))?;
                let core_v7: ICoreWebView2_7 = core
                    .cast()
                    .map_err(|error| format!("当前 WebView2 运行时不支持 PDF 导出: {error}"))?;
                let environment_v6: ICoreWebView2Environment6 = webview
                    .environment()
                    .cast()
                    .map_err(|error| format!("当前 WebView2 运行时不支持打印设置: {error}"))?;
                let settings = unsafe { environment_v6.CreatePrintSettings() }
                    .map_err(|error| format!("无法创建 PDF 打印设置: {error}"))?;

                unsafe {
                    settings
                        .SetShouldPrintBackgrounds(true)
                        .map_err(|error| format!("无法启用 PDF 背景打印: {error}"))?;
                    settings
                        .SetShouldPrintHeaderAndFooter(false)
                        .map_err(|error| format!("无法关闭 PDF 页眉页脚: {error}"))?;
                }

                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |operation_result, succeeded| {
                        let result = operation_result
                            .map_err(|error| format!("PDF 导出失败: {error}"))
                            .and_then(|_| {
                                succeeded
                                    .then_some(())
                                    .ok_or_else(|| "WebView2 未能生成 PDF 文件".to_string())
                            });
                        complete_pdf_export(&callback_sender, result);
                        Ok(())
                    },
                ));
                let wide_path: Vec<u16> = path
                    .as_os_str()
                    .encode_wide()
                    .chain(iter::once(0))
                    .collect();
                unsafe {
                    core_v7
                        .PrintToPdf(PCWSTR(wide_path.as_ptr()), &settings, &handler)
                        .map_err(|error| format!("无法启动 PDF 导出: {error}"))?;
                }
                Ok(())
            })();

            if let Err(error) = start_result {
                complete_pdf_export(&dispatch_sender, Err(error));
            }
        })
        .map_err(|error| io_error(format!("无法访问导出窗口: {error}")))?;

    match tokio::time::timeout(Duration::from_secs(60), receiver).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(io_error(message)),
        Ok(Err(_)) => Err(io_error("PDF 导出任务意外结束")),
        Err(_) => Err(io_error("PDF 导出超时")),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn export_pdf(_window: tauri::WebviewWindow, _path: String) -> Result<(), AppError> {
    Err(io_error("当前系统暂不支持直接导出 PDF"))
}

#[tauri::command]
fn categories_list() -> Result<Vec<String>, AppError> {
    default_store()?.list_categories()
}

#[tauri::command]
fn categories_create(app: AppHandle, name: String) -> Result<(), AppError> {
    default_store()?.create_category(&name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn categories_rename(app: AppHandle, old_name: String, new_name: String) -> Result<(), AppError> {
    default_store()?.rename_category(&old_name, &new_name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn categories_delete(app: AppHandle, name: String) -> Result<(), AppError> {
    default_store()?.delete_category(&name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn notes_move_category(
    app: AppHandle,
    id: String,
    category: String,
) -> Result<NoteMetadata, AppError> {
    let result = default_store()?.move_note_to_category(&id, &category)?;
    let _ = app.emit("notes-changed", ());
    Ok(result)
}

#[tauri::command]
fn images_save(request: tauri::ipc::Request<'_>) -> Result<String, AppError> {
    // 前端以 raw payload 直传图片字节流（noteId / 扩展名走 headers），
    // 避免二进制经 JSON 数字数组序列化的巨大内存与耗时开销
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(AppError {
            code: "invalidPayload".into(),
            message: "images_save expects a raw binary payload".into(),
            details: Default::default(),
        });
    };
    let header = |name: &str| -> Result<String, AppError> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError {
                code: "invalidPayload".into(),
                message: format!("missing {name} header"),
                details: Default::default(),
            })
    };
    if data.len() > MAX_IMAGE_BYTES {
        return Err(AppError {
            code: "imageTooLarge".into(),
            message: "单张图片不能超过 50 MB".into(),
            details: Default::default(),
        });
    }
    let note_id = header("x-note-id")?;
    let extension = header("x-image-ext")?;
    default_store()?.save_image(&note_id, data, &extension)
}

#[tauri::command]
fn images_save_from_path(note_id: String, file_path: String) -> Result<String, AppError> {
    let path = validate_image_source_path(&file_path)?;
    let data = fs::read(&path)?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("png")
        .to_string();
    default_store()?.save_image(&note_id, &data, &extension)
}

#[tauri::command]
fn images_get_base_dir() -> Result<String, AppError> {
    let store = default_store()?;
    store
        .data_dir()
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError {
            code: "path".into(),
            message: "invalid data dir path".into(),
            details: Default::default(),
        })
}

#[tauri::command]
fn images_clean_unused(note_id: String, content: String) -> Result<Vec<String>, AppError> {
    default_store()?.clean_unused_images(&note_id, &content)
}

#[tauri::command]
fn config_get() -> Result<AppConfig, AppError> {
    default_store()?.load_config()
}

#[tauri::command]
fn copy_background_image(_app: AppHandle, source_path: String) -> Result<String, AppError> {
    let source = validate_image_source_path(&source_path).map_err(|error| AppError {
        code: "invalidSource".into(),
        message: error.message,
        details: error.details,
    })?;

    let store = default_store()?;
    let dir = store.data_dir().join("backgrounds");
    fs::create_dir_all(&dir)?;

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("png");
    let dest = dir.join(format!("bg-{}.{}", uuid::Uuid::new_v4(), ext));
    fs::copy(&source, &dest)?;

    // 不删除旧图：config 提交（前端随后 config_save）可能失败，此时配置仍指向
    // 旧图；若先删旧图会丢失背景且不可恢复。旧图作为孤儿文件保留，无害。

    dest.to_str().map(str::to_string).ok_or_else(|| AppError {
        code: "path".into(),
        message: "invalid destination path".into(),
        details: Default::default(),
    })
}

#[tauri::command]
fn config_save(app: AppHandle, config: AppConfig) -> Result<AppConfig, AppError> {
    let store = default_store()?;
    let previous = store.load_config()?;
    desktop::apply_runtime_config(&app, &previous, &config).map_err(|error| {
        match error.downcast::<AppError>() {
            Ok(app_error) => *app_error,
            Err(error) => AppError {
                code: "desktopConfig".into(),
                message: error.to_string(),
                details: Default::default(),
            },
        }
    })?;
    let saved = store.save_config(config)?;
    if let Err(error) = desktop::refresh_shell_state(&app, &saved) {
        eprintln!("failed to refresh desktop shell state: {error}");
    }
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

#[tauri::command]
fn config_migrate_data_dir(app: AppHandle, new_data_dir: String) -> Result<AppConfig, AppError> {
    let store = default_store()?;
    let new_path = PathBuf::from(&new_data_dir).join("floral");
    let new_store = store.migrate_data_to(&new_path)?;

    let scope = app.asset_protocol_scope();
    let _ = fs::create_dir_all(new_path.join("external-previews"));
    let _ = scope.allow_directory(new_path.join("images"), true);
    let _ = scope.allow_directory(new_path.join("backgrounds"), true);
    let _ = scope.allow_directory(new_path.join("external-previews"), true);

    let config = new_store.load_config()?;
    let _ = app.emit("config-changed", &config);
    Ok(config)
}

#[tauri::command]
fn global_shortcut_check(
    app: AppHandle,
    shortcut: String,
) -> Result<desktop::ShortcutCheckResult, AppError> {
    desktop::check_global_shortcut(&app, &shortcut)
}

#[tauri::command]
fn start_shortcut_recording(app: AppHandle) -> Result<(), AppError> {
    desktop::start_shortcut_recording(&app).map_err(|error| AppError {
        code: "shortcutRecording".into(),
        message: error.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
fn stop_shortcut_recording(app: AppHandle) -> Result<(), AppError> {
    desktop::stop_shortcut_recording(&app).map_err(|error| AppError {
        code: "shortcutRecording".into(),
        message: error.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
async fn open_notepad_window(
    app: AppHandle,
    note_id: Option<String>,
    bounds: Option<desktop::WindowBounds>,
) -> Result<String, AppError> {
    desktop::open_notepad_window(app, note_id, bounds).await
}

#[tauri::command]
async fn recycle_notepad_window(app: AppHandle, label: String) -> Result<(), AppError> {
    desktop::recycle_notepad_window(&app, &label)
}

/// Pre-shift the window by `(dx, dy)` logical px before starting an OS drag,
/// so a JS-side deadzone (e.g. tile double-click-to-edit) does not leave the
/// window lagging the cursor by the deadzone displacement.
#[tauri::command]
fn start_window_drag_with_offset(
    window: tauri::WebviewWindow,
    dx: f64,
    dy: f64,
) -> Result<(), AppError> {
    let scale = window.scale_factor()?;
    let pos = window.outer_position()?;
    let next_x = pos.x + (dx * scale).round() as i32;
    let next_y = pos.y + (dy * scale).round() as i32;
    window.set_position(tauri::PhysicalPosition::new(next_x, next_y))?;
    window.start_dragging()?;
    Ok(())
}

#[tauri::command]
async fn open_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<desktop::WindowBounds>,
) -> Result<String, AppError> {
    desktop::open_tile_window(app, note_id, bounds).await
}

#[tauri::command]
async fn toggle_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<desktop::WindowBounds>,
) -> Result<bool, AppError> {
    desktop::toggle_tile_window(app, note_id, bounds).await
}

#[tauri::command]
async fn open_note_in_editor(app: AppHandle, note_id: String) -> Result<(), AppError> {
    desktop::show_main_window(&app)?;
    let _ = app.emit("open-note", &note_id);
    Ok(())
}

#[tauri::command]
fn take_startup_file() -> Option<String> {
    desktop::take_startup_file()
}

fn cli_version_or_help_requested() -> bool {
    env::args().any(|arg| matches!(arg.as_str(), "--version" | "-V" | "--help" | "-h"))
}

#[cfg(windows)]
fn ensure_console() {
    use windows_sys::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            let _ = AllocConsole();
        }
    }
}

#[cfg(not(windows))]
fn ensure_console() {}

fn flush_attached_console_stdout() {
    let _ = std::io::stdout().flush();
}

fn print_cli_version() {
    let _ = writeln!(
        std::io::stdout(),
        "floral-notepaper {}",
        env!("CARGO_PKG_VERSION")
    );
    flush_attached_console_stdout();
}

fn print_cli_help() {
    let _ = writeln!(
        std::io::stdout(),
        "floral-notepaper {}\nFloral Notepaper - lightweight local note app\n\nUSAGE:\n    floral-notepaper [OPTIONS]\n\nOPTIONS:\n    -V, --version\n            Print version\n    -h, --help\n            Print help",
        env!("CARGO_PKG_VERSION"),
    );
    flush_attached_console_stdout();
}

pub fn try_exit_for_cli_version_or_help() {
    if !cli_version_or_help_requested() {
        return;
    }

    ensure_console();

    let wants_version = env::args().any(|arg| arg == "--version" || arg == "-V");
    let wants_help = env::args().any(|arg| arg == "--help" || arg == "-h");

    if wants_version {
        print_cli_version();
        std::process::exit(0);
    }

    if wants_help {
        print_cli_help();
        std::process::exit(0);
    }

    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(file_path) = desktop::extract_file_arg(&args) {
                let _ = app.emit("open-external-file", file_path);
            }
            let _ = desktop::show_main_window(app);
        }))
        .setup(|app| {
            if let Ok(store) = default_store() {
                let data = store.data_dir();
                let scope = app.asset_protocol_scope();
                let _ = fs::remove_dir_all(data.join("external-previews"));
                let _ = fs::create_dir_all(data.join("external-previews"));
                let _ = scope.allow_directory(data.join("images"), true);
                let _ = scope.allow_directory(data.join("backgrounds"), true);
                let _ = scope.allow_directory(data.join("external-previews"), true);
            }
            app.manage(PdfExportState::default());
            let updater_state = updater::UpdaterState::new(app.package_info().version.to_string());
            if let Err(error) = updater_state.initialize() {
                eprintln!("failed to initialize updater infrastructure: {error}");
            }
            app.manage(updater_state);
            updater::start_auto_check_scheduler(app.handle().clone());
            reminder_scheduler::start(app.handle().clone());
            desktop::setup_desktop(app)?;
            Ok(())
        })
        .on_window_event(desktop::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            app_name,
            notes_list,
            notes_get,
            notes_create,
            notes_update,
            notes_delete,
            notes_merge,
            notes_open_daily,
            notes_list_versions,
            notes_restore_version,
            reminders_list,
            reminders_create,
            reminders_delete,
            reminders_ack,
            notes_import_markdown,
            notes_export_markdown,
            notes_search,
            notes_rebuild_search_index,
            attachments_add,
            attachments_list,
            attachments_delete,
            attachments_get_path,
            backups_create,
            backups_list,
            backups_restore,
            notes_move_category,
            read_external_file,
            external_file_image_base_dir,
            cache_external_markdown_image,
            save_external_file,
            start_pdf_export,
            take_pdf_export,
            finish_pdf_export,
            export_pdf,
            get_file_modified_time,
            categories_list,
            categories_create,
            categories_rename,
            categories_delete,
            images_save,
            images_save_from_path,
            images_get_base_dir,
            images_clean_unused,
            config_get,
            copy_background_image,
            config_save,
            config_migrate_data_dir,
            global_shortcut_check,
            start_shortcut_recording,
            stop_shortcut_recording,
            open_notepad_window,
            recycle_notepad_window,
            start_window_drag_with_offset,
            open_tile_window,
            toggle_tile_window,
            open_note_in_editor,
            updater::commands::update_status,
            updater::commands::update_settings_get,
            updater::commands::update_settings_save,
            updater::commands::update_mirror_chyan_cdk_set,
            updater::commands::update_mirror_chyan_cdk_clear,
            updater::commands::update_mirror_chyan_cdk_get,
            updater::commands::update_check,
            updater::commands::update_download,
            updater::commands::update_install,
            updater::commands::update_install_prepare_report,
            updater::commands::update_cancel,
            take_startup_file,
            window_main_close_finished
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = _event
            {
                if !has_visible_windows {
                    if let Err(error) = desktop::show_main_window(_app_handle) {
                        eprintln!("failed to show main window on dock click: {error}");
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::decode_external_text_bytes;

    #[test]
    fn decodes_utf8_and_removes_its_bom() {
        assert_eq!(
            decode_external_text_bytes(vec![0xef, 0xbb, 0xbf, b'h', b'i']).expect("decode UTF-8"),
            "hi"
        );
    }

    #[test]
    fn decodes_utf16_text_with_bom() {
        let mut bytes = vec![0xff, 0xfe];
        for unit in "你好".encode_utf16() {
            bytes.extend(unit.to_le_bytes());
        }

        assert_eq!(
            decode_external_text_bytes(bytes).expect("decode UTF-16LE"),
            "你好"
        );
    }

    #[test]
    fn decodes_utf16be_text_with_bom() {
        let mut bytes = vec![0xfe, 0xff];
        for unit in "你好".encode_utf16() {
            bytes.extend(unit.to_be_bytes());
        }

        assert_eq!(
            decode_external_text_bytes(bytes).expect("decode UTF-16BE"),
            "你好"
        );
    }

    #[test]
    fn falls_back_to_gbk_for_legacy_windows_txt() {
        assert_eq!(
            decode_external_text_bytes(vec![0xc4, 0xe3, 0xba, 0xc3]).expect("decode GBK"),
            "你好"
        );
    }
}
