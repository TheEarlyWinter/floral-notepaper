//! CLI 模式：通过命令行参数直接调用花笺的笔记 API。
//! 使用方式：floral-notepaper --cli <subcommand>
//!
//! 环境变量：
//!   FLORAL_NOTEPAPER_DATA_DIR — 覆盖数据目录
//!   FLORAL_NOTEPAPER_CONFIG_DIR — 覆盖配置目录

use crate::external_sync::{self, ExternalActivitySource, ExternalCommand};
use crate::services::library::SearchResult;
use crate::services::notes::{
    default_store, AppError, Note, NoteMetadata, NoteStore, SaveNoteRequest,
};
use crate::services::reminders::{self, Reminder};
use crate::services::todos::{self, TodoFilter};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::io::{self, Read};
use std::process;

/// 将 AppError 转换为 String，简化 CLI 中的错误传播
fn map_err(e: AppError) -> String {
    e.to_string()
}

type CliResult<T> = Result<T, String>;

trait CliMap<T> {
    fn cli(self) -> CliResult<T>;
}

impl<T> CliMap<T> for Result<T, AppError> {
    fn cli(self) -> CliResult<T> {
        self.map_err(map_err)
    }
}

#[derive(Serialize)]
struct CliOutput<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl<T: Serialize> CliOutput<T> {
    fn success(data: T) -> Self {
        CliOutput {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    fn fail(msg: impl Into<String>) -> Self {
        CliOutput {
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

fn print_json<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(json) => println!("{json}"),
        Err(e) => eprintln!("{{ \"ok\": false, \"error\": \"JSON 序列化失败: {e}\" }}"),
    }
}

fn print_help() {
    eprintln!(
        "花笺 CLI\n\
         \n\
         用法: floral-notepaper --cli <子命令> [参数]\n\
               floral-notepaper --mcp\n\
         \n\
         子命令:\n\
           list                          列出所有笔记（仅元数据）\n\
           get <id>                      获取笔记完整内容\n\
           search <query>                搜索笔记正文\n\
           daily                         打开/创建今日便笺（输出元数据）\n\
           create --title <t> [--content <c> | --stdin] [--category <c>] [--tags <t1,t2>] [--pinned]\n\
                                         创建新笔记。--stdin 从标准输入读取内容\n\
           append <note-id|daily> (--content <c> | --stdin) [--separator <sep>]\n\
                                         追加内容到指定笔记或今日便笺（默认分隔符 \\n）\n\
           update <note-id> [--title <t>] [--content <c> | --stdin] [--category <c>] [--tags <t1,t2>] [--pinned true|false]\n\
                                         局部更新笔记（未指定的字段保持不变）\n\
           delete <note-id>              删除笔记（移入回收站并清理关联提醒）\n\
           export <id>                   导出笔记为 Markdown 文本\n\
           todos list [--pending|--done] [--note <id>]\n\
                                         列出 Markdown 任务清单\n\
           todos toggle <note-id> <index>\n\
                                         按 0-based 索引切换笔记内的任务完成状态\n\
           remind list                   列出所有提醒\n\
           remind create --note <id> --at <RFC3339> --message <msg>\n\
                                         为指定笔记创建定时提醒\n\
           remind delete <id>            删除提醒\n\
           pin-tile <note-id> [--ttl <secs> | --persist]\n\
                                         请求正在运行的 GUI 将笔记钉为桌面磁贴（默认 TTL 300s）\n\
         \n\
         环境变量:\n\
           FLORAL_NOTEPAPER_DATA_DIR     数据目录路径\n\
           FLORAL_NOTEPAPER_CONFIG_DIR   配置目录路径\n\
         \n\
         示例:\n\
           floral-notepaper --cli list\n\
           floral-notepaper --cli get abc123\n\
           floral-notepaper --cli search \"齿轮强度\"\n\
           floral-notepaper --cli create --title \"新笔记\" --content \"# Hello\" --category 工作 --tags 计划,重要 --pinned\n\
           floral-notepaper --cli append daily --content \"- [ ] 复核图纸\"\n\
           floral-notepaper --cli update abc123 --pinned true --tags 已整理\n\
           floral-notepaper --cli todos list --pending\n\
           floral-notepaper --cli todos toggle abc123 0\n\
           floral-notepaper --cli remind create --note abc123 --at 2026-12-01T09:00:00Z --message \"交稿\"\n\
           floral-notepaper --cli pin-tile abc123\n\
           floral-notepaper --cli export abc123 > note.md"
    );
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContentSource {
    Inline(String),
    Stdin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CliAction {
    List,
    Get {
        id: String,
    },
    Search {
        query: String,
    },
    Daily,
    Create {
        title: String,
        content: Option<ContentSource>,
        category: String,
        tags: Vec<String>,
        pinned: bool,
    },
    Append {
        target: String,
        content: ContentSource,
        separator: Option<String>,
    },
    Update {
        id: String,
        title: Option<String>,
        content: Option<ContentSource>,
        category: Option<String>,
        tags: Option<Vec<String>>,
        pinned: Option<bool>,
    },
    Delete {
        id: String,
    },
    Export {
        id: String,
    },
    TodosList {
        filter: TodoFilter,
        note_id: Option<String>,
    },
    TodosToggle {
        note_id: String,
        index: usize,
    },
    RemindList,
    RemindCreate {
        note_id: String,
        at: String,
        message: String,
    },
    RemindDelete {
        id: String,
    },
    PinTile {
        note_id: String,
        ttl_secs: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParseOutcome {
    Help,
    Action(CliAction),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CliExecutionOutput {
    Json(Value),
    Raw(String),
}

pub(crate) fn parse_tags_csv(raw: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for segment in raw.split(',') {
        let trimmed = segment.trim();
        if !trimmed.is_empty() && !tags.iter().any(|existing| existing == trimmed) {
            tags.push(trimmed.to_string());
        }
    }
    tags
}

pub(crate) fn parse_bool_flag(raw: &str, flag: &str) -> CliResult<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("参数 {flag} 需要 true 或 false，收到: {raw}")),
    }
}

pub(crate) fn append_text_with_separator(
    existing: &str,
    addition: &str,
    separator: Option<&str>,
) -> String {
    if existing.is_empty() {
        return addition.to_string();
    }
    if addition.is_empty() {
        return existing.to_string();
    }
    match separator {
        Some(sep) => format!("{existing}{sep}{addition}"),
        None => {
            if existing.ends_with('\n') {
                format!("{existing}{addition}")
            } else {
                format!("{existing}\n{addition}")
            }
        }
    }
}

pub(crate) fn append_note_operation(
    store: &NoteStore,
    target: &str,
    addition: &str,
    separator: Option<&str>,
) -> Result<Note, AppError> {
    let note = if target == "daily" {
        store.open_daily_note()?
    } else {
        store.read_note(target)?
    };
    let merged = append_text_with_separator(&note.content, addition, separator);
    let updated = store.update_note(
        &note.id,
        SaveNoteRequest {
            title: note.title,
            content: merged,
            category: note.category,
            tags: note.tags,
            pinned: note.pinned,
        },
    )?;
    external_sync::touch_external_rev(store.data_dir())?;
    Ok(updated)
}

pub(crate) fn open_daily_with_sync(store: &NoteStore) -> Result<Note, AppError> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let had_daily = store
        .list_notes()?
        .iter()
        .any(|note| note.tags.iter().any(|tag| tag == "daily") && note.title == today);
    let note = store.open_daily_note()?;
    if !had_daily {
        external_sync::touch_external_rev(store.data_dir())?;
    }
    Ok(note)
}

pub(crate) fn delete_note_with_sync(store: &NoteStore, id: &str) -> Result<(), AppError> {
    store.delete_note(id)?;
    if let Err(error) = reminders::delete_for_note(store.data_dir(), id) {
        eprintln!("failed to remove reminders for deleted note {id}: {error}");
    }
    external_sync::touch_external_rev(store.data_dir())?;
    Ok(())
}

pub(crate) fn create_reminder_checked(
    store: &NoteStore,
    note_id: &str,
    remind_at_raw: &str,
    message: &str,
) -> Result<Reminder, AppError> {
    store.read_note(note_id)?;
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err(AppError {
            code: "invalidReminderMessage".into(),
            message: "提醒内容不能为空".into(),
            details: Default::default(),
        });
    }
    let parsed_at: DateTime<Utc> = DateTime::parse_from_rfc3339(remind_at_raw.trim())
        .map_err(|err| AppError {
            code: "invalidReminderTime".into(),
            message: format!("提醒时间必须是有效的 RFC3339 格式: {err}"),
            details: Default::default(),
        })?
        .with_timezone(&Utc);
    let reminder = reminders::create(
        store.data_dir(),
        note_id.to_string(),
        trimmed_message.to_string(),
        parsed_at,
    )?;
    external_sync::touch_external_rev(store.data_dir())?;
    Ok(reminder)
}

pub(crate) fn delete_reminder_with_sync(store: &NoteStore, id: &str) -> Result<(), AppError> {
    if id.trim().is_empty() {
        return Err(AppError {
            code: "invalidReminderId".into(),
            message: "提醒 ID 不能为空".into(),
            details: Default::default(),
        });
    }
    reminders::delete(store.data_dir(), id.trim())?;
    external_sync::touch_external_rev(store.data_dir())?;
    Ok(())
}

pub(crate) fn resolve_pin_tile_ttl(ttl_secs: Option<u64>, persist: bool) -> Option<u64> {
    if persist || ttl_secs == Some(0) {
        None
    } else {
        Some(ttl_secs.unwrap_or(external_sync::DEFAULT_PIN_TILE_TTL_SECS))
    }
}

pub(crate) fn enqueue_pin_tile(
    store: &NoteStore,
    note_id: &str,
    ttl_secs: Option<u64>,
) -> Result<String, AppError> {
    let note = store.read_note(note_id)?;
    external_sync::enqueue_command(
        store.data_dir(),
        ExternalCommand::pin_tile(note.id.clone(), ttl_secs),
    )?;
    Ok(note.id)
}

fn split_flag_value(arg: &str) -> (&str, Option<&str>) {
    if arg.starts_with("--") {
        if let Some((flag, value)) = arg.split_once('=') {
            return (flag, Some(value));
        }
    }
    (arg, None)
}

fn take_flag_value<'a>(
    inline_value: Option<&'a str>,
    iter: &mut std::slice::Iter<'_, String>,
    flag: &str,
) -> CliResult<String> {
    if let Some(value) = inline_value {
        return Ok(value.to_string());
    }
    iter.next()
        .cloned()
        .ok_or_else(|| format!("参数 {flag} 缺少值"))
}

fn has_help_flag(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

pub(crate) fn parse_args(args: &[String]) -> CliResult<ParseOutcome> {
    let Some((cmd, rest)) = args.split_first() else {
        return Err("缺少子命令".into());
    };

    if cmd == "--help" || cmd == "-h" {
        return Ok(ParseOutcome::Help);
    }

    if has_help_flag(rest) {
        return Ok(ParseOutcome::Help);
    }

    match cmd.as_str() {
        "list" => {
            if let Some(extra) = rest.first() {
                return Err(format!("list 不接受额外参数: {extra}"));
            }
            Ok(ParseOutcome::Action(CliAction::List))
        }
        "get" => {
            let [id] = rest else {
                return Err("用法: floral-notepaper --cli get <note-id>".into());
            };
            if id.starts_with("--") || id.is_empty() {
                return Err("用法: floral-notepaper --cli get <note-id>".into());
            }
            Ok(ParseOutcome::Action(CliAction::Get { id: id.clone() }))
        }
        "search" => {
            let [query] = rest else {
                return Err("用法: floral-notepaper --cli search <关键词>".into());
            };
            if query.is_empty() {
                return Err("用法: floral-notepaper --cli search <关键词>".into());
            }
            Ok(ParseOutcome::Action(CliAction::Search {
                query: query.clone(),
            }))
        }
        "daily" => {
            if let Some(extra) = rest.first() {
                return Err(format!("daily 不接受额外参数: {extra}"));
            }
            Ok(ParseOutcome::Action(CliAction::Daily))
        }
        "export" => {
            let [id] = rest else {
                return Err("用法: floral-notepaper --cli export <note-id>".into());
            };
            if id.starts_with("--") || id.is_empty() {
                return Err("用法: floral-notepaper --cli export <note-id>".into());
            }
            Ok(ParseOutcome::Action(CliAction::Export { id: id.clone() }))
        }
        "delete" => {
            let [id] = rest else {
                return Err("用法: floral-notepaper --cli delete <note-id>".into());
            };
            if id.starts_with("--") || id.is_empty() {
                return Err("用法: floral-notepaper --cli delete <note-id>".into());
            }
            Ok(ParseOutcome::Action(CliAction::Delete { id: id.clone() }))
        }
        "pin-tile" => {
            let mut note_id: Option<String> = None;
            let mut parsed_ttl: Option<u64> = None;
            let mut persist = false;

            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                let (flag, inline) = split_flag_value(arg);
                match flag {
                    "--ttl" => {
                        let raw = take_flag_value(inline, &mut iter, "--ttl")?;
                        let secs = raw
                            .trim()
                            .parse::<u64>()
                            .map_err(|_| format!("无效的 TTL 秒数（需要非负整数）: {raw}"))?;
                        parsed_ttl = Some(secs);
                    }
                    "--persist" => {
                        if inline.is_some() {
                            return Err("--persist 不接受参数值".into());
                        }
                        persist = true;
                    }
                    _ if arg.starts_with("--") => return Err(format!("未知参数: {arg}")),
                    _ => {
                        if note_id.is_some() {
                            return Err(format!("多余的位置参数: {arg}"));
                        }
                        note_id = Some(arg.clone());
                    }
                }
            }

            if persist && parsed_ttl.is_some() {
                return Err("--ttl 与 --persist 不能同时使用".into());
            }

            let note_id = note_id.filter(|v| !v.is_empty()).ok_or_else(|| {
                "用法: floral-notepaper --cli pin-tile <note-id> [--ttl <secs> | --persist]"
                    .to_string()
            })?;

            Ok(ParseOutcome::Action(CliAction::PinTile {
                note_id,
                ttl_secs: resolve_pin_tile_ttl(parsed_ttl, persist),
            }))
        }
        "create" => {
            let mut title = String::new();
            let mut inline_content: Option<String> = None;
            let mut use_stdin = false;
            let mut category = String::new();
            let mut tags: Vec<String> = Vec::new();
            let mut pinned = false;

            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                let (flag, inline) = split_flag_value(arg);
                match flag {
                    "--title" => {
                        title = take_flag_value(inline, &mut iter, "--title")?;
                    }
                    "--content" => {
                        inline_content = Some(take_flag_value(inline, &mut iter, "--content")?);
                    }
                    "--stdin" => {
                        if inline.is_some() {
                            return Err("--stdin 不接受参数值".into());
                        }
                        use_stdin = true;
                    }
                    "--category" => {
                        category = take_flag_value(inline, &mut iter, "--category")?;
                    }
                    "--tags" => {
                        let raw = take_flag_value(inline, &mut iter, "--tags")?;
                        tags = parse_tags_csv(&raw);
                    }
                    "--pinned" => {
                        pinned = match inline {
                            Some(val) => parse_bool_flag(val, "--pinned")?,
                            None => true,
                        };
                    }
                    _ => return Err(format!("未知参数: {arg}")),
                }
            }

            if title.is_empty() {
                return Err("错误: 必须提供 --title".into());
            }
            if use_stdin && inline_content.is_some() {
                return Err("--content 与 --stdin 不能同时使用".into());
            }
            let content = if use_stdin {
                Some(ContentSource::Stdin)
            } else {
                inline_content.map(ContentSource::Inline)
            };

            Ok(ParseOutcome::Action(CliAction::Create {
                title,
                content,
                category,
                tags,
                pinned,
            }))
        }
        "append" => {
            let mut target: Option<String> = None;
            let mut inline_content: Option<String> = None;
            let mut use_stdin = false;
            let mut separator: Option<String> = None;

            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                let (flag, inline) = split_flag_value(arg);
                match flag {
                    "--content" => {
                        inline_content = Some(take_flag_value(inline, &mut iter, "--content")?);
                    }
                    "--stdin" => {
                        if inline.is_some() {
                            return Err("--stdin 不接受参数值".into());
                        }
                        use_stdin = true;
                    }
                    "--separator" => {
                        separator = Some(take_flag_value(inline, &mut iter, "--separator")?);
                    }
                    _ if arg.starts_with("--") => return Err(format!("未知参数: {arg}")),
                    _ => {
                        if target.is_some() {
                            return Err(format!("多余的位置参数: {arg}"));
                        }
                        target = Some(arg.clone());
                    }
                }
            }

            let target = target
                .filter(|t| !t.is_empty())
                .ok_or_else(|| "用法: floral-notepaper --cli append <note-id|daily> (--content <c> | --stdin) [--separator <sep>]".to_string())?;
            if use_stdin && inline_content.is_some() {
                return Err("--content 与 --stdin 不能同时使用".into());
            }
            let content = if use_stdin {
                ContentSource::Stdin
            } else if let Some(text) = inline_content {
                ContentSource::Inline(text)
            } else {
                return Err("错误: append 必须提供 --content 或 --stdin".into());
            };

            Ok(ParseOutcome::Action(CliAction::Append {
                target,
                content,
                separator,
            }))
        }
        "update" => {
            let mut id: Option<String> = None;
            let mut title: Option<String> = None;
            let mut inline_content: Option<String> = None;
            let mut use_stdin = false;
            let mut category: Option<String> = None;
            let mut tags: Option<Vec<String>> = None;
            let mut pinned: Option<bool> = None;

            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                let (flag, inline) = split_flag_value(arg);
                match flag {
                    "--title" => {
                        title = Some(take_flag_value(inline, &mut iter, "--title")?);
                    }
                    "--content" => {
                        inline_content = Some(take_flag_value(inline, &mut iter, "--content")?);
                    }
                    "--stdin" => {
                        if inline.is_some() {
                            return Err("--stdin 不接受参数值".into());
                        }
                        use_stdin = true;
                    }
                    "--category" => {
                        category = Some(take_flag_value(inline, &mut iter, "--category")?);
                    }
                    "--tags" => {
                        let raw = take_flag_value(inline, &mut iter, "--tags")?;
                        tags = Some(parse_tags_csv(&raw));
                    }
                    "--pinned" => {
                        let raw = take_flag_value(inline, &mut iter, "--pinned")?;
                        pinned = Some(parse_bool_flag(&raw, "--pinned")?);
                    }
                    _ if arg.starts_with("--") => return Err(format!("未知参数: {arg}")),
                    _ => {
                        if id.is_some() {
                            return Err(format!("多余的位置参数: {arg}"));
                        }
                        id = Some(arg.clone());
                    }
                }
            }

            let id = id
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "用法: floral-notepaper --cli update <note-id> [--title <t>] [--content <c> | --stdin] [--category <c>] [--tags <t1,t2>] [--pinned true|false]".to_string())?;
            if use_stdin && inline_content.is_some() {
                return Err("--content 与 --stdin 不能同时使用".into());
            }
            let content = if use_stdin {
                Some(ContentSource::Stdin)
            } else {
                inline_content.map(ContentSource::Inline)
            };
            if title.is_none()
                && content.is_none()
                && category.is_none()
                && tags.is_none()
                && pinned.is_none()
            {
                return Err("update 至少需要指定一个待更新字段".into());
            }

