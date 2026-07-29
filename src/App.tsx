import { useEffect } from "react";
import "./App.css";
import { ContextMenuProvider } from "./components/ContextMenu";
import { MainWindow } from "./components/MainWindow";
import { NotePad } from "./components/NotePad";
import { TileShowcase } from "./components/TileShowcase";
import { ToastContainer } from "./components/Toast";
import { tabToIndentListener } from "indent-textarea";
import { getConfig } from "./features/settings/api";
import { applyTheme, watchSystemTheme, applyPresetTheme, applyAccentColor, applyCodeTheme, applyEditorFont, applyEditorLineHeight, applyEditorParagraphSpacing, applyEditorWidth, applySidebarPosition, applyWindowOpacity } from "./features/settings/theme";
import type { AppConfig, ThemeOption, PresetTheme, CodeTheme } from "./features/settings/types";
import { getInitialRoute } from "./features/windows/windowRoutes";
import { syncLanguage } from "./locales";
import { listen } from "@tauri-apps/api/event";

function applyAllSettings(config: AppConfig) {
  const theme = (config.theme || "system") as ThemeOption;
  applyTheme(theme);
  applyPresetTheme((config.presetTheme || "default") as PresetTheme);
  applyAccentColor(config.accentColor || "", (config.presetTheme || "default") as PresetTheme);
  applyCodeTheme((config.codeTheme || "light") as CodeTheme);
  applyEditorFont(config.editorFontFamily || "");
  applyEditorLineHeight(config.editorLineHeight || 1.8);
  applyEditorParagraphSpacing(config.editorParagraphSpacing || 0);
  applyEditorWidth(config.editorWidth || "normal");
  applySidebarPosition(config.sidebarPosition || "left");
  applyWindowOpacity(config.windowOpacity || 1);
  document.documentElement.style.setProperty(
    "--tab-indent-size",
    String(config.tabIndentSize ?? 2),
  );
}

function App() {
  const route = getInitialRoute();
  const activeView = route.view;

  // 自定义 CSS 注入
  useEffect(() => {
    const styleId = "floral-custom-css";
    const updateCustomCss = (css: string) => {
      let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
      if (!css) {
        if (styleEl) styleEl.remove();
        return;
      }
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = css;
    };

    getConfig()
      .then((config) => updateCustomCss(config.customCss || ""))
      .catch(() => {});

    const unlistenPromise = listen<AppConfig>("config-changed", (event) => {
      updateCustomCss(event.payload.customCss || "");
    });

    return () => {
      void unlistenPromise.then((fn) => fn());
      const styleEl = document.getElementById(styleId);
      if (styleEl) styleEl.remove();
    };
  }, []);

  useEffect(() => {
    let cleanup = () => {};
    getConfig()
      .then((config) => {
        const theme = (config.theme || "system") as ThemeOption;
        applyAllSettings(config);
        cleanup = watchSystemTheme(theme);
        void syncLanguage(config.locale);
      })
      .catch(() => {});
    return () => cleanup();
  }, []);

  useEffect(() => {
    let themeCleanup = () => {};
    const unlisten = listen<AppConfig>("config-changed", (event) => {
      const theme = (event.payload.theme || "system") as ThemeOption;
      applyAllSettings(event.payload);
      themeCleanup();
      themeCleanup = watchSystemTheme(theme);
      void syncLanguage(event.payload.locale);
    });
    return () => {
      themeCleanup();
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const handleTab = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (target.dataset.tabIndent !== "true") return;
      tabToIndentListener(event);
    };
    window.addEventListener("keydown", handleTab, true);
    return () => window.removeEventListener("keydown", handleTab, true);
  }, []);

  useEffect(() => {
    const isWindows =
      navigator.userAgent.includes("Windows") || navigator.platform.toLowerCase().startsWith("win");
    if (!isWindows) return;

    const preventSystemMenu = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "Space") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", preventSystemMenu, true);
    return () => document.removeEventListener("keydown", preventSystemMenu, true);
  }, []);

  return (
    <ContextMenuProvider>
      <div className="app-window-shell h-screen font-body text-ink overflow-hidden">
        {activeView === "main" ? (
          <MainWindow />
        ) : activeView === "notepad" ? (
          <NotePad initialNoteId={route.noteId} />
        ) : (
          <TileShowcase noteId={route.noteId} />
        )}
        <ToastContainer />
      </div>
    </ContextMenuProvider>
  );
}

export default App;
