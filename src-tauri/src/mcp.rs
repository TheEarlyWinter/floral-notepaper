//! MCP (Model Context Protocol) stdio server over newline-delimited JSON-RPC 2.0.
//!
//! IMPORTANT: On Windows, the binary uses `windows_subsystem = "windows"`.
//! In `--mcp` mode we MUST NEVER allocate/attach a console (`ensure_console`)
//! and MUST write ONLY `\n`-delimited JSON-RPC 2.0 responses to `stdout`.
//! Any diagnostics must go exclusively to `stderr`.

use crate::cli::{
    append_note_operation, create_reminder_checked, delete_note_with_sync,
    delete_reminder_with_sync, enqueue_pin_tile, open_daily_with_sync,
};
use crate::external_sync;
use crate::services::notes::{default_store, AppError, NoteStore, SaveNoteRequest};
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
                    "noteId": { "type": "string", "description": "Note ID." }
                },
                "required": ["noteId"]
            }
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
            Ok(run_tool_body(store_provider, |store| {
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
                Ok(json!({ "count": notes.len(), "notes": notes }))
            }))
        }
        "get_note" => {
            let args: NoteIdArg = parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                code: ERR_INVALID_PARAMS,
                message: msg,
            })?;
            Ok(run_tool_body(store_provider, |store| {
                store.read_note(&args.id)
            }))
        }
        "search_notes" => {
            let args: SearchNotesArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                let results = store.search_content(&args.query)?;
                Ok(json!({
                    "query": args.query,
                    "count": results.len(),
                    "results": results
                }))
            }))
        }
        "create_note" => {
            let args: CreateNoteArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                if args.title.trim().is_empty() {
                    return Err(AppError {
                        code: "invalidTitle".into(),
                        message: "title cannot be empty".into(),
                        details: Default::default(),
                    });
                }
                let note = store.create_note(SaveNoteRequest {
                    title: args.title,
                    content: args.content,
                    category: args.category,
                    tags: args.tags,
                    pinned: args.pinned,
                })?;
                external_sync::touch_external_rev(store.data_dir())?;
                Ok(note)
            }))
        }
        "append_note" => {
            let args: AppendNoteArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                append_note_operation(&store, &args.id, &args.content, args.separator.as_deref())
            }))
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
            Ok(run_tool_body(store_provider, |store| {
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
                Ok(updated)
            }))
        }
        "delete_note" => {
            let args: NoteIdArg = parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                code: ERR_INVALID_PARAMS,
                message: msg,
            })?;
            Ok(run_tool_body(store_provider, |store| {
                delete_note_with_sync(&store, &args.id)?;
                Ok(json!({ "deleted": true, "id": args.id }))
            }))
        }
        "open_daily_note" => {
            // Accept empty object without extra strictness
            Ok(run_tool_body(store_provider, |store| {
                open_daily_with_sync(&store)
            }))
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
            Ok(run_tool_body(store_provider, |store| {
                let items = todos::list_todos(&store, filter, args.note_id.as_deref())?;
                Ok(json!({ "count": items.len(), "todos": items }))
            }))
        }
        "toggle_todo" => {
            let args: ToggleTodoArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                let item = todos::toggle_todo(&store, &args.note_id, args.index)?;
                external_sync::touch_external_rev(store.data_dir())?;
                Ok(item)
            }))
        }
        "list_reminders" => Ok(run_tool_body(store_provider, |store| {
            let list = reminders::list(store.data_dir())?;
            Ok(json!({ "count": list.len(), "reminders": list }))
        })),
        "create_reminder" => {
            let args: CreateReminderArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                create_reminder_checked(&store, &args.note_id, &args.remind_at, &args.message)
            }))
        }
        "delete_reminder" => {
            let args: DeleteReminderArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                delete_reminder_with_sync(&store, &args.id)?;
                Ok(json!({ "deleted": true, "id": args.id }))
            }))
        }
        "pin_tile" => {
            let args: PinTileArgs =
                parse_tool_args(raw_args, name).map_err(|msg| JsonRpcError {
                    code: ERR_INVALID_PARAMS,
                    message: msg,
                })?;
            Ok(run_tool_body(store_provider, |store| {
                let note_id = enqueue_pin_tile(&store, &args.note_id)?;
                Ok(json!({ "queued": true, "command": "pin_tile", "noteId": note_id }))
            }))
        }
        _ => unreachable!(),
    }
}

fn run_tool_body<T: Serialize>(
    store_provider: &impl Fn() -> Result<NoteStore, AppError>,
    f: impl FnOnce(NoteStore) -> Result<T, AppError>,
) -> Value {
    let result = store_provider().and_then(f);
    match result {
        Ok(data) => match ToolCallResult::success_json(&data) {
            Ok(value) => value,
            Err(err) => ToolCallResult::error_text(err),
        },
        Err(err) => ToolCallResult::error_text(err.to_string()),
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
                    "tools": {}
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

        // 13. pin_tile
        let pin_req = json!({"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"pin_tile","arguments":{"noteId": note_id}}});
        let pin_resp = call_line(&pin_req.to_string(), &config_dir, &data_dir).unwrap();
        assert_eq!(parse_tool_payload(&pin_resp)["queued"], true);
        assert_eq!(external_sync::drain_commands(&data_dir).unwrap().len(), 1);

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

        let _ = fs::remove_dir_all(root);
    }
}
