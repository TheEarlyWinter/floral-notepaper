import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "../locales";
import type { ExternalActivityEntry } from "../features/notes/types";
import {
  buildMcpConfigSnippet,
  copyMcpConfigSnippet,
  formatActivityTimestamp,
  MCP_CLIENT_PRESETS,
  McpIntegrationSection,
  type McpClientPreset,
} from "./McpIntegrationSection";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));

describe("McpIntegrationSection", () => {
  test("generates valid mcpServers JSON snippets for all 4 client presets", () => {
    const exePath = "C:\\Program Files\\Floral Notepaper\\floral-notepaper.exe";
    const expectedPresets: McpClientPreset[] = ["antigravity", "claudeCode", "codex", "generic"];
    expect(MCP_CLIENT_PRESETS.map((p) => p.value)).toEqual(expectedPresets);

    for (const preset of expectedPresets) {
      const snippet = buildMcpConfigSnippet(preset, exePath);
      const parsed = JSON.parse(snippet) as {
        mcpServers: Record<string, { command: string; args: string[]; type?: string }>;
      };
      expect(parsed.mcpServers["floral-notepaper"].command).toBe(exePath);
      expect(parsed.mcpServers["floral-notepaper"].args).toEqual(["--mcp"]);
      if (preset === "claudeCode") {
        expect(parsed.mcpServers["floral-notepaper"].type).toBe("stdio");
      } else {
        expect(parsed.mcpServers["floral-notepaper"].type).toBeUndefined();
      }
    }

    const fallback = JSON.parse(buildMcpConfigSnippet("generic", "   ")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(fallback.mcpServers["floral-notepaper"].command).toBe("floral-notepaper");
    expect(fallback.mcpServers["floral-notepaper"].args).toEqual(["--mcp"]);
  });

  test("renders executable path, preset switcher, JSON snippet, and empty activity state", () => {
    const exePath = "D:\\Apps\\floral-notepaper.exe";
    const markup = renderToStaticMarkup(
      <McpIntegrationSection initialExecutablePath={exePath} initialActivity={[]} />,
    );

    expect(markup).toContain("MCP 与 CLI 集成");
    expect(markup).toContain(exePath);
    expect(markup).toContain("Antigravity");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Codex");
    expect(markup).toContain("通用");
    expect(markup).toContain("mcpServers");
    expect(markup).toContain("--mcp");
    expect(markup).toContain("复制配置");
    expect(markup).toContain("刷新");
    expect(markup).toContain("清空");
    expect(markup).toContain("暂无 CLI 或 MCP 调用记录");
  });

  test("renders recent external activity items with source, action, status, and summary", () => {
    const activity: ExternalActivityEntry[] = [
      {
        id: "act-1",
        timestamp: "2026-11-21T04:10:05Z",
        source: "mcp",
        action: "resources/read",
        target: "floral://daily",
        summary: "daily 2026-11-21 (42 chars)",
        ok: true,
      },
      {
        id: "act-2",
        timestamp: "2026-11-21T04:09:00Z",
        source: "cli",
        action: "pin_tile",
        target: "note-404",
        summary: "noteNotFound: Note note-404 was not found",
        ok: false,
      },
    ];

    const markup = renderToStaticMarkup(
      <McpIntegrationSection
        initialExecutablePath="C:\\floral\\floral-notepaper.exe"
        initialActivity={activity}
      />,
    );

    expect(markup).toContain("mcp");
    expect(markup).toContain("resources/read");
    expect(markup).toContain("floral://daily");
    expect(markup).toContain("daily 2026-11-21 (42 chars)");
    expect(markup).toContain("成功");
    expect(markup).toContain("cli");
    expect(markup).toContain("pin_tile");
    expect(markup).toContain("note-404");
    expect(markup).toContain("失败");
    expect(markup).toContain(formatActivityTimestamp("2026-11-21T04:10:05Z"));
  });

  test("copies config snippet and triggers info or error toast", async () => {
    const notify = vi.fn();
    const writeClipboard = vi.fn(async () => undefined);
    const snippet = buildMcpConfigSnippet("antigravity", "/usr/local/bin/floral-notepaper");

    const ok = await copyMcpConfigSnippet(snippet, {
      writeClipboard,
      notify,
      successMessage: "MCP config copied to clipboard",
      failureMessage: "Failed to copy MCP config",
    });

    expect(ok).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith(snippet);
    expect(notify).toHaveBeenCalledWith("MCP config copied to clipboard", "info");

    const failingWrite = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    const failed = await copyMcpConfigSnippet(snippet, {
      writeClipboard: failingWrite,
      notify,
      successMessage: "MCP config copied to clipboard",
      failureMessage: "Failed to copy MCP config",
    });

    expect(failed).toBe(false);
    expect(notify).toHaveBeenCalledWith("Failed to copy MCP config", "error");
  });

  test("renders localized strings across zh-CN, zh-HK, and en-US", async () => {
    const enInstance = i18n.cloneInstance({ lng: "en-US" });
    await enInstance.changeLanguage("en-US");
    const enMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={enInstance}>
        <McpIntegrationSection initialExecutablePath="/bin/floral" initialActivity={[]} />
      </I18nextProvider>,
    );
    expect(enMarkup).toContain("MCP &amp; CLI Integration");
    expect(enMarkup).toContain("Generic");
    expect(enMarkup).toContain("Copy Config");
    expect(enMarkup).toContain("Recent External Activity");

    const hkInstance = i18n.cloneInstance({ lng: "zh-HK" });
    await hkInstance.changeLanguage("zh-HK");
    const hkMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={hkInstance}>
        <McpIntegrationSection initialExecutablePath="/bin/floral" initialActivity={[]} />
      </I18nextProvider>,
    );
    expect(hkMarkup).toContain("MCP 與 CLI 整合");
    expect(hkMarkup).toContain("複製設定");
    expect(hkMarkup).toContain("最近外部活動");
  });

  test("api helpers invoke expected Tauri backend commands", async () => {
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("/exe");
    const { listExternalActivity, clearExternalActivity, getExecutablePath } =
      await import("../features/notes/api");

    await listExternalActivity();
    await clearExternalActivity();
    const exe = await getExecutablePath();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "external_activity_list");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "external_activity_clear");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "get_executable_path");
    expect(exe).toBe("/exe");
  });
});
