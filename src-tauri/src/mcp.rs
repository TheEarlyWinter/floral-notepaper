//! MCP (Model Context Protocol) stdio server over newline-delimited JSON-RPC 2.0.
//!
//! IMPORTANT: On Windows, the binary uses `windows_subsystem = "windows"`.
//! In `--mcp` mode we MUST NEVER allocate/attach a console (`ensure_console`)
//! and MUST write ONLY `\n`-delimited JSON-RPC 2.0 responses to `stdout`.
//! Any diagnostics must go exclusively to `stderr`.

use crate::cli::{
    append_note_operation, create_reminder_checked, delete_note_with_sync,
    delete_reminder_with_sync, enqueue_pin_tile, open_daily_with_sync, resolve_pin_tile_ttl,
};
use crate::external_sync::{self, ExternalActivitySource};
use crate::services::notes::{
    default_store, validate_note_id, AppError, NoteStore, SaveNoteRequest,
};
use crate::services::reminders;
use crate::services::todos::{self, TodoFilter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, BufWriter, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "floral-notepaper";

const ERR_PARSE: i64 = -32700;
const ERR_INVALID_REQUEST: i64 = -32600;
const ERR_METHOD_NOT_FOUND: i64 = -32601;
const ERR_INVALID_PARAMS: i64 = -32602;
const ERR_RESOURCE_NOT_FOUND: i64 = -32002;

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

impl JsonRpcResponse {
    fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn err(id: Value, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolContent {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallResult {
    content: Vec<ToolContent>,
    is_error: bool,
}

impl ToolCallResult {
    fn success_json(value: &impl Serialize) -> Result<Value, String> {
        let pretty = serde_json::to_string_pretty(value)
            .map_err(|e| format!("JSON serialize failed: {e}"))?;
        let payload = Self {
            content: vec![ToolContent {
                kind: "text",
                text: pretty,
            }],
            is_error: false,
        };
        serde_json::to_value(payload).map_err(|e| format!("JSON serialize failed: {e}"))
    }

    fn error_text(message: impl Into<String>) -> Value {
        json!({
            "content": [{
                "type": "text",
                "text": message.into()
            }],
            "isError": true
        })
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListNotesArgs {
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    pinned: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteIdArg {
    #[serde(alias = "noteId", alias = "note_id")]
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchNotesArgs {
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNoteArgs {
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendNoteArgs {
    #[serde(alias = "target", alias = "noteId", alias = "note_id")]
    id: String,
    content: String,
    #[serde(default)]
    separator: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateNoteArgs {
    #[serde(alias = "noteId", alias = "note_id")]
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    pinned: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListTodosArgs {
    #[serde(default, alias = "filter")]
    status: Option<String>,
    #[serde(default, alias = "note_id")]
    note_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleTodoArgs {
    #[serde(alias = "note_id")]
    note_id: String,
    index: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateReminderArgs {
    #[serde(alias = "note_id")]
    note_id: String,
    #[serde(alias = "remind_at", alias = "at")]
    remind_at: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteReminderArgs {
    #[serde(alias = "reminderId", alias = "reminder_id")]
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinTileArgs {
    #[serde(alias = "note_id", alias = "id")]
    note_id: String,
    #[serde(default, alias = "ttl_secs")]
    ttl_secs: Option<u64>,
    #[serde(default)]
    persist: bool,
}

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_notes",
            "description": "List notes metadata with optional category, tag, or pinned filters.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "category": { "type": "string", "description": "Optional exact category filter." },
                    "tag": { "type": "string", "description": "Optional exact tag filter." },
                    "pinned": { "type": "boolean", "description": "Optional pinned status filter." }
                }
            }
        },
        {
            "name": "get_note",
            "description": "Get full content and metadata of a note by ID.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note ID." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "search_notes",
            "description": "Search notes by title and Markdown body content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query text." }
                },
                "required": ["query"]
            }
        },
        {
            "name": "create_note",
            "description": "Create a new note with title, optional Markdown content, category, tags, and pinned flag.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Non-empty note title." },
                    "content": { "type": "string", "description": "Markdown body content." },
                    "category": { "type": "string", "description": "Optional category name." },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional list of tags."
                    },
                    "pinned": { "type": "boolean", "description": "Whether the note is pinned." }
                },
                "required": ["title"]
            }
        },
        {
            "name": "append_note",
            "description": "Append content to an existing note by ID or to today's daily note ('daily').",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Target note ID or 'daily'." },
                    "content": { "type": "string", "description": "Markdown content to append." },
                    "separator": { "type": "string", "description": "Optional separator inserted before appended text (defaults to '\\n')." }
                },
                "required": ["id", "content"]
            }
        },
        {
            "name": "update_note",
            "description": "Partially update a note while preserving any unspecified fields.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note ID." },
                    "title": { "type": "string", "description": "Updated title." },
                    "content": { "type": "string", "description": "Updated Markdown content." },
                    "category": { "type": "string", "description": "Updated category name." },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Updated tags list."
                    },
                    "pinned": { "type": "boolean", "description": "Updated pinned flag." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "delete_note",
            "description": "Delete a note (moves Markdown file to trash and removes associated reminders).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note ID." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "open_daily_note",
            "description": "Open today's daily note, creating it if it does not already exist.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "list_todos",
            "description": "List Markdown GFM task list items across notes or for a single note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["all", "pending", "done"],
                        "description": "Filter by task completion status (default 'all')."
                    },
                    "noteId": { "type": "string", "description": "Optional note ID filter." }
                }
            }
        },
        {
            "name": "toggle_todo",
            "description": "Toggle a Markdown task item by its 0-based index within a note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "noteId": { "type": "string", "description": "Note ID." },
                    "index": { "type": "integer", "minimum": 0, "description": "0-based task index within the note." }
                },
                "required": ["noteId", "index"]
            }
        },
        {
            "name": "list_reminders",
            "description": "List all scheduled reminders sorted by remindAt.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "create_reminder",
            "description": "Create a timed reminder for an existing note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "noteId": { "type": "string", "description": "Target note ID." },
                    "remindAt": { "type": "string", "description": "RFC3339 timestamp (e.g. '2026-12-01T09:00:00Z')." },
                    "message": { "type": "string", "description": "Reminder message." }
                },
                "required": ["noteId", "remindAt", "message"]
            }
        },
        {
            "name": "delete_reminder",
            "description": "Delete a reminder by ID.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Reminder ID." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "pin_tile",
            "description": "Queue a request for the running GUI to pin a note as a desktop tile.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "noteId": { "type": "string", "description": "Note ID." },
                    "ttlSecs": { "type": "integer", "minimum": 0, "description": "Optional TTL in seconds before the queued pin_tile command expires (default 300; 0 disables expiry)." },
                    "persist": { "type": "boolean", "description": "Set true to keep the queued pin_tile command without TTL expiry." }
                },
                "required": ["noteId"]
            }
        }
    ])
}