            Ok(ParseOutcome::Action(CliAction::Update {
                id,
                title,
                content,
                category,
                tags,
                pinned,
            }))
        }
        "todos" => {
            let Some((sub, sub_rest)) = rest.split_first() else {
                return Err("用法: floral-notepaper --cli todos <list|toggle> ...".into());
            };
            match sub.as_str() {
                "list" => {
                    let mut pending = false;
                    let mut done = false;
                    let mut note_id: Option<String> = None;
                    let mut iter = sub_rest.iter();
                    while let Some(arg) = iter.next() {
                        let (flag, inline) = split_flag_value(arg);
                        match flag {
                            "--pending" => {
                                if inline.is_some() {
                                    return Err("--pending 不接受参数值".into());
                                }
                                pending = true;
                            }
                            "--done" => {
                                if inline.is_some() {
                                    return Err("--done 不接受参数值".into());
                                }
                                done = true;
                            }
                            "--note" => {
                                note_id = Some(take_flag_value(inline, &mut iter, "--note")?);
                            }
                            _ => return Err(format!("未知参数: {arg}")),
                        }
                    }
                    if pending && done {
                        return Err("--pending 与 --done 不能同时使用".into());
                    }
                    let filter = if pending {
                        TodoFilter::Pending
                    } else if done {
                        TodoFilter::Done
                    } else {
                        TodoFilter::All
                    };
                    Ok(ParseOutcome::Action(CliAction::TodosList {
                        filter,
                        note_id,
                    }))
                }
                "toggle" => {
                    let [note_id, index_raw] = sub_rest else {
                        return Err(
                            "用法: floral-notepaper --cli todos toggle <note-id> <index>".into(),
                        );
                    };
                    if note_id.starts_with("--") || note_id.is_empty() {
                        return Err(
                            "用法: floral-notepaper --cli todos toggle <note-id> <index>".into(),
                        );
                    }
                    let index = index_raw
                        .parse::<usize>()
                        .map_err(|_| format!("无效的任务索引（需要非负整数）: {index_raw}"))?;
                    Ok(ParseOutcome::Action(CliAction::TodosToggle {
                        note_id: note_id.clone(),
                        index,
                    }))
                }
                _ => Err(format!("未知 todos 子命令: {sub}")),
            }
        }
        "remind" => {
            let Some((sub, sub_rest)) = rest.split_first() else {
                return Err("用法: floral-notepaper --cli remind <list|create|delete> ...".into());
            };
            match sub.as_str() {
                "list" => {
                    if let Some(extra) = sub_rest.first() {
                        return Err(format!("remind list 不接受额外参数: {extra}"));
                    }
                    Ok(ParseOutcome::Action(CliAction::RemindList))
                }
                "create" => {
                    let mut note_id: Option<String> = None;
                    let mut at: Option<String> = None;
                    let mut message: Option<String> = None;
                    let mut iter = sub_rest.iter();
                    while let Some(arg) = iter.next() {
                        let (flag, inline) = split_flag_value(arg);
                        match flag {
                            "--note" => {
                                note_id = Some(take_flag_value(inline, &mut iter, "--note")?);
                            }
                            "--at" => {
                                at = Some(take_flag_value(inline, &mut iter, "--at")?);
                            }
                            "--message" => {
                                message = Some(take_flag_value(inline, &mut iter, "--message")?);
                            }
                            _ => return Err(format!("未知参数: {arg}")),
                        }
                    }
                    let note_id = note_id
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| "错误: remind create 必须提供 --note".to_string())?;
                    let at = at
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| "错误: remind create 必须提供 --at <RFC3339>".to_string())?;
                    let message = message
                        .filter(|v| !v.trim().is_empty())
                        .ok_or_else(|| "错误: remind create 必须提供 --message".to_string())?;
                    Ok(ParseOutcome::Action(CliAction::RemindCreate {
                        note_id,
                        at,
                        message,
                    }))
                }
                "delete" => {
                    let [id] = sub_rest else {
                        return Err(
                            "用法: floral-notepaper --cli remind delete <reminder-id>".into()
                        );
                    };
                    if id.starts_with("--") || id.is_empty() {
                        return Err(
                            "用法: floral-notepaper --cli remind delete <reminder-id>".into()
                        );
                    }
                    Ok(ParseOutcome::Action(CliAction::RemindDelete {
                        id: id.clone(),
                    }))
                }
                _ => Err(format!("未知 remind 子命令: {sub}")),
            }
        }
        _ => Err(format!("未知子命令: {cmd}")),
    }
}

