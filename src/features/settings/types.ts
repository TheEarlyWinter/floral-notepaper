export type ViewMode = "edit" | "split" | "preview";

export type ThemeOption = "light" | "dark" | "system";

export type TileColorMode = "system" | "custom";
export type BackgroundFit = "cover" | "contain" | "repeat";

/** 预设主题名："default" 表示不使用预设（使用自定义主题色） */
export type PresetTheme = "default" | "paper" | "cherry" | "pine" | "ocean" | "lavender" | "sunset";

export type CodeTheme = "light" | "dark";

export type EditorWidth = "narrow" | "normal" | "wide";

export type SidebarPosition = "left" | "right";

export interface NoteTemplate {
  id: string;
  name: string;
  content: string;
}

export interface AppConfig {
  locale: string;
  dataDir: string;
  globalShortcut: string;
  closeToTray: boolean;
  closeTabShortcut: string;
  autostart: boolean;
  defaultViewMode: string;
  noteAutoSave: boolean;
  noteSurfaceAutoSave: boolean;
  tileColor: string;
  tileColorMode: TileColorMode;
  theme: ThemeOption;
  fontSize: number;
  surfaceFontSize: number;
  tabIndentSize: number;
  externalFileAutoSave: boolean;
  rememberSurfaceSize: boolean;
  tileCtrlClose: boolean;
  tileDoubleClickToEdit: boolean;
  tileSaveReturnsToPin: boolean;
  tileRenderMarkdown: boolean;
  renderHtmlMarkdown: boolean;
  splitScrollSync: boolean;
  surfaceWidth?: number;
  surfaceHeight?: number;
  toggleVisibilityShortcut: string;
  openAtCursor: boolean;
  backgroundImagePath?: string;
  backgroundFit?: BackgroundFit;
  backgroundDim?: number;
  backgroundBlur?: number;
  backgroundScale?: number;
  backgroundPositionX?: number;
  backgroundPositionY?: number;
  // ── 主题系统升级 ──
  presetTheme: PresetTheme;
  accentColor: string;
  codeTheme: CodeTheme;
  // ── 排版定制 ──
  editorFontFamily: string;
  editorLineHeight: number;
  editorParagraphSpacing: number;
  editorWidth: EditorWidth;
  // ── 布局定制 ──
  sidebarPosition: SidebarPosition;
  windowOpacity: number;
  rememberWindowSize: boolean;
  // ── Markdown 渲染 ──
  showOutline: boolean;
  codeLineNumbers: boolean;
  linkPreview: boolean;
  // ── 自定义 CSS ──
  customCss: string;
  templates: NoteTemplate[];
}