pub fn resource_definitions() -> Value {
    json!([
        {
            "uri": "floral://daily",
            "name": "Today's Daily Note",
            "description": "Markdown content of today's daily note (created if missing).",
            "mimeType": "text/markdown"
        },
        {
            "uri": "floral://todos/pending",
            "name": "Pending Todos",
            "description": "All pending Markdown GFM task list items across notes as JSON.",
            "mimeType": "application/json"
        },
        {
            "uri": "floral://notes",
            "name": "All Notes Metadata",
            "description": "Metadata list for all notes sorted by updated time as JSON.",
            "mimeType": "application/json"
        }
    ])
}

pub fn resource_template_definitions() -> Value {
    json!([
        {
            "uriTemplate": "floral://note/{id}",
            "name": "Note by ID",
            "description": "Markdown content of a single note identified by its ID.",
            "mimeType": "text/markdown"
        }
    ])
}

fn parse_tool_args<T: for<'de> Deserialize<'de>>(args: Value, tool: &str) -> Result<T, String> {
    serde_json::from_value(args)
        .map_err(|err| format!("Invalid arguments for tool '{tool}': {err}"))
}

fn execute_tool(
    name: &str,
    raw_args: Value,
    store_provider: &impl Fn() -> Result<NoteStore, AppError>,
) -> Result<Value, JsonRpcError> {
    let known = matches!(
        name,
        "list_notes"
            | "get_note"
            | "search_notes"
            | "create_note"
            | "append_note"
            | "update_note"
            | "delete_note"
            | "open_daily_note"
            | "list_todos"
            | "toggle_todo"
            | "list_reminders"
            | "create_reminder"
            | "delete_reminder"
            | "pin_tile"
    );
    if !known {
        return Err(JsonRpcError {
            code: ERR_INVALID_PARAMS,
            message: format!("Unknown tool: {name}"),
        });
    }

    match name {
        "list_notes" => {
            let args: ListNotesArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body_logged(
                store_provider,
                name,
                "notes",
                |store| {
                    let mut notes = store.list_notes()?;
                    if let Some(ref cat) = args.category {
                        notes.retain(|n| n.category == *cat);
                    }
                    if let Some(ref tag) = args.tag {
                        notes.retain(|n| n.tags.iter().any(|t| t == tag));
                    }
                    if let Some(pinned) = args.pinned {
                        notes.retain(|n| n.pinned == pinned);
                    }
                    let count = notes.len();
                    Ok((
                        json!({ "count": count, "notes": notes }),
                        "notes".into(),
                        format!("{count} notes"),
                    ))
                },
            ))
        }
        "get_note" => {
            let args: NoteIdArg = parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                code: ERR_INVALID_PARAMS,
                message: msg,
            })?;
            let default_target = args.id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let note = store.read_note(&args.id)?;
                    let summary =
                        format!("{} ({} chars)", note.title, note.content.chars().count());
                    Ok((note, args.id.clone(), summary))
                },
            ))
        }
        "search_notes" => {
            let args: SearchNotesArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let default_target = args.query.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let results = store.search_content(&args.query)?;
                    let count = results.len();
                    Ok((
                        json!({
                            "query": args.query,
                            "count": count,
                            "results": results
                        }),
                        args.query.clone(),
                        format!("{count} results"),
                    ))
                },
            ))
        }
        "create_note" => {
            let args: CreateNoteArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let default_target = args.title.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    if args.title.trim().is_empty() {
                        return Err(AppError {
                            code: "invalidTitle".into(),
                            message: "title cannot be empty".into(),
                            details: Default::default(),
                        });
                    }
                    let content_len = args.content.chars().count();
                    let note = store.create_note(SaveNoteRequest {
                        title: args.title,
                        content: args.content,
                        category: args.category,
                        tags: args.tags,
                        pinned: args.pinned,
                    })?;
                    external_sync::touch_external_rev(store.data_dir())?;
                    let target = note.id.clone();
                    let summary = format!("created '{}' ({content_len} chars)", note.title);
                    Ok((note, target, summary))
                },
            ))
        }
        "append_note" => {
            let args: AppendNoteArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let default_target = args.id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let added_len = args.content.chars().count();
                    let updated = append_note_operation(
                        store,
                        &args.id,
                        &args.content,
                        args.separator.as_deref(),
                    )?;
                    let target = updated.id.clone();
                    let summary = format!("appended +{added_len} chars to '{}'", updated.title);
                    Ok((updated, target, summary))
                },
            ))
        }
        "update_note" => {
            let args: UpdateNoteArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            if args.title.is_none()
                && args.content.is_none()
                && args.category.is_none()
                && args.tags.is_none()
                && args.pinned.is_none()
            {
                return Err(JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: "update_note requires at least one field to update".into(),
                });
            }
            let default_target = args.id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let existing = store.read_note(&args.id)?;
                    let updated = store.update_note(
                        &args.id,
                        SaveNoteRequest {
                            title: args.title.unwrap_or(existing.title),
                            content: args.content.unwrap_or(existing.content),
                            category: args.category.unwrap_or(existing.category),
                            tags: args.tags.unwrap_or(existing.tags),
                            pinned: args.pinned.unwrap_or(existing.pinned),
                        },
                    )?;
                    external_sync::touch_external_rev(store.data_dir())?;
                    let summary = format!("updated '{}'", updated.title);
                    Ok((updated, args.id.clone(), summary))
                },
            ))
        }
        "delete_note" => {
            let args: NoteIdArg = parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                code: ERR_INVALID_PARAMS,
                message: msg,
            })?;
            let default_target = args.id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    delete_note_with_sync(store, &args.id)?;
                    Ok((
                        json!({ "deleted": true, "id": args.id }),
                        args.id.clone(),
                        "deleted note".into(),
                    ))
                },
            ))
        }
        "open_daily_note" => {
            // Accept empty object without extra strictness
            Ok(run_tool_body_logged(
                store_provider,
                name,
                "daily",
                |store| {
                    let note = open_daily_with_sync(store)?;
                    let target = note.id.clone();
                    let summary = format!("daily {}", note.title);
                    Ok((note, target, summary))
                },
            ))
        }
        "list_todos" => {
            let args: ListTodosArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let filter = match args.status.as_deref() {
                None | Some("all") => TodoFilter::All,
                Some("pending") => TodoFilter::Pending,
                Some("done") => TodoFilter::Done,
                Some(other) => {
                    return Err(JsonRpcError {
                        code: ERR_INVALID_PARAMS,
                        message: format!(
                            "Invalid status '{other}' for list_todos (expected 'all', 'pending', or 'done')"
                        ),
                    });
                }
            };
            let default_target = args.note_id.clone().unwrap_or_else(|| "all".into());
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let items = todos::list_todos(store, filter, args.note_id.as_deref())?;
                    let count = items.len();
                    let target = args.note_id.clone().unwrap_or_else(|| "all".into());
                    Ok((
                        json!({ "count": count, "todos": items }),
                        target,
                        format!("{count} todos"),
                    ))
                },
            ))
        }
        "toggle_todo" => {
            let args: ToggleTodoArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let default_target = format!("{}#{}", args.note_id, args.index);
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let item = todos::toggle_todo(store, &args.note_id, args.index)?;
                    external_sync::touch_external_rev(store.data_dir())?;
                    let summary = format!("done={}", item.done);
                    Ok((item, format!("{}#{}", args.note_id, args.index), summary))
                },
            ))
        }
        "list_reminders" => Ok(run_tool_body_logged(
            store_provider,
            name,
            "reminders",
            |store| {
                let list = reminders::list(store.data_dir())?;
                let count = list.len();
                Ok((
                    json!({ "count": count, "reminders": list }),
                    "reminders".into(),
                    format!("{count} reminders"),
                ))
            },
        )),
        "create_reminder" => {
            let args: CreateReminderArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let default_target = args.note_id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let reminder = create_reminder_checked(
                        store,
                        &args.note_id,
                        &args.remind_at,
                        &args.message,
                    )?;
                    let summary = format!("reminder at {}", args.remind_at);
                    Ok((reminder, args.note_id.clone(), summary))
                },
            ))
        }
        "delete_reminder" => {
            let args: DeleteReminderArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let default_target = args.id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    delete_reminder_with_sync(store, &args.id)?;
                    Ok((
                        json!({ "deleted": true, "id": args.id }),
                        args.id.clone(),
                        "deleted reminder".into(),
                    ))
                },
            ))
        }
        "pin_tile" => {
            let args: PinTileArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            let ttl_secs = resolve_pin_tile_ttl(args.ttl_secs, args.persist);
            let default_target = args.note_id.clone();
            Ok(run_tool_body_logged(
                store_provider,
                name,
                &default_target,
                |store| {
                    let note_id = enqueue_pin_tile(store, &args.note_id, ttl_secs)?;
                    let persist = ttl_secs.is_none();
                    let summary = match ttl_secs {
                        Some(ttl) => format!("pin_tile ttl={ttl}s"),
                        None => "pin_tile persist".into(),
                    };
                    Ok((
                        json!({
                            "queued": true,
                            "command": "pin_tile",
                            "noteId": note_id,
                            "ttlSecs": ttl_secs,
                            "persist": persist
                        }),
                        note_id,
                        summary,
                    ))
                },
            ))
        }
        _ => unreachable!(),
    }
}

