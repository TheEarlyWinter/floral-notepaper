<!-- markdownlint-disable -->

[简体中文](README.md) | [繁體中文](README_zh-HK.md) | **English**

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="Floral Notepaper icon">

# 🏮 Floral Notepaper · Enhanced

> Tuck your scattered thoughts quietly into your local disk.

A local-first, lightweight Markdown note-taking app with desktop sticky notes. No account, no cloud dependency — every word you write stays on your own machine.

Maintained by [TheEarlyWinter](https://github.com/TheEarlyWinter)
Built on the [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) Tauri 2 + React project

[📦 Download Latest](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [🐛 Report Issues](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [📝 Changelog](https://github.com/TheEarlyWinter/floral-notepaper/releases)

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

## 📖 Table of Contents

- [What is it](#what-is-it)
- [Features](#features)
  - [✍️ Writing & Organizing](#️-writing--organizing)
  - [🧲 Desktop Tiles & Quick Notes](#-desktop-tiles--quick-notes)
  - [🔗 Connecting Notes](#-connecting-notes)
  - [🕸️ Knowledge Discovery](#️-knowledge-discovery)
  - [⏰ Reminders & Daily Rhythm](#-reminders--daily-rhythm)
  - [🚀 Performance & Infrastructure](#-performance--infrastructure)
  - [🛡️ Data Safety & Unsaved-Content Protection](#️-data-safety--unsaved-content-protection)
- [Download & Install](#download--install)
- [Run from Source](#run-from-source)
- [Data & Privacy](#data--privacy)
- [Tech Stack](#tech-stack)
- [Upstream & License](#upstream--license)

---

## What is it

Floral Notepaper is for people who want to keep their notes on their own computer while keeping the writing experience smooth and pleasant.

It can be a sticky note summoned at any moment, or a lightweight Markdown notebook: jot down a todo, keep a daily log, link notes together, or leave a reminder for your future self. No account, no cloud dependency — your data belongs to you.

## Features

### ✍️ Writing & Organizing

- **Edit / Split / Preview modes**: GFM, task lists, tables, math formulas, code blocks and more.
- **Templates & Daily Note**: save reusable templates; the daily note opens in your local timezone, so it is never "yesterday's" note at midnight.
- **Version History**: keep the last 20 revisions per note with blake3 deduplication; restore any revision with one click.
- **Categories, Tags & Pinning**: organize, filter, and create a new note directly from a category header.
- **Enhanced Search**: supports `tag:label`, `in:category`, `pinned` and `unpinned` queries.
- **Todo Aggregation**: collect unfinished tasks from all notes; checking a box writes back to the source Markdown.
- **External Files**: safely open external Markdown/TXT with UTF-8 BOM, UTF-16 BOM and GBK detection; relative images are served through a whitelist.
- **Focus Writing & Immersive Reading**: collapse side panels and toolbars for distraction-free writing; immersive reading renders the preview fullscreen.

### 🧲 Desktop Tiles & Quick Notes

- **Quick capture**: summon a note from the tray or a global shortcut.
- **Desktop tiles**: pin a note to a corner of your screen, down to 140×96 px; "tiles on desktop only" keeps normal windows from covering them.
- **No data loss on close**: unsaved content is saved automatically before a note window closes.

### 🔗 Connecting Notes

- **Internal links**: `[[Note Title]]` jumps directly from the preview when the title is unique.
- **Stable links**: `[[note:noteID|display text]]` never guesses the wrong target, even with duplicate titles; copy with one click.
- **Backlinks**: see which notes mention the current note.
- **Navigation history**: step back and forth between notes with `Alt+←` / `Alt+→`.

### 🕸️ Knowledge Discovery

- **Outline panel**: auto-extracted heading hierarchy with one-click jumps; headings with bold or links are located precisely.
- **Knowledge graph**: force-directed visualization of the note link network, colored by category; click a node to open the note.
- **Weekly review**: a dashboard card summarizing new notes, edits, word counts and completed todos; generate a review draft in one click.

### ⏰ Reminders & Daily Rhythm

- **One-shot local reminders**: set a reminder on a note; when the time comes, the window is raised and the note opens.
- **Reliable delivery**: a reminder is marked done only after it is actually delivered; failed wake-ups are retried, never silently dropped.
- **Inbox "Read Tomorrow"**: schedule any inbox note for 9 AM tomorrow with one click.

> [!NOTE]
> Reminders are "app-running" reminders: when the app is fully closed, it does not run as a system service; overdue reminders are delivered on next launch.

### 🚀 Performance & Infrastructure

- **FTS5 full-text search**: SQLite FTS5 incremental index with trigram tokenizer for mixed Chinese/English search — far faster than full scans.
- **Deduplicated storage**: blake3 hashing avoids re-storing unchanged versions, saving 80%+ disk space.
- **CLI**: `--cli list|get|search|daily|create|export` for scripting and piping.
- **Cross-process safety**: CLI and GUI writes are serialized by cross-process file locks.

### 🛡️ Data Safety & Unsaved-Content Protection

- **Local-first**: notes, settings, version history and reminders all live in a local data directory you can migrate anytime.
- **Save fallback**: failed writes roll back atomically — no "new body with old title"; a failed save blocks navigation, so content is never silently lost.
- **Save on leave**: Ctrl+W, window close, note switch and backup restore all force-save unsaved content first.
- **Atomic backup restore**: stage + swap + rollback; a crash mid-restore leaves no half-restored state; zip traversal and zip bombs are rejected.
- **Self-healing reminders**: a corrupted reminders file is rebuilt automatically, with the damaged copy kept for inspection.
- **Import safety**: SVG images with embedded scripts are rejected, tightening the XSS surface.

## Download & Install

Grab the latest build from [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest).

| File | Use |
| --- | --- |
| `floral-notepaper_VERSION_windows-x64-setup.exe` | **Windows x64 installer**, recommended for most users. |
| `floral-notepaper_VERSION.exe` | **Windows x64 portable build**, runs directly without installation. |
| `SHA256SUMS.txt` | SHA-256 checksums for all packages. |

> [!WARNING]
> The current builds are not commercially code-signed, so Windows may show an unknown-publisher warning on first launch. Download only from this repository's Releases page and verify `SHA256SUMS.txt` when needed.

## Run from Source

### Environment

- Node.js 20+
- Rust stable
- On Windows, building desktop apps also requires [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

### Commands

```bash
npm install
npm run tauri dev
```

Tests and release build:

```bash
npm run lint
npm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build -- --bundles nsis
```

## Data & Privacy

No registration required, and note content is never uploaded. The data directory can be viewed or migrated from the app settings; please back up important notes before migrating, cleaning, or overwriting data.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop framework | [Tauri 2](https://tauri.app/) |
| Frontend | React 19 + TypeScript + Vite |
| Backend | Rust 1.96 |
| Full-text index | SQLite FTS5 (trigram) |
| Deduplication | blake3 hashing |
| Release | GitHub Actions auto-build + draft release |

## Upstream & License

This repository is a maintained fork of [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper); thanks to the upstream project and its contributors for the solid foundation.

This project is released under the [MIT License](LICENSE). Original copyright and license notices are retained in the repository.
