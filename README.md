<!-- markdownlint-disable -->

**简体中文** | [繁體中文](README_zh-HK.md) | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="花笺图标">

# 花笺 · 增强版

> 把零散念头轻轻收进本地。

一个本地优先、支持 Markdown 与桌面便签的轻量笔记工具。没有账号，没有云端依赖，你的每一个字都留在你自己的电脑里。

由 [TheEarlyWinter](https://github.com/TheEarlyWinter) 持续维护
基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的 Tauri 2 + React 项目构建

[下载最新版](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [提交问题](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [更新记录](https://github.com/TheEarlyWinter/floral-notepaper/releases)

[![Release](https://img.shields.io/github/v/release/TheEarlyWinter/floral-notepaper?label=release&color=24C8D8)](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Rust](https://img.shields.io/badge/Rust-1.96-orange?logo=rust)
![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)
![Rust Tests](https://img.shields.io/badge/Rust_Tests-210_passed-green)
![Frontend Tests](https://img.shields.io/badge/Frontend_Tests-247_passed-green)

</div>

<!-- markdownlint-restore -->

---

## 目录

- [这是什么](#这是什么)
- [相对原版增强了什么](#相对原版增强了什么)
- [特性](#特性)
  - [写作与整理](#写作与整理)
  - [桌面磁贴与快速便签](#桌面磁贴与快速便签)
  - [笔记之间的连接](#笔记之间的连接)
  - [知识发现](#知识发现)
  - [提醒与每日节奏](#提醒与每日节奏)
  - [性能与基础设施](#性能与基础设施)
  - [数据安全与未保存保护](#数据安全与未保存保护)
- [MCP 与 CLI 快速上手](#mcp-与-cli-快速上手)
- [常用快捷键](#常用快捷键)
- [下载与安装](#下载与安装)
- [从源码运行](#从源码运行)
- [数据与隐私](#数据与隐私)
- [技术栈](#技术栈)
- [上游与许可](#上游与许可)

---

## 这是什么

花笺面向那些想把笔记留在自己电脑里、又希望记录过程足够顺手的人。

它可以是一张随时唤出的便签，也可以是一套轻量的 Markdown 笔记库：写下一个待办、整理每日记录、把几篇笔记连起来，或者把一条提醒留给未来的自己。没有账号、没有云端依赖，数据由你自己保管。

## 相对原版增强了什么

在上游 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 轻量便签与 Markdown 基础之上，本增强版重点补齐了本地检索、自动化集成与知识管理能力：

| 方向               | 增强版核心能力                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **检索与编辑**     | SQLite FTS5（trigram）中英文增量全文检索、`Ctrl+K` 命令面板、`Ctrl+F` / `Ctrl+H` 正则查找替换与编辑/预览双区高亮           |
| **AI 与自动化**    | 内置原生 Rust `--mcp`（14 个工具 + 4 个 `floral://` 只读资源/模板）与 `--cli` 命令行接口，跨进程文件锁 + GUI 自动热刷新    |
| **速记与桌面磁贴** | 独立悬浮「闪念快捕条」（`Alt+Shift+Space`）、桌面磁贴支持 `--ttl` 定时自动关闭 / `--persist` 常驻、缩至 140×96 迷你模式    |
| **知识连接**       | `[[` 双向链接自动补全与点击跳转、反向链接 + 纯本地 BM25 相关笔记推荐、力导向知识图谱、目录大纲                             |
| **整理与同步**     | 跨笔记待办聚合回写、侧栏多选批量管理、粘贴/拖入图片自动 WebP 压缩、blake3 版本去重历史、可选 WebDAV / Git 同步（默认关闭） |
| **可靠性与安全**   | 原子保存与失败回滚、关窗强制落盘、备份原子恢复、SVG 脚本过滤、简中 / 香港繁中 / 英文三语界面                               |

## 特性

### 写作与整理

- **Markdown 编辑、预览与分栏模式**：支持 GFM、任务列表、表格、数学公式、代码块等常用格式，分栏支持高精度双向同步滚动；预览区与桌面磁贴支持直接点击勾选任务列表并回写源码。
- **笔记内查找替换与图片压缩**：支持 `Ctrl+F` / `Ctrl+H` 正则查找、编辑/预览双区命中高亮与原生撤销栈替换；粘贴/拖入图片自动转 WebP（支持质量调节，自动跳过小图与动图）。
- **命令面板**：主窗口内通过 `Ctrl+K`（可在设置中自定义录制）一键呼出，融合本地过滤、FTS5 全文检索摘要、`>` 命令模式与快速新建笔记。
- **模板与每日便笺**：保存常用笔记模板，一键套用；每日便笺按本地时区打开，凌晨也不会开错「昨天」。
- **版本历史**：自动保留最近 20 份正文版本，blake3 哈希去重，内容未变不重复存储，可按需一键恢复。
- **分类、标签、置顶与批量管理**：归类、加标签、置顶，支持组合筛选与侧栏「多选」模式（一键批量移分类、加标签、导出或二次确认删除）；从分类标题可直接在指定分类中新建笔记。
- **增强搜索**：支持 `tag:标签`、`in:分类`、`pinned` 与 `unpinned` 查询。
- **待办聚合**：从所有笔记汇总未完成任务，面板中勾选后直接回写原 Markdown。
- **外部文件支持**：安全打开外部 Markdown 与 TXT 文件，识别 UTF-8 BOM、UTF-16 BOM 与 GBK 编码；相对图片按白名单安全显示。
- **专注写作与沉浸阅读**：一键收起侧栏与工具栏进入无干扰写作；沉浸阅读强制全屏预览，适合回看长笔记。

### 桌面磁贴与快速便签

- **随时唤出的便签与闪念快捕条**：托盘或全局快捷键快速记录；独立悬浮「闪念快捕条」（默认 `Alt+Shift+Space`，支持自定义）可一键切换保存至收件箱或追加至今日便笺。
- **桌面磁贴**：把笔记固定在桌面一角，支持缩至 140×96 的迷你尺寸；「磁贴仅在桌面显示」选项让普通窗口不再遮挡。
- **关窗不丢字**：关闭便签窗口前自动保存未完成内容。

### 笔记之间的连接

- **内部链接与 `[[` 补全**：编辑正文输入 `[[` 弹出候选列表实时插入链接；支持 `[[笔记标题]]` 与 `[[note:笔记ID|显示文字]]`，预览直接点击或编辑区 `Ctrl+点击` 直达目标笔记。
- **反向链接与本地相关笔记**：查看哪些笔记提到了当前笔记，并在同一面板结合本地 BM25 与标签相似度推荐相关笔记，一键插入关联。
- **导航历史**：笔记间跳转后可通过 `Alt+←` / `Alt+→` 轻松回溯。

### 知识发现

- **目录大纲**：自动提取标题层级，侧栏一键跳转，含加粗、链接的标题也能准确定位。
- **知识图谱**：力导向图可视化笔记引用关系网，按分类着色，点击节点直达笔记。
- **每周回顾**：仪表盘卡片汇总本周新建、更新、字数与完成待办，一键生成回顾草稿。

### 提醒与每日节奏

- **一次性本地提醒**：为当前笔记设置提醒，到点后唤起窗口并打开关联笔记。
- **可靠送达**：提醒确认送达后才标记完成，窗口唤起失败自动重试，不丢提醒。
- **收件箱「明天看」**：收件箱每条笔记一键设置明早 9 点提醒，延时阅读不遗忘。

> [!NOTE]
> 提醒为「应用运行时提醒」：花笺彻底退出后不作为系统常驻服务；下次启动时会补发仍未触发的过期提醒。

### 性能与基础设施

- **FTS5 全文搜索**：SQLite FTS5 增量索引，trigram tokenizer 支持中英文混合搜索，速度远超旧版全量遍历。
- **版本去重存储**：blake3 哈希去重，内容未变时不重复存储，节省 80%+ 磁盘空间。
- **CLI 命令行接口**：`--cli list|get|search|daily|create|append|update|delete|todos|remind|pin-tile|export`（支持 `--ttl` / `--persist` 桌面磁贴超时控制），方便脚本批量操作与管道集成。
- **内置 MCP Server**：`--mcp` 提供原生 Rust stdio JSON-RPC 2.0 接口（14 个工具 + 4 个 `floral://` 只读资源/模板），设置页自带客户端预设配置一键复制与最近外部活动日志。
- **可选跨设备云同步**：默认关闭，可在设置中按需开启 WebDAV 或 Git 同步（凭据安全存入系统钥匙串、自动冲突备份）。
- **双进程安全与 GUI 热刷新**：CLI/MCP 与图形界面并发写入由跨进程文件锁串行，外部写入后 GUI 自动热刷新（未保存内容受保护不被覆盖）。

### 数据安全与未保存保护

- **本地优先**：笔记、设置、版本历史与提醒全部保存在本机数据目录，可随时迁移。
- **保存兜底**：正文写入失败自动回滚，不会出现「新正文配旧标题」；保存失败会阻止离开当前笔记，绝不静默丢内容。
- **关闭即落盘**：Ctrl+W、关闭窗口、切换笔记、恢复备份前，都会先强制保存未完成内容。
- **备份原子恢复**：整体暂存 + 原子替换 + 失败回滚，中途断电也不留半恢复状态；拒绝 zip 路径穿越与超大压缩包。
- **提醒自愈**：提醒文件损坏时自动重建，损坏副本保留备查。
- **导入安全**：SVG 图片拒绝内嵌脚本，收紧 XSS 面。

## MCP 与 CLI 快速上手

花笺内置原生 Rust stdio MCP Server（`--mcp`），无需额外安装运行时。打开「应用设置 → MCP 与 CLI 集成」可自动识别当前程序路径，一键复制 Antigravity、Claude Code、Codex 或通用客户端配置，并查看近期外部调用日志。

标准 `mcpServers` 配置示例（绿色版或自定义路径请替换为实际可执行文件路径；Claude Code 预设可从设置页复制含 `"type": "stdio"` 的片段）：

```json
{
  "mcpServers": {
    "floral-notepaper": {
      "command": "C:\\Program Files\\花笺\\floral-notepaper.exe",
      "args": ["--mcp"]
    }
  }
}
```

内置 4 项只读 MCP 资源 / 模板：`floral://daily`（今日便笺）、`floral://todos/pending`（未完成待办）、`floral://notes`（笔记元数据列表）、`floral://note/{id}`（按 ID 读取正文）。

常用 CLI 示例（所有命令均输出结构化 JSON，支持 `--stdin` 管道与环境变量 `FLORAL_NOTEPAPER_DATA_DIR`）：

```bash
# 全文搜索笔记
floral-notepaper --cli search "关键词"

# 向今日便笺追加一条待办
floral-notepaper --cli append daily --content "- [ ] 整理周报"

# 列出全部未完成待办
floral-notepaper --cli todos list --pending

# 将笔记钉到桌面磁贴（默认 300 秒后自动关闭；传 --persist 常驻）
floral-notepaper --cli pin-tile <note-id> --ttl 600
```

## 常用快捷键

| 快捷键              | 作用                        | 范围 / 备注                                         |
| ------------------- | --------------------------- | --------------------------------------------------- |
| `Ctrl+Space`        | 唤出 / 聚焦快速便签         | 全局（macOS 默认 `Command+Option+N`，可在设置修改） |
| `Alt+Shift+Space`   | 唤出悬浮「闪念快捕条」      | 全局（可在设置修改）                                |
| `Ctrl+K`            | 打开 / 关闭命令面板         | 主窗口（可在设置修改）                              |
| `Ctrl+F` / `Ctrl+H` | 笔记内查找 / 查找并替换     | 主窗口编辑区（支持大小写与正则）                    |
| `Ctrl+S`            | 立即保存当前笔记            | 主窗口                                              |
| `Ctrl+W`            | 关闭当前标签页              | 主窗口（可在设置修改，关闭前自动落盘）              |
| `Alt+←` / `Alt+→`   | 笔记浏览历史后退 / 前进     | 主窗口                                              |
| `[[` / `Ctrl+点击`  | 双向链接补全 / 跳转目标笔记 | 编辑区（预览区直接左键点击跳转）                    |
| `Ctrl+右键`         | 快速关闭桌面磁贴            | 桌面磁贴（可在设置中开关）                          |

## 下载与安装

前往 [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) 下载最新版。

| 文件                                    | 适用场景                                                   |
| --------------------------------------- | ---------------------------------------------------------- |
| `floral-notepaper_版本号_x64-setup.exe` | **Windows x64 安装版**，推荐大多数用户使用。               |
| `floral-notepaper_版本号.exe`           | **Windows x64 绿色版**，下载后可直接运行，不写入安装目录。 |
| `SHA256SUMS.txt`                        | 全部发布包的 SHA-256 校验值。                              |
| `BUILD-INFO.txt`                        | 构建版本、提交哈希与构建时间信息。                         |

> [!WARNING]
> 当前发布包尚未做商业代码签名，首次运行时 Windows 可能提示未知发布者。请仅从本仓库的 Release 页面下载，并按需核验 `SHA256SUMS.txt`。

## 从源码运行

### 环境

- Node.js 20+
- Rust stable
- Windows 上构建桌面程序还需要 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

### 命令

```bash
npm install
npm run tauri dev
```

测试与发布构建：

```bash
npm run lint
npm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib
npx tauri build --bundles nsis
```

## 数据与隐私

花笺默认纯本地运行，不要求注册账号，也不会主动上传任何笔记内容。WebDAV / Git 跨设备同步默认关闭，仅在你手动开启后与自选远端同步，且密码与访问令牌仅保存在系统安全凭据库中（不以明文写入配置文件）。数据目录可在应用设置中查看或迁移；在迁移、清理或覆盖数据前，请自行备份重要笔记。

## 技术栈

| 层       | 技术                                   |
| -------- | -------------------------------------- |
| 桌面框架 | [Tauri 2](https://tauri.app/)          |
| 前端     | React 19 + TypeScript + Vite           |
| 后端     | Rust 1.96                              |
| 全文索引 | SQLite FTS5（trigram）                 |
| 版本去重 | blake3 哈希                            |
| 发布     | GitHub Actions 自动构建 + 草稿 Release |

## 上游与许可

本仓库是 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的衍生维护版本，感谢上游项目及其贡献者提供坚实的基础。

本项目依照 [MIT License](LICENSE) 发布。原始版权与许可声明均在仓库中保留。