fn resolve_content(source: ContentSource, stdin_override: Option<&str>) -> CliResult<String> {
    match source {
        ContentSource::Inline(text) => Ok(text),
        ContentSource::Stdin => {
            if let Some(preset) = stdin_override {
                return Ok(preset.to_string());
            }
            let mut buf = String::new();
            io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("读取 stdin 失败: {e}"))?;
            Ok(buf)
        }
    }
}

fn cli_action_meta(action: &CliAction) -> (&'static str, String) {
    match action {
        CliAction::List => ("list", "notes".into()),
        CliAction::Get { id } => ("get", id.clone()),
        CliAction::Search { query } => ("search", query.clone()),
        CliAction::Daily => ("daily", "daily".into()),
        CliAction::Create { title, .. } => ("create", title.clone()),
        CliAction::Append { target, .. } => ("append", target.clone()),
        CliAction::Update { id, .. } => ("update", id.clone()),
        CliAction::Delete { id } => ("delete", id.clone()),
        CliAction::Export { id } => ("export", id.clone()),
        CliAction::TodosList { note_id, .. } => (
            "todos_list",
            note_id.clone().unwrap_or_else(|| "all".into()),
        ),
        CliAction::TodosToggle { note_id, index } => ("todos_toggle", format!("{note_id}#{index}")),
        CliAction::RemindList => ("remind_list", "reminders".into()),
        CliAction::RemindCreate { note_id, .. } => ("remind_create", note_id.clone()),
        CliAction::RemindDelete { id } => ("remind_delete", id.clone()),
        CliAction::PinTile { note_id, .. } => ("pin_tile", note_id.clone()),
    }
}

