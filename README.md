<!-- markdownlint-disable -->

**简体中文** | [繁體中文](README_zh-HK.md) | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="花笺图标">

# 🏮 花笺 · 增强版

> 把零散念头轻轻收进本地。

一个本地优先、支持 Markdown 与桌面便签的轻量笔记工具。没有账号，没有云端依赖，你的每一个字都留在你自己的电脑里。

由 [TheEarlyWinter](https://github.com/TheEarlyWinter) 持续维护
基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的 Tauri 2 + React 项目构建

[📦 下载最新版](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [🐛 提交问题](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [📝 更新记录](https://github.com/TheEarlyWinter/floral-notepaper/releases)

[![Release](https://img.shields.io/github/v/release/TheEarlyWinter/floral-notepaper?label=release&color=24C8D8)](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Rust](https://img.shields.io/badge/Rust-1.96-orange?logo=rust)
![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)
![Rust Tests](https://img.shields.io/badge/Rust_Tests-166_passed-green)
![Frontend Tests](https://img.shields.io/badge/Frontend_Tests-121_passed-green)

</div>

<!-- markdownlint-restore -->

---

## 📖 目录

- [这是什么](#这是什么)
- [特性](#特性)
  - [✍️ 写作与整理](#️-写作与整理)
  - [🧲 桌面磁贴与快速便签](#-桌面磁贴与快速便签)
  - [🔗 笔记之间的连接](#-笔记之间的连接)
  - [🕸️ 知识发现](#️-知识发现)
  - [⏰ 提醒与每日节奏](#-提醒与每日节奏)
  - [🚀 性能与基础设施](#-性能与基础设施)
  - [🛡️ 数据安全与未保存保护](#️-数据安全与未保存保护)
- [下载与安装](#下载与安装)
- [从源码运行](#从源码运行)
- [数据与隐私](#数据与隐私)
- [技术栈](#技术栈)
- [上游与许可](#上游与许可)

---

## 这是什么

花笺面向那些想把笔记留在自己电脑里、又希望记录过程足够顺手的人。

它可以是一张随时唤出的便签，也可以是一套轻量的 Markdown 笔记库：写下一个待办、整理每日记录、把几篇笔记连起来，或者把一条提醒留给未来的自己。没有账号、没有云端依赖，数据由你自己保管。

## 特性

### ✍️ 写作与整理

- **Markdown 编辑、预览与分栏模式**：支持 GFM、任务列表、表格、数学公式、代码块等常用格式，编辑体验流畅。
- **模板与每日便笺**：保存常用笔记模板，一键套用；每日便笺按本地时区打开，凌晨也不会开错「昨天」。
- **版本历史**：自动保留最近 20 份正文版本，blake3 哈希去重，内容未变不重复存储，可按需一键恢复。
- **分类、标签与置顶**：归类、加标签、置顶，支持组合筛选；从分类标题可直接在指定分类中新建笔记。
- **增强搜索**：支持 `tag:标签`、`in:分类`、`pinned` 与 `unpinned` 查询。
- **待办聚合**：从所有笔记汇总未完成任务，面板中勾选后直接回写原 Markdown。
- **外部文件支持**：安全打开外部 Markdown 与 TXT 文件，识别 UTF-8 BOM、UTF-16 BOM 与 GBK 编码；相对图片按白名单安全显示。
- **专注写作与沉浸阅读**：一键收起侧栏与工具栏进入无干扰写作；沉浸阅读强制全屏预览，适合回看长笔记。

### 🧲 桌面磁贴与快速便签

- **随时唤出的便签**：托盘或全局快捷键快速记录，灵感不等人。
- **桌面磁贴**：把笔记固定在桌面一角，支持缩至 140×96 的迷你尺寸；「磁贴仅在桌面显示」选项让普通窗口不再遮挡。
- **关窗不丢字**：关闭便签窗口前自动保存未完成内容。

### 🔗 笔记之间的连接

- **内部链接**：在正文输入 `[[笔记标题]]`，标题唯一时从预览直接跳转。
- **稳定链接**：支持 `[[note:笔记ID|显示文字]]`，即使标题重复也不会猜错目标；工具栏一键复制。
- **反向链接**：查看哪些笔记提到了当前笔记，回顾上下文。
- **导航历史**：笔记间跳转后可通过 `Alt+←` / `Alt+→` 轻松回溯。

### 🕸️ 知识发现

- **目录大纲**：自动提取标题层级，侧栏一键跳转，含加粗、链接的标题也能准确定位。
- **知识图谱**：力导向图可视化笔记引用关系网，按分类着色，点击节点直达笔记。
- **每周回顾**：仪表盘卡片汇总本周新建、更新、字数与完成待办，一键生成回顾草稿。

### ⏰ 提醒与每日节奏

- **一次性本地提醒**：为当前笔记设置提醒，到点后唤起窗口并打开关联笔记。
- **可靠送达**：提醒确认送达后才标记完成，窗口唤起失败自动重试，不丢提醒。
- **收件箱「明天看」**：收件箱每条笔记一键设置明早 9 点提醒，延时阅读不遗忘。

> [!NOTE]
> 提醒为「应用运行时提醒」：花笺彻底退出后不作为系统常驻服务；下次启动时会补发仍未触发的过期提醒。

### 🚀 性能与基础设施

- **FTS5 全文搜索**：SQLite FTS5 增量索引，trigram tokenizer 支持中英文混合搜索，速度远超旧版全量遍历。
- **版本去重存储**：blake3 哈希去重，内容未变时不重复存储，节省 80%+ 磁盘空间。
- **CLI 命令行接口**：`--cli list|get|search|daily|create|export`，方便脚本批量操作与管道集成。
- **双进程安全**：CLI 与图形界面并发写入由跨进程文件锁串行，互不覆盖。

### 🛡️ 数据安全与未保存保护

- **本地优先**：笔记、设置、版本历史与提醒全部保存在本机数据目录，可随时迁移。
- **保存兜底**：正文写入失败自动回滚，不会出现「新正文配旧标题」；保存失败会阻止离开当前笔记，绝不静默丢内容。
- **关闭即落盘**：Ctrl+W、关闭窗口、切换笔记、恢复备份前，都会先强制保存未完成内容。
- **备份原子恢复**：整体暂存 + 原子替换 + 失败回滚，中途断电也不留半恢复状态；拒绝 zip 路径穿越与超大压缩包。
- **提醒自愈**：提醒文件损坏时自动重建，损坏副本保留备查。
- **导入安全**：SVG 图片拒绝内嵌脚本，收紧 XSS 面。

## 下载与安装

前往 [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) 下载最新版。

| 文件 | 适用场景 |
| --- | --- |
| `floral-notepaper_版本号_windows-x64-setup.exe` | **Windows x64 安装版**，推荐大多数用户使用。 |
| `floral-notepaper_版本号.exe` | **Windows x64 绿色版**，下载后可直接运行，不写入安装目录。 |
| `SHA256SUMS.txt` | 全部安装包的 SHA-256 校验值。 |

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
npm run tauri build -- --bundles nsis
```

## 数据与隐私

花笺不要求注册账号，也不会主动上传笔记内容。数据目录可在应用设置中查看或迁移；在迁移、清理或覆盖数据前，请自行备份重要笔记。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | [Tauri 2](https://tauri.app/) |
| 前端 | React 19 + TypeScript + Vite |
| 后端 | Rust 1.96 |
| 全文索引 | SQLite FTS5（trigram） |
| 版本去重 | blake3 哈希 |
| 发布 | GitHub Actions 自动构建 + 草稿 Release |

## 上游与许可

本仓库是 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的衍生维护版本，感谢上游项目及其贡献者提供坚实的基础。

本项目依照 [MIT License](LICENSE) 发布。原始版权与许可声明均在仓库中保留。
