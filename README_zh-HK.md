<!-- markdownlint-disable -->

[简体中文](README.md) | **繁體中文** | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="花箋圖標">

# 花箋 · 增強版

> 把零散念頭輕輕收進本地。

一個本地優先、支持 Markdown 與桌面便籤的輕量筆記工具。沒有賬號，沒有雲端依賴，你的每一個字都留在你自己的電腦裡。

由 [TheEarlyWinter](https://github.com/TheEarlyWinter) 持續維護
基於 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的 Tauri 2 + React 項目構建

[下載最新版](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [提交問題](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [更新記錄](https://github.com/TheEarlyWinter/floral-notepaper/releases)

[![Release](https://img.shields.io/github/v/release/TheEarlyWinter/floral-notepaper?label=release&color=24C8D8)](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Rust](https://img.shields.io/badge/Rust-1.96-orange?logo=rust)
![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)
![Rust Tests](https://img.shields.io/badge/Rust_Tests-209_passed-green)
![Frontend Tests](https://img.shields.io/badge/Frontend_Tests-247_passed-green)

</div>

<!-- markdownlint-restore -->

---

## 目錄

- [這是什麼](#這是什麼)
- [相對原版增強了什麼](#相對原版增強了什麼)
- [特性](#特性)
  - [寫作與整理](#寫作與整理)
  - [桌面磁貼與快速便籤](#桌面磁貼與快速便籤)
  - [筆記之間的連接](#筆記之間的連接)
  - [知識發現](#知識發現)
  - [提醒與每日節奏](#提醒與每日節奏)
  - [性能與基礎設施](#性能與基礎設施)
  - [數據安全與未保存保護](#數據安全與未保存保護)
- [MCP 與 CLI 快速上手](#mcp-與-cli-快速上手)
- [常用快捷鍵](#常用快捷鍵)
- [下載與安裝](#下載與安裝)
- [從源碼運行](#從源碼運行)
- [數據與隱私](#數據與隱私)
- [技術棧](#技術棧)
- [上游與許可](#上游與許可)

---

## 這是什麼

花箋面向那些想把筆記留在自己電腦裡、又希望記錄過程足夠順手的人。

它可以是一張隨時喚出的便籤，也可以是一套輕量的 Markdown 筆記庫：寫下一個待辦、整理每日記錄、把幾篇筆記連起來，或者把一條提醒留給未來的自己。沒有賬號、沒有雲端依賴，數據由你自己保管。

## 相對原版增強了什麼

在上游 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 輕量便籤與 Markdown 基礎之上，本增強版重點補齊了本機檢索、自動化整合與知識管理能力：

| 方向               | 增強版核心能力                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **檢索與編輯**     | SQLite FTS5（trigram）中英文增量全文檢索、`Ctrl+K` 命令面板、`Ctrl+F` / `Ctrl+H` 正則搜尋替換與編輯/預覽雙區高亮           |
| **AI 與自動化**    | 內置原生 Rust `--mcp`（14 個工具 + 4 個 `floral://` 唯讀資源/範本）與 `--cli` 命令列介面，跨進程檔案鎖 + GUI 自動熱刷新    |
| **速記與桌面磁貼** | 獨立懸浮「閃念快捕條」（`Alt+Shift+Space`）、桌面磁貼支援 `--ttl` 定時自動關閉 / `--persist` 常駐、縮至 140×96 迷你模式    |
| **知識連接**       | `[[` 雙向連結自動補全與點擊跳轉、反向連結 + 純本機 BM25 相關筆記推薦、力導向知識圖譜、目錄大綱                             |
| **整理與同步**     | 跨筆記待辦彙總回寫、側欄多選批次管理、貼上/拖入圖片自動 WebP 壓縮、blake3 版本去重歷史、可選 WebDAV / Git 同步（預設關閉） |
| **可靠性與安全**   | 原子儲存與失敗回滾、關窗強制落盤、備份原子恢復、SVG 腳本過濾、簡中 / 香港繁中 / 英文三語介面                               |

## 特性

### 寫作與整理

- **Markdown 編輯、預覽與分欄模式**：支持 GFM、任務列表、表格、數學公式、代碼塊等常用格式，分欄支援高精度雙向同步滾動；預覽區與桌面磁貼支援直接點擊勾選任務列表並回寫源碼。
- **筆記內尋找與替換及圖片壓縮**：支援 `Ctrl+F` / `Ctrl+H` 正則搜尋、編輯/預覽雙區命中高亮與原生復原棧替換；貼上/拖入圖片自動轉 WebP（支援品質調整，自動跳過小圖與動圖）。
- **命令面板**：主視窗內通過 `Ctrl+K`（可在設定中自訂錄製）一鍵呼出，融合本地過濾、FTS5 全文檢索摘要、`>` 命令模式與快速新建筆記。
- **模板與每日便箋**：保存常用筆記模板，一鍵套用；每日便箋按本地時區打開，凌晨也不會開錯「昨天」。
- **版本歷史**：自動保留最近 20 份正文版本，blake3 哈希去重，內容未變不重複存儲，可按需一鍵恢復。
- **分類、標籤、置頂與批次管理**：歸類、加標籤、置頂，支援組合篩選與側欄「多選」模式（一鍵批次移動分類、新增標籤、匯出或二次確認刪除）；從分類標題可直接在指定分類中新建筆記。
- **增強搜索**：支持 `tag:標籤`、`in:分類`、`pinned` 與 `unpinned` 查詢。
- **待辦聚合**：從所有筆記彙總未完成任務，面板中勾選後直接回寫原 Markdown。
- **外部文件支持**：安全打開外部 Markdown 與 TXT 文件，識別 UTF-8 BOM、UTF-16 BOM 與 GBK 編碼；相對圖片按白名單安全顯示。
- **專注寫作與沉浸閱讀**：一鍵收起側欄與工具欄進入無干擾寫作；沉浸閱讀強制全屏預覽，適合回看長筆記。

### 桌面磁貼與快速便籤

- **隨時喚出的便籤與閃念快捕條**：托盤或全局快捷鍵快速記錄；獨立懸浮「閃念快捕條」（預設 `Alt+Shift+Space`，支援自訂）可一鍵切換儲存至收件箱或追加至每日便籤。
- **桌面磁貼**：把筆記固定在桌面一角，支持縮至 140×96 的迷你尺寸；「磁貼僅在桌面顯示」選項讓普通窗口不再遮擋。
- **關窗不丟字**：關閉便籤窗口前自動保存未完成內容。

### 筆記之間的連接

- **內部鏈接與 `[[` 補全**：編輯正文輸入 `[[` 彈出候選清單即時插入鏈接；支援 `[[筆記標題]]` 與 `[[note:筆記ID|顯示文字]]`，預覽直接點擊或編輯區 `Ctrl+點擊` 直達目標筆記。
- **反向鏈接與本地相關筆記**：查看哪些筆記提到了當前筆記，並在同一面板結合本地 BM25 與標籤相似度推薦相關筆記，一鍵插入關聯。
- **導航歷史**：筆記間跳轉後可通過 `Alt+←` / `Alt+→` 輕鬆回溯。

### 知識發現

- **目錄大綱**：自動提取標題層級，側欄一鍵跳轉，含加粗、鏈接的標題也能準確定位。
- **知識圖譜**：力導向圖可視化筆記引用關係網，按分類著色，點擊節點直達筆記。
- **每週回顧**：儀表盤卡片彙總本週新建、更新、字數與完成待辦，一鍵生成回顧草稿。

### 提醒與每日節奏

- **一次性本地提醒**：為當前筆記設置提醒，到點後喚起窗口並打開關聯筆記。
- **可靠送達**：提醒確認送達後才標記完成，窗口喚起失敗自動重試，不丟提醒。
- **收件箱「明天看」**：收件箱每條筆記一鍵設置明早 9 點提醒，延時閱讀不遺忘。

> [!NOTE]
> 提醒為「應用運行時提醒」：花箋徹底退出後不作為系統常駐服務；下次啟動時會補發仍未觸發的過期提醒。

### 性能與基礎設施

- **FTS5 全文搜索**：SQLite FTS5 增量索引，trigram tokenizer 支持中英文混合搜索，速度遠超舊版全量遍歷。
- **版本去重存儲**：blake3 哈希去重，內容未變時不重複存儲，節省 80%+ 磁盤空間。
- **CLI 命令行接口**：`--cli list|get|search|daily|create|append|update|delete|todos|remind|pin-tile|export`（支援 `--ttl` / `--persist` 桌面磁貼逾時控制），方便腳本批量操作與管道集成。
- **內置 MCP Server**：`--mcp` 提供原生 Rust stdio JSON-RPC 2.0 介面（14 個工具 + 4 個 `floral://` 唯讀資源/模板），設定頁自帶用戶端預設組態一鍵複製與近期外部活動紀錄。
- **可選跨裝置雲同步**：預設關閉，可在設定中按需啟用 WebDAV 或 Git 同步（憑證安全存入系統鑰匙圈、自動衝突備份）。
- **雙進程安全與 GUI 熱刷新**：CLI/MCP 與圖形界面併發寫入由跨進程文件鎖串行，外部寫入後 GUI 自動熱刷新（未儲存內容受保護不被覆蓋）。

### 數據安全與未保存保護

- **本地優先**：筆記、設置、版本歷史與提醒全部保存在本機數據目錄，可隨時遷移。
- **保存兜底**：正文寫入失敗自動回滾，不會出現「新正文配舊標題」；保存失敗會阻止離開當前筆記，絕不靜默丟內容。
- **關閉即落盤**：Ctrl+W、關閉窗口、切換筆記、恢復備份前，都會先強制保存未完成內容。
- **備份原子恢復**：整體暫存 + 原子替換 + 失敗回滾，中途斷電也不留半恢復狀態；拒絕 zip 路徑穿越與超大壓縮包。
- **提醒自愈**：提醒文件損壞時自動重建，損壞副本保留備查。
- **導入安全**：SVG 圖片拒絕內嵌腳本，收緊 XSS 面。

## MCP 與 CLI 快速上手

花箋內置原生 Rust stdio MCP Server（`--mcp`），無需額外安裝執行環境。打開「應用設定 → MCP 與 CLI 整合」可自動識別目前程式路徑，一鍵複製 Antigravity、Claude Code、Codex 或通用用戶端設定，並查看近期外部呼叫紀錄。

標準 `mcpServers` 設定範例（綠色版或自訂路徑請替換為實際可執行檔路徑；Claude Code 預設可從設定頁複製含 `"type": "stdio"` 的片段）：

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

內置 4 項唯讀 MCP 資源 / 範本：`floral://daily`（每日便箋）、`floral://todos/pending`（未完成待辦）、`floral://notes`（筆記中繼資料清單）、`floral://note/{id}`（按 ID 讀取正文）。

常用 CLI 範例（所有命令均輸出結構化 JSON，支援 `--stdin` 管道與環境變數 `FLORAL_NOTEPAPER_DATA_DIR`）：

```bash
# 全文搜尋筆記
floral-notepaper --cli search "關鍵詞"

# 向每日便箋追加一條待辦
floral-notepaper --cli append daily --content "- [ ] 整理週報"

# 列出全部未完成待辦
floral-notepaper --cli todos list --pending

# 將筆記釘到桌面磁貼（預設 300 秒後自動關閉；傳 --persist 常駐）
floral-notepaper --cli pin-tile <note-id> --ttl 600
```

## 常用快捷鍵

| 快捷鍵              | 作用                        | 範圍 / 備註                                         |
| ------------------- | --------------------------- | --------------------------------------------------- |
| `Ctrl+Space`        | 喚出 / 聚焦快速便籤         | 全局（macOS 預設 `Command+Option+N`，可在設定修改） |
| `Alt+Shift+Space`   | 喚出懸浮「閃念快捕條」      | 全局（可在設定修改）                                |
| `Ctrl+K`            | 打開 / 關閉命令面板         | 主視窗（可在設定修改）                              |
| `Ctrl+F` / `Ctrl+H` | 筆記內尋找 / 尋找並替換     | 主視窗編輯區（支援區分大小寫與正則）                |
| `Ctrl+S`            | 立即儲存目前筆記            | 主視窗                                              |
| `Ctrl+W`            | 關閉目前分頁                | 主視窗（可在設定修改，關閉前自動落盤）              |
| `Alt+←` / `Alt+→`   | 筆記瀏覽歷史後退 / 前進     | 主視窗                                              |
| `[[` / `Ctrl+點擊`  | 雙向連結補全 / 跳轉目標筆記 | 編輯區（預覽區直接左鍵點擊跳轉）                    |
| `Ctrl+右鍵`         | 快速關閉桌面磁貼            | 桌面磁貼（可在設定中開關）                          |

## 下載與安裝

前往 [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) 下載最新版。

| 文件                                    | 適用場景                                                   |
| --------------------------------------- | ---------------------------------------------------------- |
| `floral-notepaper_版本號_x64-setup.exe` | **Windows x64 安裝版**，推薦大多數用戶使用。               |
| `floral-notepaper_版本號.exe`           | **Windows x64 綠色版**，下載後可直接運行，不寫入安裝目錄。 |
| `SHA256SUMS.txt`                        | 全部發佈包的 SHA-256 校驗值。                              |
| `BUILD-INFO.txt`                        | 構建版本、提交雜湊與構建時間資訊。                         |

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
npx tauri build --bundles nsis
```

## 數據與隱私

花箋預設純本機運行，不要求註冊賬號，也不會主動上傳任何筆記內容。WebDAV / Git 跨裝置同步預設關閉，僅在你手動開啟後與自選遠端同步，且密碼與存取權杖僅儲存在系統安全憑證庫中（不以明文寫入設定檔）。數據目錄可在應用設置中查看或遷移；在遷移、清理或覆蓋數據前，請自行備份重要筆記。

## 技術棧

| 層       | 技術                                   |
| -------- | -------------------------------------- |
| 桌面框架 | [Tauri 2](https://tauri.app/)          |
| 前端     | React 19 + TypeScript + Vite           |
| 後端     | Rust 1.96                              |
| 全文索引 | SQLite FTS5（trigram）                 |
| 版本去重 | blake3 哈希                            |
| 發佈     | GitHub Actions 自動構建 + 草稿 Release |

## 上游與許可

本倉庫是 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的衍生維護版本，感謝上游項目及其貢獻者提供堅實的基礎。

本項目依照 [MIT License](LICENSE) 發佈。原始版權與許可聲明均在倉庫中保留。