fn run_tool_body_logged<T: Serialize>(
    store_provider: &impl Fn() -> Result<NoteStore, AppError>,
    action: &str,
    default_target: &str,
    f: impl FnOnce(&NoteStore) -> Result<(T, String, String), AppError>,
) -> Value {
    match store_provider() {
        Ok(store) => match f(&store) {
            Ok((data, target, summary)) => {
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    action,
                    &target,
                    &summary,
                    true,
                );
                match ToolCallResult::success_json(&data) {
                    Ok(value) => value,
                    Err(err) => ToolCallResult::error_text(err),
                }
            }
            Err(err) => {
                let err_msg = err.to_string();
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    action,
                    default_target,
                    &err_msg,
                    false,
                );
                ToolCallResult::error_text(err_msg)
            }
        },
        Err(err) => ToolCallResult::error_text(err.to_string()),
    }
}

fn resource_content(uri: &str, mime_type: &str, text: String) -> Value {
    json!({
        "contents": [{
            "uri": uri,
            "mimeType": mime_type,
            "text": text
        }]
    })
}

fn execute_resource_read(
    uri: &str,
    store_provider: &impl Fn() -> Result<NoteStore, AppError>,
) -> Result<Value, JsonRpcError> {
    let store = store_provider().map_err(|err| JsonRpcError {
        code: ERR_INVALID_PARAMS,
        message: err.to_string(),
    })?;

    match uri {
        "floral://daily" => match open_daily_with_sync(&store) {
            Ok(note) => {
                let summary = format!(
                    "daily {} ({} chars)",
                    note.title,
                    note.content.chars().count()
                );
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &summary,
                    true,
                );
                Ok(resource_content(uri, "text/markdown", note.content))
            }
            Err(err) => {
                let msg = err.to_string();
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &msg,
                    false,
                );
                Err(JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })
            }
        },
        "floral://todos/pending" => match todos::list_todos(&store, TodoFilter::Pending, None) {
            Ok(items) => {
                let count = items.len();
                let payload = json!({ "count": count, "todos": items });
                let text = serde_json::to_string_pretty(&payload).map_err(|err| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: format!("JSON serialize failed: {err}"),
                })?;
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &format!("{count} pending todos"),
                    true,
                );
                Ok(resource_content(uri, "application/json", text))
            }
            Err(err) => {
                let msg = err.to_string();
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &msg,
                    false,
                );
                Err(JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })
            }
        },
        "floral://notes" => match store.list_notes() {
            Ok(notes) => {
                let count = notes.len();
                let payload = json!({ "count": count, "notes": notes });
                let text = serde_json::to_string_pretty(&payload).map_err(|err| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: format!("JSON serialize failed: {err}"),
                })?;
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &format!("{count} notes"),
                    true,
                );
                Ok(resource_content(uri, "application/json", text))
            }
            Err(err) => {
                let msg = err.to_string();
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &msg,
                    false,
                );
                Err(JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })
            }
        },
        _ => {
            if let Some(note_id) = uri.strip_prefix("floral://note/") {
                if note_id.is_empty()
                    || note_id.contains('?')
                    || note_id.contains('#')
                    || validate_note_id(note_id).is_err()
                {
                    let msg = format!("Invalid note resource URI: {uri}");
                    external_sync::record_activity_best_effort(
                        store.data_dir(),
                        ExternalActivitySource::Mcp,
                        "resources/read",
                        uri,
                        &msg,
                        false,
                    );
                    return Err(JsonRpcError {
                        code: ERR_INVALID_PARAMS,
                        message: msg,
                    });
                }

                match store.read_note(note_id) {
                    Ok(note) => {
                        let summary = format!(
                            "note '{}' ({} chars)",
                            note.title,
                            note.content.chars().count()
                        );
                        external_sync::record_activity_best_effort(
                            store.data_dir(),
                            ExternalActivitySource::Mcp,
                            "resources/read",
                            uri,
                            &summary,
                            true,
                        );
                        Ok(resource_content(uri, "text/markdown", note.content))
                    }
                    Err(err) => {
                        let msg = format!("Resource not found '{uri}': {err}");
                        external_sync::record_activity_best_effort(
                            store.data_dir(),
                            ExternalActivitySource::Mcp,
                            "resources/read",
                            uri,
                            &msg,
                            false,
                        );
                        let code = if err.code == "noteNotFound" {
                            ERR_RESOURCE_NOT_FOUND
                        } else {
                            ERR_INVALID_PARAMS
                        };
                        Err(JsonRpcError { code, message: msg })
                    }
                }
            } else {
                let msg = format!("Unknown or invalid resource URI: {uri}");
                external_sync::record_activity_best_effort(
                    store.data_dir(),
                    ExternalActivitySource::Mcp,
                    "resources/read",
                    uri,
                    &msg,
                    false,
                );
                Err(JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })
            }
        }
    }
}

