<!-- markdownlint-disable -->

**簡體中文** | [繁體中文](README_zh-HK.md) | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="花箋圖標">

# 🏮 花箋 · 增強版

> 把零散念頭輕輕收進本地。

一個本地優先、支持 Markdown 與桌面便籤的輕量筆記工具。沒有賬號，沒有雲端依賴，你的每一個字都留在你自己的電腦裡。

由 [TheEarlyWinter](https://github.com/TheEarlyWinter) 持續維護
基於 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的 Tauri 2 + React 項目構建

[📦 下載最新版](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [🐛 提交問題](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [📝 更新記錄](https://github.com/TheEarlyWinter/floral-notepaper/releases)

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

## 📖 目錄

- [這是什麼](#這是什麼)
- [特性](#特性)
  - [✍️ 寫作與整理](#寫作與整理)
  - [🧲 桌面磁貼與快速便籤](#桌面磁貼與快速便籤)
  - [🔗 筆記之間的連接](#筆記之間的連接)
  - [🕸️ 知識發現](#知識發現)
  - [⏰ 提醒與每日節奏](#提醒與每日節奏)
  - [🚀 性能與基礎設施](#性能與基礎設施)
  - [🛡️ 數據安全與未保存保護](#數據安全與未保存保護)
- [下載與安裝](#下載與安裝)
- [從源碼運行](#從源碼運行)
- [數據與隱私](#數據與隱私)
- [技術棧](#技術棧)
- [上游與許可](#上游與許可)

---

## 這是什麼

花箋面向那些想把筆記留在自己電腦裡、又希望記錄過程足夠順手的人。

它可以是一張隨時喚出的便籤，也可以是一套輕量的 Markdown 筆記庫：寫下一個待辦、整理每日記錄、把幾篇筆記連起來，或者把一條提醒留給未來的自己。沒有賬號、沒有雲端依賴，數據由你自己保管。

## 特性

### ✍️ 寫作與整理

- **Markdown 編輯、預覽與分欄模式**：支持 GFM、任務列表、表格、數學公式、代碼塊等常用格式，編輯體驗流暢。
- **模板與每日便箋**：保存常用筆記模板，一鍵套用；每日便箋按本地時區打開，凌晨也不會開錯「昨天」。
- **版本歷史**：自動保留最近 20 份正文版本，blake3 哈希去重，內容未變不重複存儲，可按需一鍵恢復。
- **分類、標籤與置頂**：歸類、加標籤、置頂，支持組合篩選；從分類標題可直接在指定分類中新建筆記。
- **增強搜索**：支持 `tag:標籤`、`in:分類`、`pinned` 與 `unpinned` 查詢。
- **待辦聚合**：從所有筆記彙總未完成任務，面板中勾選後直接回寫原 Markdown。
- **外部文件支持**：安全打開外部 Markdown 與 TXT 文件，識別 UTF-8 BOM、UTF-16 BOM 與 GBK 編碼；相對圖片按白名單安全顯示。
- **專注寫作與沉浸閱讀**：一鍵收起側欄與工具欄進入無干擾寫作；沉浸閱讀強制全屏預覽，適合回看長筆記。

### 🧲 桌面磁貼與快速便籤

- **隨時喚出的便籤**：托盤或全局快捷鍵快速記錄，靈感不等人。
- **桌面磁貼**：把筆記固定在桌面一角，支持縮至 140×96 的迷你尺寸；「磁貼僅在桌面顯示」選項讓普通窗口不再遮擋。
- **關窗不丟字**：關閉便籤窗口前自動保存未完成內容。

### 🔗 筆記之間的連接

- **內部鏈接**：在正文輸入 `[[筆記標題]]`，標題唯一時從預覽直接跳轉。
- **穩定鏈接**：支持 `[[note:筆記ID|顯示文字]]`，即使標題重複也不會猜錯目標；工具欄一鍵複製。
- **反向鏈接**：查看哪些筆記提到了當前筆記，回顧上下文。
- **導航歷史**：筆記間跳轉後可通過 `Alt+←` / `Alt+→` 輕鬆回溯。

### 🕸️ 知識發現

- **目錄大綱**：自動提取標題層級，側欄一鍵跳轉，含加粗、鏈接的標題也能準確定位。
- **知識圖譜**：力導向圖可視化筆記引用關係網，按分類著色，點擊節點直達筆記。
- **每週回顧**：儀表盤卡片彙總本週新建、更新、字數與完成待辦，一鍵生成回顧草稿。

### ⏰ 提醒與每日節奏

- **一次性本地提醒**：為當前筆記設置提醒，到點後喚起窗口並打開關聯筆記。
- **可靠送達**：提醒確認送達後才標記完成，窗口喚起失敗自動重試，不丟提醒。
- **收件箱「明天看」**：收件箱每條筆記一鍵設置明早 9 點提醒，延時閱讀不遺忘。

> [!NOTE]
> 提醒為「應用運行時提醒」：花箋徹底退出後不作為系統常駐服務；下次啟動時會補發仍未觸發的過期提醒。

### 🚀 性能與基礎設施

- **FTS5 全文搜索**：SQLite FTS5 增量索引，trigram tokenizer 支持中英文混合搜索，速度遠超舊版全量遍歷。
- **版本去重存儲**：blake3 哈希去重，內容未變時不重複存儲，節省 80%+ 磁盤空間。
- **CLI 命令行接口**：`--cli list|get|search|daily|create|export`，方便腳本批量操作與管道集成。
- **雙進程安全**：CLI 與圖形界面併發寫入由跨進程文件鎖串行，互不覆蓋。

### 🛡️ 數據安全與未保存保護

- **本地優先**：筆記、設置、版本歷史與提醒全部保存在本機數據目錄，可隨時遷移。
- **保存兜底**：正文寫入失敗自動回滾，不會出現「新正文配舊標題」；保存失敗會阻止離開當前筆記，絕不靜默丟內容。
- **關閉即落盤**：Ctrl+W、關閉窗口、切換筆記、恢復備份前，都會先強制保存未完成內容。
- **備份原子恢復**：整體暫存 + 原子替換 + 失敗回滾，中途斷電也不留半恢復狀態；拒絕 zip 路徑穿越與超大壓縮包。
- **提醒自愈**：提醒文件損壞時自動重建，損壞副本保留備查。
- **導入安全**：SVG 圖片拒絕內嵌腳本，收緊 XSS 面。

## 下載與安裝

前往 [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) 下載最新版。

| 文件 | 適用場景 |
| --- | --- |
| `floral-notepaper_版本號_windows-x64-setup.exe` | **Windows x64 安裝版**，推薦大多數用戶使用。 |
| `floral-notepaper_版本號.exe` | **Windows x64 綠色版**，下載後可直接運行，不寫入安裝目錄。 |
| `SHA256SUMS.txt` | 全部安裝包的 SHA-256 校驗值。 |

> [!WARNING]
> 當前發佈包尚未做商業代碼簽名，首次運行時 Windows 可能提示未知發佈者。請僅從本倉庫的 Release 頁面下載，並按需核驗 `SHA256SUMS.txt`。

## 從源碼運行

### 環境

- Node.js 20+
- Rust stable
- Windows 上構建桌面程序還需要 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

### 命令

```bash
npm install
npm run tauri dev
```

測試與發佈構建：

```bash
npm run lint
npm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build -- --bundles nsis
```

## 數據與隱私

花箋不要求註冊賬號，也不會主動上傳筆記內容。數據目錄可在應用設置中查看或遷移；在遷移、清理或覆蓋數據前，請自行備份重要筆記。

## 技術棧

| 層 | 技術 |
| --- | --- |
| 桌面框架 | [Tauri 2](https://tauri.app/) |
| 前端 | React 19 + TypeScript + Vite |
| 後端 | Rust 1.96 |
| 全文索引 | SQLite FTS5（trigram） |
| 版本去重 | blake3 哈希 |
| 發佈 | GitHub Actions 自動構建 + 草稿 Release |

## 上游與許可

本倉庫是 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的衍生維護版本，感謝上游項目及其貢獻者提供堅實的基礎。

本項目依照 [MIT License](LICENSE) 發佈。原始版權與許可聲明均在倉庫中保留。
