import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "../locales";
import { INBOX_CATEGORY } from "../features/notes/insights";
import type { Note } from "../features/notes/types";
import {
  QuickCapture,
  appendEntryToDailyNoteContent,
  formatDailyTimestampedEntry,
  handleQuickCaptureKeyDown,
  submitQuickCapture,
  toggleCaptureTarget,
} from "./QuickCapture";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../features/windows/api", () => ({
  hideQuickCaptureWindow: vi.fn(() => Promise.resolve()),
}));

vi.mock("../features/windows/controls", () => ({
  showCurrentWindow: vi.fn(() => Promise.resolve()),
  startCurrentWindowDrag: vi.fn(() => Promise.resolve()),
}));

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    title: "2026-11-21",
    fileName: "note-1.md",
    category: "每日便笺",
    createdAt: "2026-11-21T08:00:00Z",
    updatedAt: "2026-11-21T08:00:00Z",
    wordCount: 10,
    content: "# 2026-11-21\n\n## 待办\n- [ ] \n\n## 随手记\n",
    tags: ["daily"],
    pinned: false,
    ...overrides,
  };
}

describe("QuickCapture", () => {
  test("renders floating capture card with Inbox selected by default", () => {
    const markup = renderToStaticMarkup(<QuickCapture />);

    expect(markup).toContain("快速捕获");
    expect(markup).toContain("收件箱");
    expect(markup).toContain("每日便笺");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("autofocus");
    expect(markup).toContain("Enter 保存");
  });

  test("renders inline error alert and daily target state", () => {
    const markup = renderToStaticMarkup(
      <QuickCapture
        initialTarget="daily"
        initialText="待提交内容"
        initialError="请输入内容后再保存"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("请输入内容后再保存");
    expect(markup).toContain("待提交内容");
  });

  test("renders localized UI across supported locales", async () => {
    const enInstance = i18n.cloneInstance({ lng: "en-US" });
    await enInstance.changeLanguage("en-US");
    const enMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={enInstance}>
        <QuickCapture />
      </I18nextProvider>,
    );
    expect(enMarkup).toContain("Quick Capture");
    expect(enMarkup).toContain("Inbox");
    expect(enMarkup).toContain("Daily Note");

    const hkInstance = i18n.cloneInstance({ lng: "zh-HK" });
    await hkInstance.changeLanguage("zh-HK");
    const hkMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={hkInstance}>
        <QuickCapture />
      </I18nextProvider>,
    );
    expect(hkMarkup).toContain("快速捕獲");
    expect(hkMarkup).toContain("每日便箋");
  });

  test("toggles capture target between inbox and daily", () => {
    expect(toggleCaptureTarget("inbox")).toBe("daily");
    expect(toggleCaptureTarget("daily")).toBe("inbox");
  });

  test("formats timestamped daily note entries for single and multiline text", () => {
    const now = new Date(2026, 10, 21, 9, 5, 0);
    expect(formatDailyTimestampedEntry("  买牛奶  ", now)).toBe("- **09:05** 买牛奶");
    expect(formatDailyTimestampedEntry("第一行\n第二行\n\n第三行", now)).toBe(
      "- **09:05** 第一行\n  第二行\n  \n  第三行",
    );
  });

  test("appends timestamped entries cleanly to daily note content", () => {
    expect(appendEntryToDailyNoteContent("", "- **09:05** 测试")).toBe("- **09:05** 测试\n");
    expect(appendEntryToDailyNoteContent("# 2026-11-21\n\n## 随手记\n", "- **09:05** 测试")).toBe(
      "# 2026-11-21\n\n## 随手记\n- **09:05** 测试\n",
    );
    expect(appendEntryToDailyNoteContent("已有文本", "- **09:05** 测试")).toBe(
      "已有文本\n- **09:05** 测试\n",
    );
  });

  test("creates an Inbox note and emits notes-changed when target is inbox", async () => {
    const created = makeNote({ id: "inbox-1", title: "", category: INBOX_CATEGORY, tags: [] });
    const createNoteMock = vi.fn(async () => created);
    const openDailyNoteMock = vi.fn();
    const updateNoteMock = vi.fn();
    const emitNotesChangedMock = vi.fn(async () => undefined);

    const result = await submitQuickCapture(
      { text: "  一条新灵感  ", target: "inbox" },
      {
        createNote: createNoteMock,
        openDailyNote: openDailyNoteMock,
        updateNote: updateNoteMock,
        emitNotesChanged: emitNotesChangedMock,
      },
    );

    expect(result).toBe(created);
    expect(createNoteMock).toHaveBeenCalledWith({
      title: "",
      content: "一条新灵感",
      category: INBOX_CATEGORY,
      tags: [],
      pinned: false,
    });
    expect(openDailyNoteMock).not.toHaveBeenCalled();
    expect(emitNotesChangedMock).toHaveBeenCalledOnce();
  });

  test("opens today's daily note, appends timestamped entry, and emits notes-changed", async () => {
    const existingDaily = makeNote({
      id: "daily-1",
      title: "2026-11-21",
      category: "每日便笺",
      tags: ["daily", "focus"],
      pinned: true,
      content: "# 2026-11-21\n\n## 随手记\n",
    });
    const updatedDaily = makeNote({
      ...existingDaily,
      content: "# 2026-11-21\n\n## 随手记\n- **14:08** 记得喝水\n",
    });
    const createNoteMock = vi.fn();
    const openDailyNoteMock = vi.fn(async () => existingDaily);
    const updateNoteMock = vi.fn(async () => updatedDaily);
    const emitNotesChangedMock = vi.fn(async () => undefined);

    const result = await submitQuickCapture(
      {
        text: "记得喝水",
        target: "daily",
        now: new Date(2026, 10, 21, 14, 8, 0),
      },
      {
        createNote: createNoteMock,
        openDailyNote: openDailyNoteMock,
        updateNote: updateNoteMock,
        emitNotesChanged: emitNotesChangedMock,
      },
    );

    expect(result).toBe(updatedDaily);
    expect(createNoteMock).not.toHaveBeenCalled();
    expect(openDailyNoteMock).toHaveBeenCalledOnce();
    expect(updateNoteMock).toHaveBeenCalledWith("daily-1", {
      title: "2026-11-21",
      content: "# 2026-11-21\n\n## 随手记\n- **14:08** 记得喝水\n",
      category: "每日便笺",
      tags: ["daily", "focus"],
      pinned: true,
    });
    expect(emitNotesChangedMock).toHaveBeenCalledOnce();
  });

  test("rejects empty or whitespace-only captures before touching storage", async () => {
    const createNoteMock = vi.fn();
    const openDailyNoteMock = vi.fn();
    const updateNoteMock = vi.fn();
    const emitNotesChangedMock = vi.fn(async () => undefined);

    await expect(
      submitQuickCapture(
        { text: "   \n\t  ", target: "inbox" },
        {
          createNote: createNoteMock,
          openDailyNote: openDailyNoteMock,
          updateNote: updateNoteMock,
          emitNotesChanged: emitNotesChangedMock,
        },
      ),
    ).rejects.toThrow("EMPTY_CAPTURE");

    expect(createNoteMock).not.toHaveBeenCalled();
    expect(openDailyNoteMock).not.toHaveBeenCalled();
    expect(emitNotesChangedMock).not.toHaveBeenCalled();
  });

  test("handles Enter, Shift+Enter, Tab, Esc, and ignores IME composing keys", () => {
    const onSubmit = vi.fn();
    const onToggleTarget = vi.fn();
    const onClose = vi.fn();

    // IME composition via nativeEvent.isComposing -> ignored
    const imePreventDefault = vi.fn();
    expect(
      handleQuickCaptureKeyDown(
        {
          key: "Enter",
          shiftKey: false,
          keyCode: 13,
          nativeEvent: { isComposing: true },
          preventDefault: imePreventDefault,
        },
        { isComposing: false, onSubmit, onToggleTarget, onClose },
      ),
    ).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(imePreventDefault).not.toHaveBeenCalled();

    // IME composition via composition state flag or keyCode 229 -> ignored
    expect(
      handleQuickCaptureKeyDown(
        {
          key: "Enter",
          shiftKey: false,
          keyCode: 229,
          nativeEvent: { isComposing: false },
          preventDefault: imePreventDefault,
        },
        { isComposing: true, onSubmit, onToggleTarget, onClose },
      ),
    ).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    // Shift+Enter -> newline (not intercepted)
    const shiftEnterPrevent = vi.fn();
    expect(
      handleQuickCaptureKeyDown(
        {
          key: "Enter",
          shiftKey: true,
          keyCode: 13,
          nativeEvent: { isComposing: false },
          preventDefault: shiftEnterPrevent,
        },
        { isComposing: false, onSubmit, onToggleTarget, onClose },
      ),
    ).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(shiftEnterPrevent).not.toHaveBeenCalled();

    // Plain Enter -> submits
    const enterPrevent = vi.fn();
    expect(
      handleQuickCaptureKeyDown(
        {
          key: "Enter",
          shiftKey: false,
          keyCode: 13,
          nativeEvent: { isComposing: false },
          preventDefault: enterPrevent,
        },
        { isComposing: false, onSubmit, onToggleTarget, onClose },
      ),
    ).toBe(true);
    expect(enterPrevent).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();

    // Tab -> toggles target
    const tabPrevent = vi.fn();
    expect(
      handleQuickCaptureKeyDown(
        {
          key: "Tab",
          shiftKey: false,
          keyCode: 9,
          nativeEvent: { isComposing: false },
          preventDefault: tabPrevent,
        },
        { isComposing: false, onSubmit, onToggleTarget, onClose },
      ),
    ).toBe(true);
    expect(tabPrevent).toHaveBeenCalledOnce();
    expect(onToggleTarget).toHaveBeenCalledOnce();

    // Escape -> closes
    const escPrevent = vi.fn();
    expect(
      handleQuickCaptureKeyDown(
        {
          key: "Escape",
          shiftKey: false,
          keyCode: 27,
          nativeEvent: { isComposing: false },
          preventDefault: escPrevent,
        },
        { isComposing: false, onSubmit, onToggleTarget, onClose },
      ),
    ).toBe(true);
    expect(escPrevent).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