pub(crate) fn handle_line(
    line: &str,
    store_provider: &impl Fn() -> Result<NoteStore, AppError>,
) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let request: Value = match serde_json::from_str(trimmed) {
        Ok(val) => val,
        Err(err) => {
            return Some(
                serde_json::to_value(JsonRpcResponse::err(
                    Value::Null,
                    ERR_PARSE,
                    format!("Parse error: {err}"),
                ))
                .expect("serialize json-rpc parse error"),
            );
        }
    };

    let Some(obj) = request.as_object() else {
        return Some(
            serde_json::to_value(JsonRpcResponse::err(
                Value::Null,
                ERR_INVALID_REQUEST,
                "Invalid Request: expected JSON object",
            ))
            .expect("serialize invalid request"),
        );
    };

    let raw_id = obj.get("id").cloned();
    let is_notification = matches!(raw_id, None | Some(Value::Null));

    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        let id = raw_id.unwrap_or(Value::Null);
        return Some(
            serde_json::to_value(JsonRpcResponse::err(
                id,
                ERR_INVALID_REQUEST,
                "Invalid Request: jsonrpc must be '2.0'",
            ))
            .expect("serialize invalid jsonrpc version"),
        );
    }

    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        let id = raw_id.unwrap_or(Value::Null);
        return Some(
            serde_json::to_value(JsonRpcResponse::err(
                id,
                ERR_INVALID_REQUEST,
                "Invalid Request: missing string 'method'",
            ))
            .expect("serialize missing method"),
        );
    };

    // Notifications (id missing or null) must NEVER emit a response.
    if is_notification {
        return None;
    }

    let id = raw_id.unwrap_or(Value::Null);
    let params = obj.get("params").cloned();

    let response = match method {
        "initialize" => JsonRpcResponse::ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {},
                    "resources": {}
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        ),
        "notifications/initialized" => JsonRpcResponse::ok(id, json!({})),
        "ping" => JsonRpcResponse::ok(id, json!({})),
        "tools/list" => JsonRpcResponse::ok(
            id,
            json!({
                "tools": tool_definitions()
            }),
        ),
        "tools/call" => {
            let Some(params_obj) = params.as_ref().and_then(Value::as_object) else {
                return Some(
                    serde_json::to_value(JsonRpcResponse::err(
                        id,
                        ERR_INVALID_PARAMS,
                        "Invalid params: expected params object",
                    ))
                    .expect("serialize invalid params"),
                );
            };
            let Some(tool_name) = params_obj
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return Some(
                    serde_json::to_value(JsonRpcResponse::err(
                        id,
                        ERR_INVALID_PARAMS,
                        "Invalid params: missing tool 'name'",
                    ))
                    .expect("serialize missing tool name"),
                );
            };
            let arguments = match params_obj.get("arguments") {
                None | Some(Value::Null) => json!({}),
                Some(Value::Object(map)) => Value::Object(map.clone()),
                Some(_) => {
                    return Some(
                        serde_json::to_value(JsonRpcResponse::err(
                            id,
                            ERR_INVALID_PARAMS,
                            "Invalid params: 'arguments' must be an object",
                        ))
                        .expect("serialize invalid arguments"),
                    );
                }
            };
            match execute_tool(tool_name, arguments, store_provider) {
                Ok(result) => JsonRpcResponse::ok(id, result),
                Err(rpc_err) => JsonRpcResponse::err(id, rpc_err.code, rpc_err.message),
            }
        }
        "resources/list" => JsonRpcResponse::ok(
            id,
            json!({
                "resources": resource_definitions()
            }),
        ),
        "resources/templates/list" => JsonRpcResponse::ok(
            id,
            json!({
                "resourceTemplates": resource_template_definitions()
            }),
        ),
        "resources/read" => {
            let Some(params_obj) = params.as_ref().and_then(Value::as_object) else {
                return Some(
                    serde_json::to_value(JsonRpcResponse::err(
                        id,
                        ERR_INVALID_PARAMS,
                        "Invalid params: expected params object",
                    ))
                    .expect("serialize invalid params"),
                );
            };
            let Some(uri) = params_obj
                .get("uri")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return Some(
                    serde_json::to_value(JsonRpcResponse::err(
                        id,
                        ERR_INVALID_PARAMS,
                        "Invalid params: missing string 'uri'",
                    ))
                    .expect("serialize missing resource uri"),
                );
            };
            match execute_resource_read(uri, store_provider) {
                Ok(result) => JsonRpcResponse::ok(id, result),
                Err(rpc_err) => JsonRpcResponse::err(id, rpc_err.code, rpc_err.message),
            }
        }
        other => JsonRpcResponse::err(
            id,
            ERR_METHOD_NOT_FOUND,
            format!("Method not found: {other}"),
        ),
    };

    Some(serde_json::to_value(response).expect("serialize json-rpc response"))
}

