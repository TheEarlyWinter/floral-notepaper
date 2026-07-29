<!-- markdownlint-disable -->

[简体中文](README.md) | **繁體中文** | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="花箋圖示">

# 花箋 · 增強版

把零散念頭輕輕收進本機。<br>
一個本機優先、支援 Markdown 與桌面便箋的輕巧筆記工具。

由 [TheEarlyWinter](https://github.com/TheEarlyWinter) 持續維護<br>
基於 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的 Tauri 2 + React 專案構建

[下載最新版](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) · [提交問題](https://github.com/TheEarlyWinter/floral-notepaper/issues) · [更新記錄](https://github.com/TheEarlyWinter/floral-notepaper/releases)

[![Release](https://img.shields.io/github/v/release/TheEarlyWinter/floral-notepaper?label=release)](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows)

</div>

<!-- markdownlint-restore -->

---

## 這是甚麼

花箋增強版面向想把筆記留在自己電腦裡，同時希望記錄過程足夠順手的人。

它可以是一張隨時喚出的便箋，也可以是一套輕巧的 Markdown 筆記庫：寫下一個待辦、整理每日記錄、把幾篇筆記連起來，或者把一條提醒留給未來的自己。無需帳號，也無雲端依賴。

## 已實現功能

### 寫作與整理

- **Markdown 編輯、預覽與分欄模式**：支援 GFM、任務清單、表格、數學公式、程式碼區塊及常用 Markdown 格式。
- **快速便箋與磁貼**：可透過系統匣或全域快速鍵快速記錄，也可把筆記固定在桌面一角。
- **分類、標籤與置頂**：為筆記分類、加上標籤、置頂，並支援組合篩選。
- **增強搜尋**：支援 `tag:標籤`、`in:分類`、`pinned` 及 `unpinned` 查詢。
- **待辦聚合**：從所有筆記匯總未完成任務，在面板中勾選後直接回寫原 Markdown。
- **範本與每日便箋**：儲存常用筆記範本；同一天可重複開啟同一篇每日便箋。
- **版本歷史**：自動保留最近 20 份正文版本，可按需要還原。

### 筆記之間的連結

- **內部連結**：在正文輸入 `[[筆記標題]]`，標題唯一時可從預覽直接跳轉。
- **穩定連結**：支援 `[[note:筆記ID|顯示文字]]`；即使筆記重名，也不會猜錯目標。
- **反向連結**：查看哪些筆記提到了目前筆記。
- **複製穩定連結**：工具列可一鍵複製目前筆記的穩定連結，方便插入其他筆記。

### 提醒與本機資料

- **一次性本機提醒**：可為目前筆記設定提醒、查看及刪除未到期提醒。
- **到點回到筆記**：花箋運行時會檢查提醒；到點後喚起視窗、顯示應用內提示並開啟關聯筆記。
- **本機優先**：筆記、設定、版本歷史及提醒都儲存於本機資料目錄。
- **匯入與匯出**：支援 `.md` 檔案匯入、匯出及外部 Markdown 檔案編輯。

> [!NOTE]
> 提醒目前屬於「應用運行時提醒」：花箋完全結束後不會作為系統常駐服務運行；下次啟動時會補發仍未觸發的過期提醒。

## 下載與安裝

請到 [Releases](https://github.com/TheEarlyWinter/floral-notepaper/releases/latest) 下載最新版。

| 檔案 | 適用情境 |
| --- | --- |
| `花箋_版本號_x64-setup.exe` | **Windows x64 安裝版**，建議大部分使用者使用。|
| `花箋_版本號_x64.exe` | **Windows x64 可攜版**，下載後可直接運行，不寫入安裝目錄。|
| `floral-notepaper-版本號-source.zip` | 與發布標籤相對應的完整原始碼包。|

首次運行時，Windows 可能會顯示未知發行者提示。這是因為目前發布包尚未進行商業程式碼簽署；請只從本倉庫的 Release 頁下載，並按需要核對發布頁提供的 SHA-256 值。

## 從原始碼運行

### 環境

- Node.js 20+
- Rust stable
- 在 Windows 建置桌面程式還需要 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

### 指令

```bash
npm install
npm run tauri dev
```

測試及發布建置：

```bash
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build -- --bundles nsis
```

## 資料與私隱

花箋不需要註冊帳號，也不會主動上傳筆記內容。資料目錄可在應用設定中查看或遷移；遷移、清理或覆蓋資料前，請自行備份重要筆記。

## 上游與授權

本倉庫是 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) 的衍生維護版本，感謝上游專案及其貢獻者提供堅實基礎。

本專案依照 [MIT License](LICENSE) 發布。倉庫保留原始的版權與授權聲明。
