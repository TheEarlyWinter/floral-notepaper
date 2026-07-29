<!-- markdownlint-disable -->

[简体中文](README.md) | [繁體中文](README_zh-HK.md) | **English**

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="Floral Notepaper icon">

# Floral Notepaper · Enhanced Edition

Keep scattered thoughts on your own computer.<br>
A local-first Markdown note app with quick desktop notes.

Maintained by [TheEarlyWinter](https://github.com/TheEarlyWinter)<br>
Built on the Tauri 2 + React project [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)

[Download latest](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [Report an issue](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases)

[![Release](https://img.shields.io/github/v/release/TheEarlyWinter/floral-notepaper?label=release)](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)

</div>

<!-- markdownlint-restore -->

---

## What It Is

Floral Notepaper Enhanced Edition is for people who want their notes to stay on their own computer without giving up a comfortable writing flow.

Use it as a quick desktop note or as a lightweight Markdown library: capture a task, keep a daily page, connect related notes, and leave a reminder for your future self. No account and no cloud service are required.

## Features

### Writing and organization

- **Markdown editing, preview, and split view** with GFM, task lists, tables, math, code blocks, and common Markdown formatting.
- **Quick notes and desktop tiles** available from the tray or a global shortcut.
- **Categories, tags, and pinned notes** for lightweight organization.
- **Search filters**: `tag:tag`, `in:category`, `pinned`, and `unpinned`.
- **Aggregated to-dos** that write completion changes back to the original Markdown note.
- **Templates and daily notes** for repeatable writing workflows.
- **Version history** retaining the latest 20 content snapshots, with restore support.

### Connected notes

- **Internal links** with `[[Note title]]`; unique titles can be opened directly from preview.
- **Stable links** with `[[note:note-id|label]]`, avoiding ambiguity when titles collide.
- **Backlinks** to see which notes refer to the current note.
- **Copy stable link** from the toolbar to paste into another note.

### Reminders and local data

- **One-time local reminders** tied to the current note.
- **Return-to-note reminders**: while the app is running, due reminders bring the window forward, show an in-app alert, and open the linked note.
- **Local-first storage** for notes, settings, version history, and reminders.
- **Markdown import, export, and external file editing**.

> [!NOTE]
> Reminders currently run while Floral Notepaper is open. The app does not install a background system service; overdue, untriggered reminders are delivered when the app is next opened.

## Download

Download the latest version from [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest).

| File | Use |
| --- | --- |
| `花笺_version_x64-setup.exe` | **Windows x64 installer**, recommended for most users. |
| `花笺_version_x64.exe` | **Windows x64 portable build**, runs directly without installation. |
| `floral-notepaper-version-source.zip` | Complete source archive for the matching release tag. |

Windows may show an unknown publisher warning on first launch because the current builds are not commercially code-signed. Download only from this repository's Releases page and verify the SHA-256 checksum published with each release when needed.

## Run from Source

### Prerequisites

- Node.js 20+
- Rust stable
- On Windows, [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) for desktop builds

### Commands

```bash
npm install
npm run tauri dev
```

Test and package:

```bash
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build -- --bundles nsis
```

## Data and Privacy

Floral Notepaper does not require an account and does not proactively upload note content. The data directory can be viewed or migrated in app settings. Back up important notes before migrating, cleaning, or overwriting data.

## Upstream and License

This repository is a maintained derivative of [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper). Thanks to the upstream project and its contributors for the foundation.

This project is distributed under the [MIT License](LICENSE). Original copyright and license notices are retained.
