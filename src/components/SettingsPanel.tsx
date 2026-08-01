import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkGlobalShortcut, chooseBackgroundImage } from "../features/settings/api";
import { getErrorMessage } from "../features/notes/api";
import { showToast } from "./Toast";
import { UpdateSettingsSection } from "../features/update/UpdateSettingsSection";
import type {
  AppConfig,
  BackgroundFit,
  CodeTheme,
  EditorWidth,
  PresetTheme,
  SidebarPosition,
  ThemeOption,
  TileColorMode,
  ViewMode,
} from "../features/settings/types";
import {
  formatHeldKeys,
  hotkeyToConfigString,
  isValidGlobalShortcut,
  shortcutPlatform,
} from "../features/settings/shortcutRecorder";
import { useShortcutRecorder } from "../features/settings/useShortcutRecorder";
import { DEFAULT_TILE_COLOR, normalizeTileColor } from "../features/settings/tileColor";
import {
  applyAccentColor,
  applyCodeTheme,
  applyEditorFont,
  applyEditorLineHeight,
  applyEditorParagraphSpacing,
  applyEditorWidth,
  applyPresetTheme,
  applySidebarPosition,
  applyTheme,
  applyWindowOpacity,
  watchSystemTheme,
} from "../features/settings/theme";
import { LOCALE_OPTIONS } from "../locales/locale-whitelist";
import { SlidingButtonGroup } from "./SlidingButtonGroup";

const HARMONY_FONT_LICENSE_URL = new URL("../assets/fonts/LICENSE_Fonts", import.meta.url).href;

interface SettingsPanelProps {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  onMigrateDataDir: () => void;
  onClose: () => void;
}

