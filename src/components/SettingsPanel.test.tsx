import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "../locales";
import type { AppConfig } from "../features/settings/types";
import { SettingsPanel } from "./SettingsPanel";

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
    imageCompressWebp: true,
    imageCompressQuality: 0.85,
    ...overrides,
  };
}

describe("SettingsPanel image compression controls", () => {
  test("renders WebP compression toggle and 0.60-0.95 quality slider", () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        config={makeConfig({ imageCompressWebp: true, imageCompressQuality: 0.85 })}
        onChange={vi.fn()}
        onMigrateDataDir={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("图片压缩");
    expect(markup).toContain("粘贴/拖入图片自动转为 WebP");
    expect(markup).toContain("WebP 压缩质量");
    expect(markup).toContain('min="0.6"');
    expect(markup).toContain('max="0.95"');
    expect(markup).toContain("0.85");
  });

  test("disables quality slider when WebP compression is turned off and localizes labels", async () => {
    const en = i18n.cloneInstance({ lng: "en-US" });
    await en.changeLanguage("en-US");

    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={en}>
        <SettingsPanel
          config={makeConfig({ imageCompressWebp: false, imageCompressQuality: 0.72 })}
          onChange={vi.fn()}
          onMigrateDataDir={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(markup).toContain("Image Compression");
    expect(markup).toContain("Auto-convert pasted/dropped images to WebP");
    expect(markup).toContain("0.72");
    expect(markup).toContain("disabled");
  });
});