pub(crate) fn execute_action(
    store: &NoteStore,
    action: CliAction,
    stdin_override: Option<&str>,
) -> CliResult<CliExecutionOutput> {
    let (action_name, fallback_target) = cli_action_meta(&action);
    match execute_action_with_summary(store, action, stdin_override) {
        Ok((output, target, summary)) => {
            external_sync::record_activity_best_effort(
                store.data_dir(),
                ExternalActivitySource::Cli,
                action_name,
                &target,
                &summary,
                true,
            );
            Ok(output)
        }
        Err(err) => {
            external_sync::record_activity_best_effort(
                store.data_dir(),
                ExternalActivitySource::Cli,
                action_name,
                &fallback_target,
                &err,
                false,
            );
            Err(err)
        }
    }
}

fn execute_action_with_summary(
    store: &NoteStore,
    action: CliAction,
    stdin_override: Option<&str>,
) -> CliResult<(CliExecutionOutput, String, String)> {
    let success_json = |value: Value| -> CliResult<CliExecutionOutput> {
        let wrapped = serde_json::to_value(CliOutput::success(value))
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
        Ok(CliExecutionOutput::Json(wrapped))
    };

    match action {
        CliAction::List => {
            let notes = store.list_notes().cli()?;
            let count = notes.len();
            let data = serde_json::to_value(ListOutput { count, notes })
                .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((
                success_json(data)?,
                "notes".into(),
                format!("{count} notes"),
            ))
        }
        CliAction::Get { id } => {
            let note = store.read_note(&id).cli()?;
            let summary = format!("{} ({} chars)", note.title, note.content.chars().count());
            let data = serde_json::to_value(note).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, id, summary))
        }
        CliAction::Search { query } => {
            let results = store.search_content(&query).cli()?;
            let count = results.len();
            let data = serde_json::to_value(SearchOutput {
                query: query.clone(),
                count,
                results,
            })
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, query, format!("{count} results")))
        }
        CliAction::Daily => {
            let note = open_daily_with_sync(store).cli()?;
            let target = note.id.clone();
            let summary = format!("daily {}", note.title);
            let data = serde_json::to_value(note).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, target, summary))
        }
        CliAction::Create {
            title,
            content,
            category,
            tags,
            pinned,
        } => {
            let content_text = match content {
                Some(src) => resolve_content(src, stdin_override)?,
                None => String::new(),
            };
            let content_len = content_text.chars().count();
            let note = store
                .create_note(SaveNoteRequest {
                    title,
                    content: content_text,
                    category,
                    tags,
                    pinned,
                })
                .cli()?;
            external_sync::touch_external_rev(store.data_dir()).cli()?;
            let target = note.id.clone();
            let summary = format!("created '{}' ({content_len} chars)", note.title);
            let data = serde_json::to_value(note).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, target, summary))
        }
        CliAction::Append {
            target,
            content,
            separator,
        } => {
            let addition = resolve_content(content, stdin_override)?;
            let added_len = addition.chars().count();
            let updated =
                append_note_operation(store, &target, &addition, separator.as_deref()).cli()?;
            let resolved_target = updated.id.clone();
            let summary = format!("appended +{added_len} chars to '{}'", updated.title);
            let data =
                serde_json::to_value(updated).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, resolved_target, summary))
        }
        CliAction::Update {
            id,
            title,
            content,
            category,
            tags,
            pinned,
        } => {
            let existing = store.read_note(&id).cli()?;
            let next_content = match content {
                Some(src) => resolve_content(src, stdin_override)?,
                None => existing.content,
            };
            let updated = store
                .update_note(
                    &id,
                    SaveNoteRequest {
                        title: title.unwrap_or(existing.title),
                        content: next_content,
                        category: category.unwrap_or(existing.category),
                        tags: tags.unwrap_or(existing.tags),
                        pinned: pinned.unwrap_or(existing.pinned),
                    },
                )
                .cli()?;
            external_sync::touch_external_rev(store.data_dir()).cli()?;
            let summary = format!("updated '{}'", updated.title);
            let data =
                serde_json::to_value(updated).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, id, summary))
        }
        CliAction::Delete { id } => {
            delete_note_with_sync(store, &id).cli()?;
            let data = serde_json::to_value(DeleteOutput {
                deleted: true,
                id: id.clone(),
            })
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, id, "deleted note".into()))
        }
        CliAction::Export { id } => {
            let note = store.read_note(&id).cli()?;
            let summary = format!(
                "exported '{}' ({} chars)",
                note.title,
                note.content.chars().count()
            );
            Ok((CliExecutionOutput::Raw(note.content), id, summary))
        }
        CliAction::TodosList { filter, note_id } => {
            let items = todos::list_todos(store, filter, note_id.as_deref()).cli()?;
            let count = items.len();
            let target = note_id.unwrap_or_else(|| "all".into());
            let data = serde_json::to_value(TodosListOutput {
                count,
                todos: items,
            })
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, target, format!("{count} todos")))
        }
        CliAction::TodosToggle { note_id, index } => {
            let toggled = todos::toggle_todo(store, &note_id, index).cli()?;
            external_sync::touch_external_rev(store.data_dir()).cli()?;
            let target = format!("{note_id}#{index}");
            let summary = format!("done={}", toggled.done);
            let data =
                serde_json::to_value(toggled).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, target, summary))
        }
        CliAction::RemindList => {
            let list = reminders::list(store.data_dir()).cli()?;
            let count = list.len();
            let data = serde_json::to_value(RemindListOutput {
                count,
                reminders: list,
            })
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((
                success_json(data)?,
                "reminders".into(),
                format!("{count} reminders"),
            ))
        }
        CliAction::RemindCreate {
            note_id,
            at,
            message,
        } => {
            let reminder = create_reminder_checked(store, &note_id, &at, &message).cli()?;
            let summary = format!("reminder at {at}");
            let data =
                serde_json::to_value(reminder).map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, note_id, summary))
        }
        CliAction::RemindDelete { id } => {
            delete_reminder_with_sync(store, &id).cli()?;
            let data = serde_json::to_value(DeleteOutput {
                deleted: true,
                id: id.clone(),
            })
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, id, "deleted reminder".into()))
        }
        CliAction::PinTile { note_id, ttl_secs } => {
            let note_id = enqueue_pin_tile(store, &note_id, ttl_secs).cli()?;
            let persist = ttl_secs.is_none();
            let summary = match ttl_secs {
                Some(ttl) => format!("pin_tile ttl={ttl}s"),
                None => "pin_tile persist".into(),
            };
            let data = serde_json::to_value(PinTileOutput {
                queued: true,
                command: "pin_tile",
                note_id: note_id.clone(),
                ttl_secs,
                persist,
            })
            .map_err(|e| format!("JSON 序列化失败: {e}"))?;
            Ok((success_json(data)?, note_id, summary))
        }
    }
}

