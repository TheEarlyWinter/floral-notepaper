//! CLI 模式：通过命令行参数直接调用花笺的笔记 API。
//! 使用方式：floral-notepaper --cli <subcommand>
//!
//! 环境变量：
//!   FLORAL_NOTEPAPER_DATA_DIR — 覆盖数据目录
//!   FLORAL_NOTEPAPER_CONFIG_DIR — 覆盖配置目录

use crate::services::library::SearchResult;
use crate::services::notes::{default_store, AppError, NoteMetadata, SaveNoteRequest};
use serde::Serialize;
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
         \n\
         子命令:\n\
           list                          列出所有笔记（仅元数据）\n\
           get <id>                      获取笔记完整内容\n\
           search <query>                搜索笔记正文\n\
           daily                         打开/创建今日便笺（输出元数据）\n\
           create --title <t> [--content <c> | --stdin]\n\
                                         创建新笔记。--stdin 从标准输入读取内容\n\
           export <id>                   导出笔记为 Markdown 文本\n\
         \n\
         环境变量:\n\
           FLORAL_NOTEPAPER_DATA_DIR     数据目录路径\n\
         \n\
         示例:\n\
           floral-notepaper --cli list\n\
           floral-notepaper --cli get abc123\n\
           floral-notepaper --cli search \"齿轮强度\"\n\
           floral-notepaper --cli create --title \"新笔记\" --content \"# Hello\"\n\
           echo \"# 内容来自管道\" | floral-notepaper --cli create --title \"管道笔记\" --stdin\n\
           floral-notepaper --cli export abc123 > note.md"
    );
}

pub fn run_cli(mut args: impl Iterator<Item = String>) {
    let subcommand = match args.next() {
        Some(cmd) => cmd,
        None => {
            print_help();
            process::exit(1);
        }
    };

    if let Err(e) = run_subcommand(&subcommand, args) {
        print_json(&CliOutput::<()>::fail(e));
        process::exit(1);
    }
}

fn run_subcommand(cmd: &str, mut args: impl Iterator<Item = String>) -> CliResult<()> {
    match cmd {
        "list" => {
            let store = default_store().cli()?;
            let notes = store.list_notes().cli()?;
            print_json(&CliOutput::success(&ListOutput {
                count: notes.len(),
                notes,
            }));
            Ok(())
        }
        "get" => {
            let id = args.next().unwrap_or_default();
            if id.is_empty() || id == "--help" {
                eprintln!("用法: floral-notepaper --cli get <note-id>");
                process::exit(1);
            }
            let store = default_store().cli()?;
            let note = store.read_note(&id).cli()?;
            print_json(&CliOutput::success(&note));
            Ok(())
        }
        "search" => {
            let query = args.next().unwrap_or_default();
            if query.is_empty() || query == "--help" {
                eprintln!("用法: floral-notepaper --cli search <关键词>");
                process::exit(1);
            }
            let store = default_store().cli()?;
            let results = store.search_content(&query).cli()?;
            print_json(&CliOutput::success(&SearchOutput {
                query: query.clone(),
                count: results.len(),
                results,
            }));
            Ok(())
        }
        "daily" => {
            let store = default_store().cli()?;
            let note = store.open_daily_note().cli()?;
            print_json(&CliOutput::success(&note));
            Ok(())
        }
        "create" => {
            let mut title = String::new();
            let mut content = String::new();
            let mut use_stdin = false;

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--title" => {
                        title = args.next().unwrap_or_default();
                    }
                    "--content" => {
                        content = args.next().unwrap_or_default();
                    }
                    "--stdin" => {
                        use_stdin = true;
                    }
                    _ => {
                        eprintln!("未知参数: {arg}");
                        eprintln!(
                            "用法: floral-notepaper --cli create --title <标题> [--content <内容> | --stdin]"
                        );
                        process::exit(1);
                    }
                }
            }

            if use_stdin {
                let mut buf = String::new();
                io::stdin()
                    .read_to_string(&mut buf)
                    .map_err(|e| format!("读取 stdin 失败: {e}"))?;
                content = buf;
            }

            if title.is_empty() {
                eprintln!("错误: 必须提供 --title");
                process::exit(1);
            }

            let store = default_store().cli()?;
            let request = SaveNoteRequest {
                title,
                content,
                category: String::new(),
                tags: vec![],
                pinned: false,
            };
            let note = store.create_note(request).cli()?;
            print_json(&CliOutput::success(&note));
            Ok(())
        }
        "export" => {
            let id = args.next().unwrap_or_default();
            if id.is_empty() || id == "--help" {
                eprintln!("用法: floral-notepaper --cli export <note-id>");
                process::exit(1);
            }
            let store = default_store().cli()?;
            let note = store.read_note(&id).cli()?;
            println!("{}", note.content);
            Ok(())
        }
        "--help" | "-h" => {
            print_help();
            process::exit(0);
        }
        _ => {
            eprintln!("未知子命令: {cmd}");
            print_help();
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