export function SettingsPanel({ config, onChange, onMigrateDataDir, onClose }: SettingsPanelProps) {
  const { t } = useTranslation();
  const setConfigValue = <Key extends keyof AppConfig>(key: Key, value: AppConfig[Key]) => {
    onChange({ ...config, [key]: value });
  };
  const tileColorModes = useMemo<Array<{ value: TileColorMode; label: string }>>(
    () => [
      {
        value: "system",
        label: t("settings.tileColor.followTheme", { defaultValue: "跟随主题" }),
      },
      {
        value: "custom",
        label: t("settings.tileColor.custom", { defaultValue: "自定义" }),
      },
    ],
    [t],
  );
  const themeOptions = useMemo<Array<{ value: ThemeOption; label: string }>>(
    () => [
      { value: "light", label: t("settings.theme.light", { defaultValue: "浅色" }) },
      { value: "dark", label: t("settings.theme.dark", { defaultValue: "深色" }) },
      {
        value: "system",
        label: t("settings.theme.system", { defaultValue: "跟随系统" }),
      },
    ],
    [t],
  );
  const viewModes = useMemo<Array<{ value: ViewMode; label: string }>>(
    () => [
      { value: "edit", label: t("settings.defaultView.edit", { defaultValue: "编辑" }) },
      { value: "split", label: t("settings.defaultView.split", { defaultValue: "分栏" }) },
      {
        value: "preview",
        label: t("settings.defaultView.preview", { defaultValue: "预览" }),
      },
    ],
    [t],
  );
  const backgroundFits = useMemo<Array<{ value: BackgroundFit; label: string }>>(
    () => [
      { value: "cover", label: t("settings.background.fit.cover", { defaultValue: "填充" }) },
      { value: "contain", label: t("settings.background.fit.contain", { defaultValue: "完整" }) },
      { value: "repeat", label: t("settings.background.fit.repeat", { defaultValue: "平铺" }) },
    ],
    [t],
  );
  const localeOptions = useMemo(
    () =>
      LOCALE_OPTIONS.map(({ value, labelKey, defaultLabel }) => ({
        value,
        label: t(labelKey, { defaultValue: defaultLabel }),
      })),
    [t],
  );

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 flex flex-col">
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
        <h2 className="text-[13px] font-display font-medium text-ink-soft">
          {t("settings.title", { defaultValue: "应用设置" })}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
          title={t("settings.closeTitle", { defaultValue: "关闭设置" })}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hidden px-4 py-4 space-y-5">
        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.theme.label", { defaultValue: "主题" })}
          </label>
          <SlidingButtonGroup
            options={themeOptions}
            value={config.theme}
            onChange={(v: ThemeOption) => {
              setConfigValue("theme", v);
              applyTheme(v);
              watchSystemTheme(v);
            }}
          />
        </section>

        {/* ══ 预设主题 ══ */}
        <PresetThemePicker
          value={(config.presetTheme || "default") as PresetTheme}
          onChange={(v) => {
            setConfigValue("presetTheme", v);
            applyPresetTheme(v);
            applyAccentColor(config.accentColor || "", v);
          }}
        />

        {/* ══ 自定义强调色（仅在无预设时显示） ══ */}
        {(!config.presetTheme || config.presetTheme === "default") && (
          <section className="space-y-2">
            <label className="block text-[11px] font-body text-ink-faint">
              {t("settings.accentColor", { defaultValue: "强调色" })}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={config.accentColor || "#3a7a52"}
                onChange={(event) => {
                  setConfigValue("accentColor", event.target.value);
                  applyAccentColor(
                    event.target.value,
                    (config.presetTheme || "default") as PresetTheme,
                  );
                }}
                className="w-10 h-8 rounded-lg border border-paper-deep/40 bg-paper-warm/70 cursor-pointer"
              />
              <input
                type="text"
                value={config.accentColor || ""}
                onChange={(event) => {
                  const v = event.target.value;
                  setConfigValue("accentColor", v);
                  applyAccentColor(v, (config.presetTheme || "default") as PresetTheme);
                }}
                placeholder="#3a7a52"
                spellCheck={false}
                className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[12px] font-mono text-ink-soft outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  setConfigValue("accentColor", "");
                  applyAccentColor("", "default");
                }}
                className="h-8 px-2.5 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {t("common.default", { defaultValue: "默认" })}
              </button>
            </div>
          </section>
        )}

        {/* ══ 代码块主题 ══ */}
        <CodeThemePicker
          value={(config.codeTheme || "light") as CodeTheme}
          onChange={(v: CodeTheme) => {
            setConfigValue("codeTheme", v);
            applyCodeTheme(v);
          }}
        />

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.dataDir", { defaultValue: "数据目录" })}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={config.dataDir}
              readOnly
              className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-faint truncate"
            />
            <button
              type="button"
              onClick={onMigrateDataDir}
              className="h-8 px-3 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
            >
              {t("settings.selectFolder", { defaultValue: "选择文件夹" })}
            </button>
          </div>
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.locale.label", { defaultValue: "语言" })}
          </label>
          <SlidingButtonGroup
            options={localeOptions}
            value={config.locale}
            onChange={(value) => setConfigValue("locale", value)}
          />
        </section>

        <section className="space-y-2">
          <ToggleRow
            label={t("settings.closeToTray", { defaultValue: "关闭到托盘" })}
            checked={config.closeToTray}
            onChange={(checked) => setConfigValue("closeToTray", checked)}
          />
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-ink-soft">
              {t("settings.closeTabShortcut", { defaultValue: "关闭标签快捷键" })}
            </span>
            <input
              type="text"
              value={config.closeTabShortcut || "Ctrl+W"}
              onChange={(e) => setConfigValue("closeTabShortcut", e.target.value)}
              placeholder="Ctrl+W"
              className="w-28 h-7 rounded-lg border border-paper-deep/30 bg-paper-warm/60 px-2 text-[12px] text-ink-soft font-mono text-center"
            />
          </div>
          <ToggleRow
            label={t("settings.autostart", { defaultValue: "开机自启" })}
            checked={config.autostart}
            onChange={(checked) => setConfigValue("autostart", checked)}
          />
          <ToggleRow
            label={t("settings.autoSave.note", { defaultValue: "自动保存笔记" })}
            checked={config.noteAutoSave}
            onChange={(checked) => setConfigValue("noteAutoSave", checked)}
          />
          <ToggleRow
            label={t("settings.autoSave.surface", { defaultValue: "小窗笔记自动保存" })}
            checked={config.noteSurfaceAutoSave}
            onChange={(checked) => setConfigValue("noteSurfaceAutoSave", checked)}
          />
          <ToggleRow
            label={t("settings.autoSave.externalFile", { defaultValue: "外部文件自动保存" })}
            checked={config.externalFileAutoSave}
            onChange={(checked) => setConfigValue("externalFileAutoSave", checked)}
          />
          <ToggleRow
            label={t("settings.rememberSurfaceSize", { defaultValue: "记住小窗尺寸" })}
            checked={config.rememberSurfaceSize}
            onChange={(checked) => setConfigValue("rememberSurfaceSize", checked)}
          />
          <ToggleRow
            label={t("settings.tileRenderMarkdown", { defaultValue: "磁贴渲染 Markdown" })}
            checked={config.tileRenderMarkdown}
            onChange={(checked) => setConfigValue("tileRenderMarkdown", checked)}
          />
          <ToggleRow
            label={t("settings.tileDesktopOnly", { defaultValue: "磁贴仅在桌面显示" })}
            checked={config.tileDesktopOnly ?? false}
            onChange={(checked) => setConfigValue("tileDesktopOnly", checked)}
          />
          <ToggleRow
            label={t("settings.tileDoubleClickToEdit", { defaultValue: "双击磁贴进入编辑" })}
            checked={config.tileDoubleClickToEdit ?? false}
            onChange={(checked) => setConfigValue("tileDoubleClickToEdit", checked)}
          />
          <ToggleRow
            label={t("settings.tileSaveReturnsToPin", { defaultValue: "保存后回到磁贴" })}
            checked={config.tileSaveReturnsToPin ?? false}
            onChange={(checked) => setConfigValue("tileSaveReturnsToPin", checked)}
          />
          <ToggleRow
            label={t("settings.renderHtmlMarkdown", { defaultValue: "允许 HTML 标签渲染" })}
            checked={config.renderHtmlMarkdown}
            onChange={(checked) => setConfigValue("renderHtmlMarkdown", checked)}
          />
          <ToggleRow
            label={t("settings.splitScrollSync", { defaultValue: "分栏同步滚动" })}
            checked={config.splitScrollSync ?? true}
            onChange={(checked) => setConfigValue("splitScrollSync", checked)}
          />
        </section>

        {/* 快捷键功能设置区域，与上方常规设置分开 */}
        <section className="space-y-2">
          <ToggleRow
            label={t("settings.tileCtrlClose", { defaultValue: "Ctrl+右键快速关闭磁贴" })}
            checked={config.tileCtrlClose}
            onChange={(checked) => setConfigValue("tileCtrlClose", checked)}
          />
          <ToggleRow
            label={t("settings.openAtCursor", { defaultValue: "快捷键打开时跟随鼠标位置" })}
            checked={config.openAtCursor ?? true}
            onChange={(checked) => setConfigValue("openAtCursor", checked)}
          />
          <div className="space-y-1.5">
            <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
              {t("settings.quickNoteShortcut", { defaultValue: "快捷记录快捷键" })}
            </label>
            <ShortcutRecorder
              value={config.globalShortcut}
              onChange={(v) => setConfigValue("globalShortcut", v)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
              {t("settings.visibilityShortcut", { defaultValue: "显示/隐藏窗口快捷键" })}
            </label>
            <ShortcutRecorder
              value={config.toggleVisibilityShortcut}
              onChange={(v) => setConfigValue("toggleVisibilityShortcut", v)}
            />
          </div>
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.fontSize.editor", { defaultValue: "编辑器字号" })}
          </label>
          <div className="flex items-center gap-3 h-9 rounded-lg px-2.5 bg-paper-warm/45 border border-paper-deep/25">
            <input
              type="range"
              min={8}
              max={30}
              step={1}
              value={config.fontSize ?? 14}
              onChange={(event) => setConfigValue("fontSize", Number(event.target.value))}
              className="flex-1 h-1 accent-bamboo cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-paper-deep/50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bamboo [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
            />
            <span className="text-[12px] font-mono text-ink-soft tabular-nums w-8 text-right">
              {config.fontSize ?? 14}px
            </span>
          </div>
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.fontSize.surface", { defaultValue: "小窗/磁贴字号" })}
          </label>
          <div className="flex items-center gap-3 h-9 rounded-lg px-2.5 bg-paper-warm/45 border border-paper-deep/25">
            <input
              type="range"
              min={8}
              max={30}
              step={1}
              value={config.surfaceFontSize ?? 14}
              onChange={(event) => setConfigValue("surfaceFontSize", Number(event.target.value))}
              className="flex-1 h-1 accent-bamboo cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-paper-deep/50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bamboo [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
            />
            <span className="text-[12px] font-mono text-ink-soft tabular-nums w-8 text-right">
              {config.surfaceFontSize ?? 14}px
            </span>
          </div>
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.tabIndentSize", { defaultValue: "Tab 缩进宽��" })}
          </label>
          <div className="flex items-center gap-3 h-9 rounded-lg px-2.5 bg-paper-warm/45 border border-paper-deep/25">
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={config.tabIndentSize ?? 2}
              onChange={(event) => setConfigValue("tabIndentSize", Number(event.target.value))}
              className="flex-1 h-1 accent-bamboo cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-paper-deep/50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bamboo [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
            />
            <span className="text-[12px] font-mono text-ink-soft tabular-nums w-10 text-right">
              {config.tabIndentSize ?? 2}
            </span>
          </div>
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.tileColor.label", { defaultValue: "磁贴颜色" })}
          </label>
          <SlidingButtonGroup
            options={tileColorModes}
            value={config.tileColorMode}
            onChange={(v: TileColorMode) => setConfigValue("tileColorMode", v)}
          />
          {config.tileColorMode === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={normalizeTileColor(config.tileColor)}
                onChange={(event) => setConfigValue("tileColor", event.target.value)}
                className="w-10 h-8 rounded-lg border border-paper-deep/40 bg-paper-warm/70 cursor-pointer"
              />
              <input
                type="text"
                value={config.tileColor}
                onChange={(event) => setConfigValue("tileColor", event.target.value)}
                placeholder="#f6f3ec"
                spellCheck={false}
                className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[12px] font-mono text-ink-soft outline-none"
              />
              <button
                type="button"
                onClick={() => setConfigValue("tileColor", DEFAULT_TILE_COLOR)}
                className="h-8 px-2.5 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer whitespace-nowrap"
              >
                {t("common.default", { defaultValue: "默认" })}
              </button>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.background.label", { defaultValue: "背景图片" })}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={
                (config.backgroundImagePath &&
                  (localStorage.getItem("backgroundImageName") ||
                    config.backgroundImagePath.split(/[/\\]/).pop())) ||
                t("settings.background.default", { defaultValue: "默认背景" })
              }
              readOnly
              className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-faint truncate"
            />
            <button
              type="button"
              onClick={() => {
                void chooseBackgroundImage()
                  .then(async (path) => {
                    if (!path) return;
                    const originalName = path.split(/[/\\]/).pop() ?? "";
                    const saved = await invoke<string>("copy_background_image", {
                      sourcePath: path,
                    });
                    localStorage.setItem("backgroundImageName", originalName);
                    setConfigValue("backgroundImagePath", saved);
                  })
                  .catch((error) => {
                    showToast(getErrorMessage(error));
                  });
              }}
              className="h-8 px-3 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
            >
              {t("settings.background.choose", { defaultValue: "选择" })}
            </button>
            {config.backgroundImagePath && (
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem("backgroundImageName");
                  setConfigValue("backgroundImagePath", "");
                }}
                className="h-8 px-3 rounded-lg border border-red-400/40 text-[11px] text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
              >
                {t("settings.background.clear", { defaultValue: "清除" })}
              </button>
            )}
          </div>
          <SlidingButtonGroup
            options={backgroundFits}
            value={config.backgroundFit ?? "cover"}
            onChange={(value: BackgroundFit) => setConfigValue("backgroundFit", value)}
          />
          <RangeRow
            label={t("settings.background.dim", { defaultValue: "遮罩" })}
            value={config.backgroundDim ?? 0.25}
            min={0}
            max={1}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => setConfigValue("backgroundDim", value)}
          />
          <RangeRow
            label={t("settings.background.scale", { defaultValue: "缩放" })}
            value={config.backgroundScale ?? 1}
            min={0.5}
            max={2}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => setConfigValue("backgroundScale", value)}
          />
          <RangeRow
            label={t("settings.background.positionX", { defaultValue: "横向" })}
            value={config.backgroundPositionX ?? 50}
            min={0}
            max={100}
            step={1}
            format={(value) => `${value}%`}
            onChange={(value) => setConfigValue("backgroundPositionX", value)}
          />
          <RangeRow
            label={t("settings.background.positionY", { defaultValue: "纵向" })}
            value={config.backgroundPositionY ?? 50}
            min={0}
            max={100}
            step={1}
            format={(value) => `${value}%`}
            onChange={(value) => setConfigValue("backgroundPositionY", value)}
          />
          <RangeRow
            label={t("settings.background.blur", { defaultValue: "模糊" })}
            value={config.backgroundBlur ?? 0}
            min={0}
            max={20}
            step={1}
            format={(value) => `${value}px`}
            onChange={(value) => setConfigValue("backgroundBlur", value)}
          />
        </section>

        <section className="space-y-2">
          <label className="block text-[11px] font-body text-ink-faint">
            {t("settings.defaultView.label", { defaultValue: "默认视图" })}
          </label>
          <SlidingButtonGroup
            options={viewModes}
            value={config.defaultViewMode}
            onChange={(v) => setConfigValue("defaultViewMode", v)}
          />
        </section>

        <UpdateSettingsSection mode="settingsOnly" />

        {/* ═══════════════════════════════════════
            排版定制
           ═══════════════════════════════════════ */}
        <section className="space-y-2 pt-3 border-t border-paper-deep/20">
          <h3 className="text-[11px] font-display font-medium text-ink-faint/80">
            {t("settings.typography.heading", { defaultValue: "排版定制" })}
          </h3>

          <div className="space-y-1.5">
            <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
              {t("settings.typography.editorFont", { defaultValue: "编辑器字体" })}
            </label>
            <input
              type="text"
              value={config.editorFontFamily || ""}
              onChange={(event) => {
                setConfigValue("editorFontFamily", event.target.value);
                applyEditorFont(event.target.value);
              }}
              placeholder={t("settings.typography.editorFontPlaceholder", {
                defaultValue: "留空使用默认字体",
              })}
              spellCheck={false}
              className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none"
            />
          </div>

          <RangeRow
            label={t("settings.typography.lineHeight", { defaultValue: "行高" })}
            value={config.editorLineHeight || 1.8}
            min={1.2}
            max={3}
            step={0.1}
            format={(value) => `${value.toFixed(1)}`}
            onChange={(value) => {
              setConfigValue("editorLineHeight", value);
              applyEditorLineHeight(value);
            }}
          />

          <RangeRow
            label={t("settings.typography.paragraphSpacing", { defaultValue: "段距" })}
            value={config.editorParagraphSpacing || 0}
            min={0}
            max={32}
            step={2}
            format={(value) => `${value}px`}
            onChange={(value) => {
              setConfigValue("editorParagraphSpacing", value);
              applyEditorParagraphSpacing(value);
            }}
          />

          <div className="space-y-1.5">
            <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
              {t("settings.typography.editorWidth", { defaultValue: "编辑器宽度" })}
            </label>
            <EditorWidthPicker
              value={(config.editorWidth || "normal") as EditorWidth}
              onChange={(v: EditorWidth) => {
                setConfigValue("editorWidth", v);
                applyEditorWidth(v);
              }}
            />
          </div>
        </section>

        {/* ═══════════════════════════════════════
            布局定制
           ═══════════════════════════════════════ */}
        <section className="space-y-2 pt-3 border-t border-paper-deep/20">
          <h3 className="text-[11px] font-display font-medium text-ink-faint/80">
            {t("settings.layout.heading", { defaultValue: "布局定制" })}
          </h3>

          <div className="space-y-1.5">
            <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
              {t("settings.layout.sidebarPosition", { defaultValue: "侧边栏位置" })}
            </label>
            <SidebarPositionPicker
              value={(config.sidebarPosition || "left") as SidebarPosition}
              onChange={(v: SidebarPosition) => {
                setConfigValue("sidebarPosition", v);
                applySidebarPosition(v);
              }}
            />
          </div>

          <RangeRow
            label={t("settings.layout.opacity", { defaultValue: "透明度" })}
            value={config.windowOpacity || 1}
            min={0.5}
            max={1}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => {
              setConfigValue("windowOpacity", value);
              applyWindowOpacity(value);
            }}
          />

          <ToggleRow
            label={t("settings.layout.rememberWindowSize", { defaultValue: "记忆窗口大小" })}
            checked={config.rememberWindowSize || false}
            onChange={(checked) => setConfigValue("rememberWindowSize", checked)}
          />
        </section>

        {/* ═══════════════════════════════════════
            Markdown 渲染
           ═══════════════════════════════════════ */}
        <section className="space-y-2 pt-3 border-t border-paper-deep/20">
          <h3 className="text-[11px] font-display font-medium text-ink-faint/80">
            {t("settings.markdown.heading", { defaultValue: "Markdown 渲染" })}
          </h3>

          <ToggleRow
            label={t("settings.markdown.showOutline", { defaultValue: "显示目录大纲" })}
            checked={config.showOutline || false}
            onChange={(checked) => setConfigValue("showOutline", checked)}
          />
          <ToggleRow
            label={t("settings.markdown.codeLineNumbers", { defaultValue: "代码块行号" })}
            checked={config.codeLineNumbers || false}
            onChange={(checked) => setConfigValue("codeLineNumbers", checked)}
          />
          <ToggleRow
            label={t("settings.markdown.linkPreview", { defaultValue: "链接预览" })}
            checked={config.linkPreview !== false}
            onChange={(checked) => setConfigValue("linkPreview", checked)}
          />
        </section>

        {/* ═══════════════════════════════════════
            自定义 CSS
           ═══════════════════════════════════════ */}
        <section className="space-y-2 pt-3 border-t border-paper-deep/20">
          <h3 className="text-[11px] font-display font-medium text-ink-faint/80">
            {t("settings.customCss.heading", { defaultValue: "自定义 CSS" })}
          </h3>
          <p className="text-[10px] text-ink-ghost">
            {t("settings.customCss.hint", {
              defaultValue: "在此输入自定义 CSS，将直接注入到应用中。高级功能，请谨慎使用。",
            })}
          </p>
          <textarea
            value={config.customCss || ""}
            onChange={(event) => setConfigValue("customCss", event.target.value)}
            placeholder={t("settings.customCss.placeholder", {
              defaultValue: "/* 在此输入自定义 CSS */\n",
            })}
            spellCheck={false}
            rows={6}
            className="w-full rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft p-2.5 leading-relaxed resize-y outline-none"
          />
        </section>

        <section className="pt-2 border-t border-paper-deep/25">
          <p className="text-[10px] leading-relaxed text-ink-ghost/75">
            <span>
              {t("settings.fontNotice", {
                defaultValue:
                  "Uses HarmonyOS Sans SC font. Copyright 2021 Huawei Device Co., Ltd. Licensed under HarmonyOS Sans Fonts License Agreement.",
              })}
            </span>{" "}
            <a
              href={HARMONY_FONT_LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-ink-faint"
            >
              HarmonyOS Sans Fonts License Agreement
            </a>
          </p>
        </section>
      </div>
    </aside>
  );
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function PresetThemePicker({
  value,
  onChange,
}: {
  value: PresetTheme;
  onChange: (v: PresetTheme) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo<Array<{ value: PresetTheme; label: string }>>(
    () => [
      { value: "default", label: t("settings.presetTheme.custom", { defaultValue: "默认" }) },
      { value: "paper", label: t("settings.presetTheme.paper", { defaultValue: "宣纸" }) },
      { value: "cherry", label: t("settings.presetTheme.cherry", { defaultValue: "樱吹雪" }) },
      { value: "pine", label: t("settings.presetTheme.pine", { defaultValue: "松烟" }) },
      { value: "ocean", label: t("settings.presetTheme.ocean", { defaultValue: "深海" }) },
      { value: "lavender", label: t("settings.presetTheme.lavender", { defaultValue: "薰衣草" }) },
      { value: "sunset", label: t("settings.presetTheme.sunset", { defaultValue: "黄昏" }) },
    ],
    [t],
  );
  return (
    <section className="space-y-2">
      <label className="block text-[11px] font-body text-ink-faint">
        {t("settings.presetTheme.label", { defaultValue: "预设主题" })}
      </label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1 rounded-full text-[11px] border transition-colors cursor-pointer ${
              value === opt.value
                ? "bg-bamboo text-white border-bamboo"
                : "bg-paper-warm/70 border-paper-deep/30 text-ink-soft hover:border-paper-deep/50"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function CodeThemePicker({
  value,
  onChange,
}: {
  value: CodeTheme;
  onChange: (v: CodeTheme) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo<Array<{ value: CodeTheme; label: string }>>(
    () => [
      { value: "light", label: t("settings.codeTheme.light", { defaultValue: "浅色" }) },
      { value: "dark", label: t("settings.codeTheme.dark", { defaultValue: "深色" }) },
    ],
    [t],
  );
  return (
    <section className="space-y-2">
      <label className="block text-[11px] font-body text-ink-faint">
        {t("settings.codeTheme.label", { defaultValue: "代码块主题" })}
      </label>
      <SlidingButtonGroup
        options={options}
        value={value}
        onChange={(v: CodeTheme) => onChange(v)}
      />
    </section>
  );
}

function EditorWidthPicker({
  value,
  onChange,
}: {
  value: EditorWidth;
  onChange: (v: EditorWidth) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo<Array<{ value: EditorWidth; label: string }>>(
    () => [
      { value: "narrow", label: t("settings.editorWidth.narrow", { defaultValue: "窄" }) },
      { value: "normal", label: t("settings.editorWidth.normal", { defaultValue: "标准" }) },
      { value: "wide", label: t("settings.editorWidth.wide", { defaultValue: "宽" }) },
    ],
    [t],
  );
  return (
    <SlidingButtonGroup
      options={options}
      value={value}
      onChange={(v: EditorWidth) => onChange(v)}
    />
  );
}

function SidebarPositionPicker({
  value,
  onChange,
}: {
  value: SidebarPosition;
  onChange: (v: SidebarPosition) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo<Array<{ value: SidebarPosition; label: string }>>(
    () => [
      { value: "left", label: t("settings.sidebarPosition.left", { defaultValue: "左侧" }) },
      { value: "right", label: t("settings.sidebarPosition.right", { defaultValue: "右侧" }) },
    ],
    [t],
  );
  return (
    <SlidingButtonGroup
      options={options}
      value={value}
      onChange={(v: SidebarPosition) => onChange(v)}
    />
  );
}

function ToggleRow({ label, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-center justify-between h-9 rounded-lg px-2.5 bg-paper-warm/45 border border-paper-deep/25 cursor-pointer">
      <span className="text-[12px] text-ink-soft">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <div
        className={`relative w-8 h-[18px] rounded-full transition-colors duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          checked ? "bg-bamboo" : "bg-paper-deep/50"
        }`}
      >
        <div
          className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.15)] transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            checked ? "translate-x-[14px]" : "translate-x-0"
          }`}
        />
      </div>
    </label>
  );
}

interface RangeRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function RangeRow({ label, value, min, max, step, format, onChange }: RangeRowProps) {
  return (
    <div className="flex items-center gap-3 h-9 rounded-lg px-2.5 bg-paper-warm/45 border border-paper-deep/25">
      <span className="w-9 text-[11px] text-ink-faint">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 h-1 accent-bamboo cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-paper-deep/50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bamboo [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
      />
      <span className="w-10 text-right text-[11px] font-mono text-ink-soft tabular-nums">
        {format(value)}
      </span>
    </div>
  );
}

interface ShortcutRecorderProps {
  value: string;
  onChange: (value: string) => void;
}

type ShortcutMsg = { key: string; params?: Record<string, string> } | { raw: string };

function ShortcutRecorder({ value, onChange }: ShortcutRecorderProps) {
  const { t } = useTranslation();
  const [checkState, setCheckState] = useState<"idle" | "checking" | "ok" | "warning" | "error">(
    "idle",
  );
  const [checkMsg, setCheckMsg] = useState<ShortcutMsg>({
    key: "settings.shortcut.forQuickNote",
  });
  const shortcutCheckRequestId = useRef(0);
  const isMounted = useRef(true);
  const platform = shortcutPlatform();

  const resolveMsg = (msg: ShortcutMsg): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "raw" in msg ? msg.raw : (t as any)(msg.key, msg.params);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      shortcutCheckRequestId.current += 1;
    };
  }, []);

  const isCurrentShortcutCheck = (requestId: number) =>
    isMounted.current && requestId === shortcutCheckRequestId.current;

  const invalidateShortcutChecks = () => {
    shortcutCheckRequestId.current += 1;
  };

  const markShortcutCleared = () => {
    invalidateShortcutChecks();
    setCheckState("idle");
    setCheckMsg({ key: "settings.shortcut.cleared" });
  };

  const runShortcutCheck = async (shortcut: string, saveWhenAvailable: boolean) => {
    // 未设置是合法状态，不需要调用后端做冲突检测。
    if (!shortcut) {
      markShortcutCleared();
      return;
    }

    const requestId = shortcutCheckRequestId.current + 1;
    shortcutCheckRequestId.current = requestId;
    setCheckState("checking");
    setCheckMsg({ key: "settings.shortcut.checking" });
    try {
      const result = await checkGlobalShortcut(shortcut);
      if (!isCurrentShortcutCheck(requestId)) return;
      const conflictMsg: ShortcutMsg = {
        key: `settings.shortcut.conflict.${result.conflictType}`,
        params: { shortcut },
      };
      if (result.available) {
        setCheckState("ok");
        setCheckMsg(conflictMsg);
        if (saveWhenAvailable) {
          onChange(shortcut);
        }
      } else {
        setCheckState("warning");
        setCheckMsg(conflictMsg);
      }
    } catch (error) {
      if (!isCurrentShortcutCheck(requestId)) return;
      setCheckState("error");
      setCheckMsg(
        error instanceof Error ? { raw: error.message } : { key: "settings.shortcut.checkFailed" },
      );
    }
  };

  const recorder = useShortcutRecorder({
    onRecord: (shortcut) => {
      if (shortcut === "") {
        onChange("");
        markShortcutCleared();
      } else if (isValidGlobalShortcut(shortcut)) {
        const configString = hotkeyToConfigString(shortcut, platform);
        void runShortcutCheck(configString, true);
      } else {
        invalidateShortcutChecks();
        setCheckState("warning");
        setCheckMsg({ key: "settings.shortcut.needsModifier" });
      }
    },
  });
  const containerRef = useRef<HTMLDivElement>(null);

  const clearShortcut = () => {
    // 显式清除会保存为空值，后端据此注销旧的全局快捷键绑定。
    recorder.cancelRecording();
    onChange("");
    markShortcutCleared();
  };

  useEffect(() => {
    if (!recorder.isRecording) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        recorder.cancelRecording();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [recorder.isRecording, recorder.cancelRecording]);

  const liveDisplay =
    recorder.isRecording && recorder.heldKeys.length > 0
      ? formatHeldKeys(recorder.heldKeys, platform)
      : null;
  const statusClass =
    checkState === "ok"
      ? "text-bamboo"
      : checkState === "warning" || checkState === "error"
        ? "text-red-400"
        : "text-ink-ghost";
  const isChecking = checkState === "checking";

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => recorder.startRecording()}
          className={`min-w-0 flex-1 h-8 px-2.5 rounded-lg border text-[12px] flex items-center gap-2 cursor-pointer transition-colors ${
            recorder.isRecording
              ? "bg-bamboo-mist/40 border-bamboo"
              : "bg-paper-warm/70 border-paper-deep/40 hover:border-paper-deep/60"
          }`}
        >
          {recorder.isRecording ? (
            <>
              <span className="flex-1 min-w-0 text-left text-bamboo truncate">
                {liveDisplay ||
                  t("settings.shortcut.pressHint", {
                    defaultValue: "按下快捷键；按 Delete 清空。",
                  })}
              </span>
              <span className="text-[10px] text-ink-faint shrink-0">
                {t("settings.shortcut.cancelHint", { defaultValue: "Esc 取消" })}
              </span>
            </>
          ) : (
            <>
              <span
                className={`flex-1 min-w-0 text-left truncate ${
                  value ? "text-ink-soft" : "text-ink-ghost"
                }`}
              >
                {value || t("settings.shortcut.notSet", { defaultValue: "未设置" })}
              </span>
              <span className="text-[10px] text-ink-ghost shrink-0">
                {t("settings.shortcut.clickToRecord", { defaultValue: "点击录制" })}
              </span>
            </>
          )}
        </button>
        <button
          type="button"
          disabled={!value || recorder.isRecording}
          onClick={clearShortcut}
          aria-label={t("settings.shortcut.clear", { defaultValue: "清除" })}
          title={t("settings.shortcut.clear", { defaultValue: "清除" })}
          className="w-8 h-8 rounded-lg border border-paper-deep/45 text-[15px] leading-none text-ink-faint hover:text-red-400 hover:bg-paper-warm/70 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          ×
        </button>
        <button
          type="button"
          disabled={!value || isChecking || recorder.isRecording}
          onClick={() => void runShortcutCheck(value, false)}
          className="h-8 px-3 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {isChecking
            ? t("settings.shortcut.checkingShort", { defaultValue: "检测中" })
            : t("settings.shortcut.check", { defaultValue: "检测" })}
        </button>
      </div>
      <p className={`min-h-4 text-[11px] ${statusClass}`}>{resolveMsg(checkMsg)}</p>
    </div>
  );
}