pub(crate) fn serve_stdio<R: BufRead, W: Write>(
    mut reader: R,
    writer: &mut W,
    store_provider: impl Fn() -> Result<NoteStore, AppError>,
) -> io::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        if let Some(response) = handle_line(&line, &store_provider) {
            let serialized = serde_json::to_string(&response).map_err(io::Error::other)?;
            writeln!(writer, "{serialized}")?;
            writer.flush()?;
        }
    }
    Ok(())
}

pub fn run_stdio() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    if let Err(err) = serve_stdio(reader, &mut writer, default_store) {
        eprintln!("[floral-notepaper mcp] stdio error: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_store_root() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("floral-mcp-test-{}", Uuid::new_v4()));
        let config_dir = root.join("config");
        let data_dir = root.join("data");
        fs::create_dir_all(&config_dir).expect("create config dir");
        fs::create_dir_all(&data_dir).expect("create data dir");
        (root, config_dir, data_dir)
    }

    fn call_line(line: &str, config_dir: &PathBuf, data_dir: &PathBuf) -> Option<Value> {
        handle_line(line, &|| {
            Ok(NoteStore::new(config_dir.clone(), data_dir.clone()))
        })
    }

    #[test]
    fn framing_handles_initialize_notifications_ping_and_errors() {
        let (root, config_dir, data_dir) = temp_store_root();
        let input = concat!(
            "\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\"}}\r\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"notifications/cancelled\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"nonexistent/method\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"unknown_tool\"}}\n",
            "{bad json\n"
        );

        let mut out = Vec::new();
        serve_stdio(Cursor::new(input.as_bytes()), &mut out, || {
            Ok(NoteStore::new(config_dir.clone(), data_dir.clone()))
        })
        .expect("serve stdio");

        let output = String::from_utf8(out).expect("utf8 output");
        let lines: Vec<&str> = output.lines().collect();
        // 5 responses (notifications & blank line emit nothing)
        assert_eq!(lines.len(), 5);

        let init: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(init["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(init["result"]["capabilities"]["resources"], json!({}));
        assert_eq!(init["result"]["serverInfo"]["name"], "floral-notepaper");
        assert_eq!(
            init["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );

        let ping: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(ping["id"], 2);
        assert_eq!(ping["result"], json!({}));

        let unknown_method: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(unknown_method["id"], 3);
        assert_eq!(unknown_method["error"]["code"], -32601);

        let unknown_tool: Value = serde_json::from_str(lines[3]).unwrap();
        assert_eq!(unknown_tool["id"], 4);
        assert_eq!(unknown_tool["error"]["code"], -32602);

        let parse_err: Value = serde_json::from_str(lines[4]).unwrap();
        assert_eq!(parse_err["id"], Value::Null);
        assert_eq!(parse_err["error"]["code"], -32700);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tools_list_exposes_all_fourteen_tools() {
        let (root, config_dir, data_dir) = temp_store_root();
        let resp = call_line(
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/list"}"#,
            &config_dir,
            &data_dir,
        )
        .expect("tools/list response");

        let tools = resp["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "list_notes",
                "get_note",
                "search_notes",
                "create_note",
                "append_note",
                "update_note",
                "delete_note",
                "open_daily_note",
                "list_todos",
                "toggle_todo",
                "list_reminders",
                "create_reminder",
                "delete_reminder",
                "pin_tile",
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    fn parse_tool_payload(resp: &Value) -> Value {
        assert_eq!(resp["result"]["isError"], false);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn tools_call_exercises_all_tools_and_error_cases() {
        let (root, config_dir, data_dir) = temp_store_root();

        // 1. create_note
        let created_resp = call_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"MCP Note","content":"- [ ] First\n- [x] Second","category":"lab","tags":["mcp"],"pinned":true}}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        let created = parse_tool_payload(&created_resp);
        let note_id = created["id"].as_str().unwrap().to_string();
        assert_eq!(
            external_sync::read_external_rev(&data_dir)
                .unwrap()
                .as_deref(),
            Some("1")
        );

        // 2. list_notes
        let list_resp = call_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_notes","arguments":{"tag":"mcp"}}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        let list_data = parse_tool_payload(&list_resp);
        assert_eq!(list_data["count"], 1);

        // 3. get_note
        let get_req = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_note","arguments":{"id": note_id}}});
        let get_resp = call_line(&get_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&get_resp)["title"], "MCP Note");

        // 4. search_notes
        let search_resp = call_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"First"}}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(parse_tool_payload(&search_resp)["count"], 1);

        // 5. append_note
        let append_req = json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"append_note","arguments":{"id": note_id, "content": "- [ ] Third"}}});
        let append_resp = call_line(&append_req.to_string(), &config_dir, &data_dir).unwrap();
        assert!(parse_tool_payload(&append_resp)["content"]
            .as_str()
            .unwrap()
            .contains("Third"));

        // 6. update_note
        let update_req = json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"update_note","arguments":{"id": note_id, "pinned": false}}});
        let update_resp = call_line(&update_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&update_resp)["pinned"], false);

        // 7. open_daily_note
        let daily_resp = call_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"open_daily_note"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert!(parse_tool_payload(&daily_resp)["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "daily"));

        // 8. list_todos & 9. toggle_todo
        let todos_req = json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"list_todos","arguments":{"status":"pending","noteId": note_id}}});
        let todos_resp = call_line(&todos_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&todos_resp)["count"], 2);

        let toggle_req = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"toggle_todo","arguments":{"noteId": note_id, "index": 0}}});
        let toggle_resp = call_line(&toggle_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&toggle_resp)["done"], true);

        // 10. create_reminder, 11. list_reminders, 12. delete_reminder
        let cr_req = json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"create_reminder","arguments":{"noteId": note_id, "remindAt": "2099-05-01T12:00:00Z", "message": "Ping"}}});
        let cr_resp = call_line(&cr_req.to_string(), &config_dir, &data_dir).unwrap();
        let rem_id = parse_tool_payload(&cr_resp)["id"]
            .as_str()
            .unwrap()
            .to_string();

        let lr_resp = call_line(
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"list_reminders","arguments":{}}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(parse_tool_payload(&lr_resp)["count"], 1);

        let dr_req = json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"delete_reminder","arguments":{"id": rem_id}}});
        let dr_resp = call_line(&dr_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&dr_resp)["deleted"], true);

        // 13. pin_tile (default TTL 300s, ttl_secs: 0 -> persist, persist: true -> persist)
        let pin_req = json!({"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"pin_tile","arguments":{"noteId": note_id}}});
        let pin_resp = call_line(&pin_req.to_string(), &config_dir, &data_dir).unwrap();
        let pin_payload = parse_tool_payload(&pin_resp);
        assert_eq!(pin_payload["queued"], true);
        assert_eq!(pin_payload["ttlSecs"], 300);
        assert_eq!(pin_payload["persist"], false);

        let pin_zero_req = json!({"jsonrpc":"2.0","id":130,"method":"tools/call","params":{"name":"pin_tile","arguments":{"noteId": note_id, "ttl_secs": 0}}});
        let pin_zero_resp = call_line(&pin_zero_req.to_string(), &config_dir, &data_dir).unwrap();
        let pin_zero_payload = parse_tool_payload(&pin_zero_resp);
        assert_eq!(pin_zero_payload["ttlSecs"], Value::Null);
        assert_eq!(pin_zero_payload["persist"], true);

        let pin_persist_req = json!({"jsonrpc":"2.0","id":131,"method":"tools/call","params":{"name":"pin_tile","arguments":{"noteId": note_id, "persist": true}}});
        let pin_persist_resp =
            call_line(&pin_persist_req.to_string(), &config_dir, &data_dir).unwrap();
        let pin_persist_payload = parse_tool_payload(&pin_persist_resp);
        assert_eq!(pin_persist_payload["ttlSecs"], Value::Null);
        assert_eq!(pin_persist_payload["persist"], true);

        assert_eq!(external_sync::drain_commands(&data_dir).unwrap().len(), 3);

        // 14. delete_note
        let del_req = json!({"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"delete_note","arguments":{"id": note_id}}});
        let del_resp = call_line(&del_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&del_resp)["deleted"], true);

        // Execution error returns MCP isError: true
        let err_req = json!({"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"get_note","arguments":{"id": note_id}}});
        let err_resp = call_line(&err_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(err_resp["result"]["isError"], true);

        // Missing required argument returns -32602
        let bad_params_resp = call_line(
            r#"{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"get_note","arguments":{}}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(bad_params_resp["error"]["code"], -32602);

        // Activity log recorded MCP actions without dumping full note body
        let activity = external_sync::list_activity(&data_dir).unwrap();
        assert!(!activity.is_empty());
        assert_eq!(activity[0].source, ExternalActivitySource::Mcp);
        assert_eq!(activity[0].action, "get_note");
        assert!(!activity[0].ok);
        assert!(!activity
            .iter()
            .any(|entry| entry.summary.contains("Second")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resources_list_templates_and_read_all_uris_and_errors() {
        let (root, config_dir, data_dir) = temp_store_root();
        let store = NoteStore::new(config_dir.clone(), data_dir.clone());
        let note = store
            .create_note(SaveNoteRequest {
                title: "Resource Target".into(),
                content: "# Resource Body\n- [ ] Pending task\n- [x] Done task".into(),
                category: "docs".into(),
                tags: vec!["ref".into()],
                pinned: false,
            })
            .expect("create seed note");

        // 1. resources/list
        let list_resp = call_line(
            r#"{"jsonrpc":"2.0","id":20,"method":"resources/list"}"#,
            &config_dir,
            &data_dir,
        )
        .expect("resources/list response");
        let resources = list_resp["result"]["resources"].as_array().unwrap();
        let uris: Vec<(&str, &str)> = resources
            .iter()
            .map(|r| (r["uri"].as_str().unwrap(), r["mimeType"].as_str().unwrap()))
            .collect();
        assert_eq!(
            uris,
            vec![
                ("floral://daily", "text/markdown"),
                ("floral://todos/pending", "application/json"),
                ("floral://notes", "application/json"),
            ]
        );

        // 2. resources/templates/list
        let tmpl_resp = call_line(
            r#"{"jsonrpc":"2.0","id":21,"method":"resources/templates/list"}"#,
            &config_dir,
            &data_dir,
        )
        .expect("resources/templates/list response");
        let templates = tmpl_resp["result"]["resourceTemplates"].as_array().unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0]["uriTemplate"], "floral://note/{id}");
        assert_eq!(templates[0]["mimeType"], "text/markdown");

        // 3. resources/read -> floral://daily
        let daily_resp = call_line(
            r#"{"jsonrpc":"2.0","id":22,"method":"resources/read","params":{"uri":"floral://daily"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        let daily_contents = daily_resp["result"]["contents"].as_array().unwrap();
        assert_eq!(daily_contents[0]["uri"], "floral://daily");
        assert_eq!(daily_contents[0]["mimeType"], "text/markdown");
        assert!(daily_contents[0]["text"]
            .as_str()
            .unwrap()
            .contains("## 待办"));

        // 4. resources/read -> floral://todos/pending
        let todos_resp = call_line(
            r#"{"jsonrpc":"2.0","id":23,"method":"resources/read","params":{"uri":"floral://todos/pending"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        let todos_contents = todos_resp["result"]["contents"].as_array().unwrap();
        assert_eq!(todos_contents[0]["uri"], "floral://todos/pending");
        assert_eq!(todos_contents[0]["mimeType"], "application/json");
        let todos_json: Value =
            serde_json::from_str(todos_contents[0]["text"].as_str().unwrap()).unwrap();
        let pending_texts: Vec<&str> = todos_json["todos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["text"].as_str().unwrap())
            .collect();
        assert!(pending_texts.contains(&"Pending task"));
        assert!(!pending_texts.contains(&"Done task"));

        // 5. resources/read -> floral://notes
        let notes_resp = call_line(
            r#"{"jsonrpc":"2.0","id":24,"method":"resources/read","params":{"uri":"floral://notes"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        let notes_contents = notes_resp["result"]["contents"].as_array().unwrap();
        assert_eq!(notes_contents[0]["uri"], "floral://notes");
        assert_eq!(notes_contents[0]["mimeType"], "application/json");
        let notes_json: Value =
            serde_json::from_str(notes_contents[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(notes_json["count"], 2); // seed note + today's daily note

        // 6. resources/read -> floral://note/{id}
        let note_uri = format!("floral://note/{}", note.id);
        let note_req = json!({
            "jsonrpc": "2.0",
            "id": 25,
            "method": "resources/read",
            "params": { "uri": note_uri }
        });
        let note_resp = call_line(&note_req.to_string(), &config_dir, &data_dir).unwrap();
        let note_contents = note_resp["result"]["contents"].as_array().unwrap();
        assert_eq!(note_contents[0]["uri"], note_uri);
        assert_eq!(note_contents[0]["mimeType"], "text/markdown");
        assert_eq!(
            note_contents[0]["text"],
            "# Resource Body\n- [ ] Pending task\n- [x] Done task"
        );

        // 7. Invalid / unknown / missing URIs return clean JSON-RPC errors
        let missing_params = call_line(
            r#"{"jsonrpc":"2.0","id":26,"method":"resources/read"}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(missing_params["error"]["code"], -32602);

        let unknown_uri = call_line(
            r#"{"jsonrpc":"2.0","id":27,"method":"resources/read","params":{"uri":"floral://unknown"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(unknown_uri["error"]["code"], -32602);

        let empty_id_uri = call_line(
            r#"{"jsonrpc":"2.0","id":28,"method":"resources/read","params":{"uri":"floral://note/"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(empty_id_uri["error"]["code"], -32602);

        let traversal_uri = call_line(
            r#"{"jsonrpc":"2.0","id":29,"method":"resources/read","params":{"uri":"floral://note/../secret"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(traversal_uri["error"]["code"], -32602);

        let missing_note_uri = call_line(
            r#"{"jsonrpc":"2.0","id":30,"method":"resources/read","params":{"uri":"floral://note/missing-id"}}"#,
            &config_dir,
            &data_dir,
        )
        .unwrap();
        assert_eq!(missing_note_uri["error"]["code"], ERR_RESOURCE_NOT_FOUND);

        // Resource reads are recorded in external activity without note body text
        let activity = external_sync::list_activity(&data_dir).unwrap();
        assert!(activity
            .iter()
            .any(|e| e.action == "resources/read" && e.target == "floral://notes" && e.ok));
        assert!(!activity.iter().any(|e| e.summary.contains("Resource Body")));

        let _ = fs::remove_dir_all(root);
    }
}
