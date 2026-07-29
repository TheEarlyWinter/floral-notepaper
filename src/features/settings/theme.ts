import type { PresetTheme, ThemeOption } from "./types";
import chroma from "chroma-js";

function resolveTheme(option: ThemeOption): "light" | "dark" {
  if (option === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return option;
}

export function applyTheme(option: ThemeOption): void {
  const root = document.documentElement;
  const resolved = resolveTheme(option);
  localStorage.setItem("theme-option", option);
  localStorage.setItem("theme-resolved", resolved);
  if (root.getAttribute("data-theme") !== resolved) {
    root.classList.add("theme-transition");
    root.setAttribute("data-theme", resolved);
    setTimeout(() => root.classList.remove("theme-transition"), 400);
  }
}

export function applyPresetTheme(preset: PresetTheme): void {
  const root = document.documentElement;
  if (preset && preset !== "default") {
    root.setAttribute("data-preset-theme", preset);
  } else {
    root.removeAttribute("data-preset-theme");
  }
}

/**
 * 计算强调色的衍生色：
 * - accent-light: 更亮的变体
 * - accent-mist: 极浅背景
 * - accent-glow: 浅背景
 */
function computeAccentDerivatives(accent: string): {
  light: string;
  mist: string;
  glow: string;
} {
  const c = chroma(accent);
  const isDark = c.luminance() < 0.5;

  // light: 提高亮度、略微降低饱和度
  const light = c
    .set("hsl.l", Math.min(c.get("hsl.l") + 0.12, 0.85))
    .set("hsl.s", Math.max(c.get("hsl.s") - 0.05, 0.3))
    .hex();

  // mist: 极高亮度、极低饱和度
  const mist = isDark
    ? chroma.mix(c, "white", 0.92, "lab").hex()
    : chroma.mix(c, "white", 0.88, "lab").hex();

  // glow: 高亮度、低饱和度
  const glow = isDark
    ? chroma.mix(c, "white", 0.82, "lab").hex()
    : chroma.mix(c, "white", 0.72, "lab").hex();

  return { light, mist, glow };
}

/**
 * 应用自定义强调色。
 * 仅在 presetTheme 为空时生效（预设主题自带强调色）。
 */
export function applyAccentColor(accent: string, presetTheme: PresetTheme): void {
  const root = document.documentElement;
  if (!accent || (presetTheme && presetTheme !== "default")) {
    // 清除自定义强调色，恢复预设/CSS 默认值
    root.style.removeProperty("--color-bamboo");
    root.style.removeProperty("--color-bamboo-light");
    root.style.removeProperty("--color-bamboo-mist");
    root.style.removeProperty("--color-bamboo-glow");
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-light");
    root.style.removeProperty("--color-accent-mist");
    root.style.removeProperty("--color-accent-glow");
    return;
  }

  // 文本输入框会经历 "#"、"#3" 等中间状态；此时保留上一个有效颜色，
  // 避免 chroma 抛异常导致整个 React 事件处理失败。
  if (!chroma.valid(accent)) return;

  const { light, mist, glow } = computeAccentDerivatives(accent);
  root.style.setProperty("--color-bamboo", accent);
  root.style.setProperty("--color-bamboo-light", light);
  root.style.setProperty("--color-bamboo-mist", mist);
  root.style.setProperty("--color-bamboo-glow", glow);
  root.style.setProperty("--color-accent", accent);
  root.style.setProperty("--color-accent-light", light);
  root.style.setProperty("--color-accent-mist", mist);
  root.style.setProperty("--color-accent-glow", glow);
}

export function applyCodeTheme(codeTheme: "light" | "dark"): void {
  const root = document.documentElement;
  root.setAttribute("data-code-theme", codeTheme);
}

export function applyEditorFont(fontFamily: string): void {
  const root = document.documentElement;
  if (fontFamily) {
    root.style.setProperty("--editor-font-family", fontFamily);
  } else {
    root.style.removeProperty("--editor-font-family");
  }
}

export function applyEditorLineHeight(lineHeight: number): void {
  const root = document.documentElement;
  root.style.setProperty("--editor-line-height", String(lineHeight));
}

export function applyEditorParagraphSpacing(spacing: number): void {
  const root = document.documentElement;
  root.style.setProperty("--editor-paragraph-spacing", `${spacing}px`);
}

export function applyEditorWidth(width: string): void {
  const root = document.documentElement;
  root.setAttribute("data-editor-width", width || "normal");
}

export function applySidebarPosition(position: string): void {
  const root = document.documentElement;
  root.setAttribute("data-sidebar-position", position || "left");
}

export function applyWindowOpacity(opacity: number): void {
  const root = document.documentElement;
  root.style.setProperty("--window-opacity", String(opacity));
}

let systemListener: (() => void) | null = null;

export function watchSystemTheme(option: ThemeOption): () => void {
  if (systemListener) {
    systemListener();
    systemListener = null;
  }

  if (option !== "system") return () => {};

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => applyTheme("system");
  mql.addEventListener("change", handler);

  const cleanup = () => {
    mql.removeEventListener("change", handler);
    if (systemListener === cleanup) {
      systemListener = null;
    }
  };
  systemListener = cleanup;
  return cleanup;
}