pub fn run_cli(args: impl Iterator<Item = String>) {
    let collected: Vec<String> = args.collect();
    if collected.is_empty() {
        print_help();
        process::exit(1);
    }

    let action = match parse_args(&collected) {
        Ok(ParseOutcome::Help) => {
            print_help();
            process::exit(0);
        }
        Ok(ParseOutcome::Action(action)) => action,
        Err(err) => {
            print_json(&CliOutput::<()>::fail(err));
            process::exit(1);
        }
    };

    let result = (|| -> CliResult<CliExecutionOutput> {
        let store = default_store().cli()?;
        execute_action(&store, action, None)
    })();

    match result {
        Ok(CliExecutionOutput::Json(value)) => print_json(&value),
        Ok(CliExecutionOutput::Raw(text)) => println!("{text}"),
        Err(err) => {
            print_json(&CliOutput::<()>::fail(err));
            process::exit(1);
        }
    }
}

#[derive(Serialize)]
struct ListOutput {
    count: usize,
    notes: Vec<NoteMetadata>,
}

#[derive(Serialize)]
struct SearchOutput {
    query: String,
    count: usize,
    results: Vec<SearchResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteOutput {
    deleted: bool,
    id: String,
}

#[derive(Serialize)]
struct TodosListOutput {
    count: usize,
    todos: Vec<todos::TodoItem>,
}

#[derive(Serialize)]
struct RemindListOutput {
    count: usize,
    reminders: Vec<Reminder>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PinTileOutput {
    queued: bool,
    command: &'static str,
    note_id: String,
    ttl_secs: Option<u64>,
    persist: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_store() -> (PathBuf, NoteStore) {
        let root = std::env::temp_dir().join(format!("floral-cli-test-{}", Uuid::new_v4()));
        let config_dir = root.join("config");
        let data_dir = root.join("data");
        fs::create_dir_all(&config_dir).expect("create config dir");
        fs::create_dir_all(&data_dir).expect("create data dir");
        let store = NoteStore::new(config_dir, data_dir);
        (root, store)
    }

    fn run_test_cli(store: &NoteStore, argv: &[&str], stdin_override: Option<&str>) -> Value {
        let args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let ParseOutcome::Action(action) = parse_args(&args).expect("parse cli args") else {
            panic!("expected Action");
        };
        match execute_action(store, action, stdin_override).expect("execute cli") {
            CliExecutionOutput::Json(v) => v,
            CliExecutionOutput::Raw(raw) => Value::String(raw),
        }
    }

    #[test]
    fn parses_existing_and_new_subcommands() {
        assert_eq!(parse_args(&["--help".into()]).unwrap(), ParseOutcome::Help);
        assert_eq!(
            parse_args(&["create".into(), "--help".into()]).unwrap(),
            ParseOutcome::Help
        );
        assert_eq!(
            parse_args(&[
                "create".into(),
                "--title".into(),
                "T".into(),
                "--category".into(),
                "work".into(),
                "--tags".into(),
                "a, b, a".into(),
                "--pinned".into(),
            ])
            .unwrap(),
            ParseOutcome::Action(CliAction::Create {
                title: "T".into(),
                content: None,
                category: "work".into(),
                tags: vec!["a".into(), "b".into()],
                pinned: true,
            })
        );
        assert_eq!(
            parse_args(&[
                "update".into(),
                "n1".into(),
                "--pinned".into(),
                "false".into(),
            ])
            .unwrap(),
            ParseOutcome::Action(CliAction::Update {
                id: "n1".into(),
                title: None,
                content: None,
                category: None,
                tags: None,
                pinned: Some(false),
            })
        );
        assert!(parse_args(&["update".into(), "n1".into()]).is_err());
        assert!(parse_args(&[
            "todos".into(),
            "list".into(),
            "--pending".into(),
            "--done".into()
        ])
        .is_err());
        assert_eq!(
            parse_args(&["pin-tile".into(), "n1".into()]).unwrap(),
            ParseOutcome::Action(CliAction::PinTile {
                note_id: "n1".into(),
                ttl_secs: Some(300),
            })
        );
        assert_eq!(
            parse_args(&["pin-tile".into(), "n1".into(), "--ttl".into(), "60".into()]).unwrap(),
            ParseOutcome::Action(CliAction::PinTile {
                note_id: "n1".into(),
                ttl_secs: Some(60),
            })
        );
        assert_eq!(
            parse_args(&["pin-tile".into(), "--persist".into(), "n1".into()]).unwrap(),
            ParseOutcome::Action(CliAction::PinTile {
                note_id: "n1".into(),
                ttl_secs: None,
            })
        );
        assert_eq!(
            parse_args(&["pin-tile".into(), "n1".into(), "--ttl=0".into()]).unwrap(),
            ParseOutcome::Action(CliAction::PinTile {
                note_id: "n1".into(),
                ttl_secs: None,
            })
        );
        assert!(parse_args(&[
            "pin-tile".into(),
            "n1".into(),
            "--ttl".into(),
            "60".into(),
            "--persist".into()
        ])
        .is_err());
    }

    #[test]
    fn executes_full_note_todo_reminder_and_pin_tile_workflows() {
        let (root, store) = temp_store();

        // create with metadata flags + stdin
        let created = run_test_cli(
            &store,
            &[
                "create",
                "--title",
                "CLI Note",
                "--stdin",
                "--category",
                "dev",
                "--tags",
                "rust,cli",
                "--pinned",
            ],
            Some("- [ ] task one\n- [x] task two"),
        );
        assert_eq!(created["ok"], true);
        let note_id = created["data"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["data"]["category"], "dev");
        assert_eq!(created["data"]["pinned"], true);
        assert_eq!(
            external_sync::read_external_rev(store.data_dir())
                .unwrap()
                .as_deref(),
            Some("1")
        );

        // append with custom separator
        let appended = run_test_cli(
            &store,
            &[
                "append",
                &note_id,
                "--content",
                "- [ ] task three",
                "--separator",
                "\n",
            ],
            None,
        );
        assert!(appended["data"]["content"]
            .as_str()
            .unwrap()
            .contains("task three"));
        assert_eq!(appended["data"]["title"], "CLI Note");
        assert_eq!(appended["data"]["pinned"], true);
        assert_eq!(
            external_sync::read_external_rev(store.data_dir())
                .unwrap()
                .as_deref(),
            Some("2")
        );

        // append to daily
        let daily_appended = run_test_cli(
            &store,
            &["append", "daily", "--content", "Daily entry"],
            None,
        );
        assert!(daily_appended["data"]["content"]
            .as_str()
            .unwrap()
            .contains("Daily entry"));

        // partial update preserving unspecified fields
        let updated = run_test_cli(&store, &["update", &note_id, "--pinned", "false"], None);
        assert_eq!(updated["data"]["pinned"], false);
        assert_eq!(updated["data"]["title"], "CLI Note");
        assert_eq!(updated["data"]["category"], "dev");

        // todos list & toggle
        let todos = run_test_cli(
            &store,
            &["todos", "list", "--pending", "--note", &note_id],
            None,
        );
        assert_eq!(todos["data"]["count"], 2);
        let toggled = run_test_cli(&store, &["todos", "toggle", &note_id, "0"], None);
        assert_eq!(toggled["data"]["done"], true);

        // remind create / list / delete
        let reminder = run_test_cli(
            &store,
            &[
                "remind",
                "create",
                "--note",
                &note_id,
                "--at",
                "2099-01-01T10:00:00Z",
                "--message",
                "Check build",
            ],
            None,
        );
        let reminder_id = reminder["data"]["id"].as_str().unwrap().to_string();
        let reminders_list = run_test_cli(&store, &["remind", "list"], None);
        assert_eq!(reminders_list["data"]["count"], 1);

        // pin-tile enqueues external command with default TTL 300s, custom TTL, and --persist
        let pin = run_test_cli(&store, &["pin-tile", &note_id], None);
        assert_eq!(pin["data"]["queued"], true);
        assert_eq!(pin["data"]["ttlSecs"], 300);
        assert_eq!(pin["data"]["persist"], false);

        let pin_custom = run_test_cli(&store, &["pin-tile", &note_id, "--ttl", "45"], None);
        assert_eq!(pin_custom["data"]["ttlSecs"], 45);
        assert_eq!(pin_custom["data"]["persist"], false);

        let pin_persist = run_test_cli(&store, &["pin-tile", &note_id, "--persist"], None);
        assert_eq!(pin_persist["data"]["ttlSecs"], Value::Null);
        assert_eq!(pin_persist["data"]["persist"], true);

        let drained = external_sync::drain_commands(store.data_dir()).unwrap();
        assert_eq!(drained.len(), 3);
        match &drained[0] {
            ExternalCommand::PinTile {
                note_id: id,
                ttl_secs,
                created_at_epoch_secs,
            } => {
                assert_eq!(id, &note_id);
                assert_eq!(*ttl_secs, Some(300));
                assert!(*created_at_epoch_secs > 0);
            }
        }
        match &drained[1] {
            ExternalCommand::PinTile { ttl_secs, .. } => assert_eq!(*ttl_secs, Some(45)),
        }
        match &drained[2] {
            ExternalCommand::PinTile { ttl_secs, .. } => assert_eq!(*ttl_secs, None),
        }

        // delete reminder & note
        let del_rem = run_test_cli(&store, &["remind", "delete", &reminder_id], None);
        assert_eq!(del_rem["data"]["deleted"], true);
        let del_note = run_test_cli(&store, &["delete", &note_id], None);
        assert_eq!(del_note["data"]["deleted"], true);
        assert!(store.read_note(&note_id).is_err());

        // pin-tile on deleted note must fail and record failed external activity
        let ParseOutcome::Action(pin_missing) =
            parse_args(&["pin-tile".into(), note_id.clone()]).unwrap()
        else {
            panic!("expected action");
        };
        assert!(execute_action(&store, pin_missing, None).is_err());

        let activity = external_sync::list_activity(store.data_dir()).unwrap();
        assert!(!activity.is_empty());
        assert_eq!(activity[0].source, ExternalActivitySource::Cli);
        assert_eq!(activity[0].action, "pin_tile");
        assert!(!activity[0].ok);
        // Never dump full note body into activity log
        assert!(!activity
            .iter()
            .any(|entry| entry.summary.contains("task two")));

        let _ = fs::remove_dir_all(root);
    }
}
