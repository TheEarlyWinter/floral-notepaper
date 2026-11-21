import { invoke } from "@tauri-apps/api/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../features/settings/types";
import {
  clearSyncSecret,
  getSyncStatus,
  hasSyncSecret,
  runSyncNow,
  setSyncSecret,
  testSyncConnection,
  type SyncStatus,
} from "../features/sync/api";
import { formatSyncTimestamp, SyncSettingsSection } from "./SyncSettingsSection";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

const mockedInvoke = vi.mocked(invoke);

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    locale: "zh-CN",
    dataDir: "D:\\notes",
    globalShortcut: "Ctrl+Space",
    closeToTray: true,
    closeTabShortcut: "Ctrl+W",
    autostart: false,
    defaultViewMode: "split",
    noteAutoSave: true,
    noteSurfaceAutoSave: true,
    tileColor: "#f6f3ec",
    tileColorMode: "system",
    theme: "light",
    fontSize: 14,
    surfaceFontSize: 14,
    tabIndentSize: 2,
    externalFileAutoSave: true,
    rememberSurfaceSize: true,
    tileCtrlClose: true,
    tileDoubleClickToEdit: false,
    tileSaveReturnsToPin: false,
    tileRenderMarkdown: false,
    tileDesktopOnly: false,
    renderHtmlMarkdown: false,
    splitScrollSync: true,
    toggleVisibilityShortcut: "",
    quickCaptureShortcut: "Alt+Shift+Space",
    openAtCursor: true,
    presetTheme: "default",
    accentColor: "",
    codeTheme: "light",
    editorFontFamily: "",
    editorLineHeight: 1.8,
    editorParagraphSpacing: 0,
    editorWidth: "normal",
    sidebarPosition: "left",
    windowOpacity: 1,
    rememberWindowSize: false,
    showOutline: false,
    codeLineNumbers: false,
    linkPreview: true,
    customCss: "",
    templates: [],
    syncProvider: "none",
    syncAutoIntervalMinutes: 0,
    syncWebdavUrl: "",
    syncWebdavUsername: "",
    syncWebdavRemoteDir: "floral-notepaper",
    syncGitRemoteUrl: "",
    syncGitBranch: "main",
    syncGitUsername: "",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    provider: "none",
    state: "idle",
    running: false,
    lastSyncAt: null,
    lastSuccessAt: null,
    lastMessage: null,
    lastError: null,
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: [],
    hasWebdavPassword: false,
    hasGitToken: false,
    keyringAvailable: true,
    ...overrides,
  };
}

describe("SyncSettingsSection", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  test("renders disabled state by default without provider fields", () => {
    const markup = renderToStaticMarkup(
      <SyncSettingsSection config={makeConfig()} onChange={vi.fn()} initialStatus={makeStatus()} />,
    );

    expect(markup).toContain("云同步");
    expect(markup).toContain("同步默认关闭");
    expect(markup).not.toContain("测试连接");
    expect(markup).not.toContain("立即同步");
  });

  test("renders WebDAV fields with saved credential badge and never exposes raw password", () => {
    const markup = renderToStaticMarkup(
      <SyncSettingsSection
        config={makeConfig({
          syncProvider: "webdav",
          syncAutoIntervalMinutes: 15,
          syncWebdavUrl: "https://dav.example.com/dav",
          syncWebdavUsername: "alice",
          syncWebdavRemoteDir: "notes-sync",
        })}
        onChange={vi.fn()}
        initialStatus={makeStatus({
          provider: "webdav",
          state: "success",
          lastSyncAt: "2026-11-21T10:00:00Z",
          uploaded: 3,
          downloaded: 2,
          hasWebdavPassword: true,
        })}
      />,
    );

    expect(markup).toContain("https://dav.example.com/dav");
    expect(markup).toContain("alice");
    expect(markup).toContain("notes-sync");
    expect(markup).toContain("已保存");
    expect(markup).toContain("清除");
    expect(markup).toContain("测试连接");
    expect(markup).toContain("立即同步");
    expect(markup).toContain("上传 3 · 下载 2 · 删除 0");
    expect(markup).toContain("15 分钟");
  });

  test("renders Git fields, conflict summary, and keyring unavailable warning", () => {
    const markup = renderToStaticMarkup(
      <SyncSettingsSection
        config={makeConfig({
          syncProvider: "git",
          syncAutoIntervalMinutes: 10,
          syncGitRemoteUrl: "https://github.com/user/floral-notes.git",
          syncGitBranch: "main",
          syncGitUsername: "user",
        })}
        onChange={vi.fn()}
        initialStatus={makeStatus({
          provider: "git",
          state: "conflict",
          keyringAvailable: false,
          hasGitToken: false,
          conflicts: [
            {
              path: "notes/abc.md",
              conflictCopyPath: "notes/abc.conflict-20261121T120000Z.md",
              timestamp: "2026-11-21T12:00:00Z",
            },
          ],
        })}
      />,
    );

    expect(markup).toContain("https://github.com/user/floral-notes.git");
    expect(markup).toContain("10 分钟");
    expect(markup).toContain("未配置");
    expect(markup).toContain("当前系统安全凭据库不可用");
    expect(markup).toContain("检测到 1 个冲突副本");
    expect(markup).toContain("notes/abc.conflict-20261121T120000Z.md");
  });

  test("sync api wrappers invoke the expected Tauri commands", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await getSyncStatus();
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_get_status");

    await setSyncSecret("webdav", "pw-123");
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_set_secret", {
      provider: "webdav",
      secret: "pw-123",
    });

    await hasSyncSecret("git");
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_has_secret", { provider: "git" });

    await clearSyncSecret("git");
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_clear_secret", { provider: "git" });

    await testSyncConnection();
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_test_connection");

    await runSyncNow();
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_run_now");
  });

  test("formatSyncTimestamp handles null, invalid, and valid ISO timestamps", () => {
    expect(formatSyncTimestamp(null, "尚未同步")).toBe("尚未同步");
    expect(formatSyncTimestamp("not-a-date", "尚未同步")).toBe("not-a-date");
    expect(formatSyncTimestamp("2026-11-21T10:00:00Z", "尚未同步")).not.toBe("尚未同步");
  });
});
