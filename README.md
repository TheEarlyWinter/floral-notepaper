<!-- markdownlint-disable -->

**简体中文** | [繁體中文](README_zh-HK.md) | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="花笺图标">

# 花笺 · 增强版

把零散念头轻轻收进本地。<br>
一个本地优先、支持 Markdown 与桌面便签的轻量笔记工具。

由 [TheEarlyWinter](https://github.com/TheEarlyWinter) 持续维护<br>
基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的 Tauri 2 + React 项目构建

[下载最新版](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [提交问题](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [更新记录](https://github.com/TheEarlyWinter/floral-notepaper/releases)

[![Release](https://img.shields.io/github/v/release/TheEarlyWinter/floral-notepaper?label=release)](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)

</div>

<!-- markdownlint-restore -->

---

## 这是什么

花笺增强版面向那些想把笔记留在自己电脑里、又希望记录过程足够顺手的人。

它可以是一张随时唤出的便签，也可以是一套轻量的 Markdown 笔记库：写下一个待办、整理每日记录、把几篇笔记连起来，或者把一条提醒留给未来的自己。没有账号、没有云端依赖，数据由你自己保管。

## 已实现功能

### 写作与整理

- **Markdown 编辑、预览与分栏模式**：支持 GFM、任务列表、表格、数学公式、代码块和常用 Markdown 格式。
- **快速便签与磁贴**：可通过托盘或全局快捷键快速记录，也可把笔记固定在桌面一角。
- **分类、标签与置顶**：给笔记归类、加标签、置顶，并支持组合筛选。
- **增强搜索**：支持 `tag:标签`、`in:分类`、`pinned` 与 `unpinned` 查询。
- **待办聚合**：从所有笔记汇总未完成任务，在面板中勾选后直接回写原 Markdown。
- **模板与每日便笺**：保存常用笔记模板；同一天可重复打开同一篇每日便笺。
- **版本历史**：自动保留最近 20 份正文版本，可按需恢复。

### 笔记之间的连接

- **内部链接**：在正文输入 `[[笔记标题]]`，标题唯一时可从预览直接跳转。
- **稳定链接**：支持 `[[note:笔记ID|显示文字]]`；即使标题重复，也不会猜错目标。
- **反向链接**：查看哪些笔记提到了当前笔记。
- **复制稳定链接**：工具栏可一键复制当前笔记的稳定链接，方便插入其他笔记。

### 提醒与本地数据

- **一次性本地提醒**：为当前笔记设置提醒、查看和删除未到期提醒。
- **到点回到笔记**：花笺运行时会检查提醒，到点后唤起窗口、显示应用内提示并打开关联笔记。
- **本地优先**：笔记、设置、版本历史和提醒都保存于本机数据目录。
- **导入与导出**：支持 `.md` 文件导入、导出与外部 Markdown 文件编辑。

> [!NOTE]
> 提醒当前是“应用运行时提醒”：花笺彻底退出后不会作为系统常驻服务运行；下次启动时会补发仍未触发的过期提醒。

## 下载与安装

前往 [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) 下载最新版。

| 文件 | 适用场景 |
| --- | --- |
| `花笺_版本号_x64-setup.exe` | **Windows x64 安装版**，推荐大多数用户使用。|
| `花笺_版本号_x64.exe` | **Windows x64 绿色版**，下载后可直接运行，不写入安装目录。|
| `floral-notepaper-版本号-source.zip` | 与发布标签对应的完整源码包。|

首次运行时，Windows 可能会提示未知发布者。这是因为当前发布包尚未做商业代码签名；请仅从本仓库的 Release 页面下载，并按需核验发布页提供的 SHA-256 值。

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
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build -- --bundles nsis
```

## 数据与隐私

花笺不要求注册账号，也不会主动上传笔记内容。数据目录可在应用设置中查看或迁移；在迁移、清理或覆盖数据前，请自行备份重要笔记。

## 上游与许可

本仓库是 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的衍生维护版本，感谢上游项目及其贡献者提供坚实的基础。

本项目依照 [MIT License](LICENSE) 发布。原始版权与许可声明均在仓库中保留。
