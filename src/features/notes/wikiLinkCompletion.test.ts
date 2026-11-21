import type { TFunction } from "i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NoteMetadata } from "./types";
import {
  detectWikiLinkTrigger,
  filterWikiLinkCandidates,
  handleWikiLinkKeyDown,
  insertWikiLinkCompletion,
  isInsideFencedCodeBlock,
} from "./wikiLinkCompletion";

const sampleNotes: NoteMetadata[] = [
  {
    id: "n1",
    title: "Rust Async",
    fileName: "n1.md",
    category: "编程",
    createdAt: "2026-11-10T08:00:00Z",
    updatedAt: "2026-11-21T10:00:00Z",
    wordCount: 100,
    preview: "Tokio task scheduling and futures",
    tags: ["rust", "async"],
    pinned: false,
  },
  {
    id: "n2",
    title: "Rust",
    fileName: "n2.md",
    category: "语言",
    createdAt: "2026-11-10T08:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    wordCount: 50,
    preview: "Ownership and borrowing",
    tags: ["systems"],
    pinned: true,
  },
  {
    id: "n3",
    title: "每日总结",
    fileName: "n3.md",
    category: "日记",
    createdAt: "2026-11-10T08:00:00Z",
    updatedAt: "2026-11-19T10:00:00Z",
    wordCount: 30,
    preview: "今天复习了 Rust 所有权",
    tags: ["daily"],
    pinned: false,
  },
  {
    id: "n4",
    title: "  ",
    fileName: "n4.md",
    category: "收件箱",
    createdAt: "2026-11-10T08:00:00Z",
    updatedAt: "2026-11-18T10:00:00Z",
    wordCount: 10,
    preview: "无标题草稿",
    tags: [],
    pinned: false,
  },
];

interface TextareaStub {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  scrollLeft: number;
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
  setRangeText: (replacement: string, start: number, end: number) => void;
}

function makeTextarea(value: string, selectionStart: number): TextareaStub {
  return {
    value,
    selectionStart,
    selectionEnd: selectionStart,
    scrollTop: 320,
    scrollLeft: 14,
    focus: vi.fn(),
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.scrollTop = 0;
      this.scrollLeft = 0;
    },
    setRangeText(replacement, start, end) {
      this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wikiLinkCompletion", () => {
  test("detects unclosed [[query before cursor and ignores closed or ranged selections", () => {
    expect(detectWikiLinkTrigger("参考 [[", 5)).toEqual({
      startOffset: 3,
      endOffset: 5,
      query: "",
    });
    expect(detectWikiLinkTrigger("参考 [[rust 异步", 12)).toEqual({
      startOffset: 3,
      endOffset: 12,
      query: "rust 异步",
    });
    expect(detectWikiLinkTrigger("先看 [[旧笔记]] 再看 [[新笔记", 19)).toEqual({
      startOffset: 14,
      endOffset: 19,
      query: "新笔记",
    });
    expect(detectWikiLinkTrigger("[[rust", 4, 6)).toBeNull();
    expect(detectWikiLinkTrigger("[[rust]]", 8)).toBeNull();
    expect(detectWikiLinkTrigger("[[rust]]", 4)).toBeNull();
    expect(detectWikiLinkTrigger("[[note:n1|Rust]]", 12)).toBeNull();
    expect(detectWikiLinkTrigger("[[rust\n下一行", 10)).toBeNull();
  });

  test("ignores [[query inside backtick and tilde fenced code blocks", () => {
    const backtickDoc = [
      "前面 [[valid",
      "```ts",
      'const x = "[[insideBacktick";',
      "```",
      "后面 [[after",
    ].join("\n");

    const insideOffset = backtickDoc.indexOf("insideBacktick") + "insideBacktick".length;
    const afterOffset = backtickDoc.length;
    const beforeOffset = backtickDoc.indexOf("valid") + "valid".length;

    expect(isInsideFencedCodeBlock(backtickDoc, beforeOffset)).toBe(false);
    expect(isInsideFencedCodeBlock(backtickDoc, insideOffset)).toBe(true);
    expect(isInsideFencedCodeBlock(backtickDoc, afterOffset)).toBe(false);
    expect(detectWikiLinkTrigger(backtickDoc, insideOffset)).toBeNull();
    expect(detectWikiLinkTrigger(backtickDoc, afterOffset)).toEqual({
      startOffset: afterOffset - "[[after".length,
      endOffset: afterOffset,
      query: "after",
    });

    const tildeNestedDoc = [
      "~~~markdown",
      "```",
      "[[stillInsideTilde",
      "~~~",
      "[[outsideTilde",
    ].join("\r\n");

    const nestedInside = tildeNestedDoc.indexOf("stillInsideTilde") + "stillInsideTilde".length;
    const nestedOutside = tildeNestedDoc.length;
    expect(detectWikiLinkTrigger(tildeNestedDoc, nestedInside)).toBeNull();
    expect(detectWikiLinkTrigger(tildeNestedDoc, nestedOutside)).toEqual({
      startOffset: nestedOutside - "[[outsideTilde".length,
      endOffset: nestedOutside,
      query: "outsideTilde",
    });
  });

  test("filters and ranks candidate notes while excluding active note", () => {
    expect(filterWikiLinkCandidates(sampleNotes, "", "n1").map((n) => n.id)).toEqual([
      "n2",
      "n3",
      "n4",
    ]);

    const rustMatches = filterWikiLinkCandidates(sampleNotes, "rust");
    expect(rustMatches.map((n) => n.id)).toEqual(["n2", "n1", "n3"]);

    expect(filterWikiLinkCandidates(sampleNotes, "#daily").map((n) => n.id)).toEqual(["n3"]);
  });

  test("replaces [[query cleanly, preserves scroll & cursor, and uses execCommand when supported", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });

    const value = "前言 [[ru 结尾";
    const cursor = "前言 [[ru".length;
    const textarea = makeTextarea(value, cursor);
    const execCommand = vi.fn((_cmd: string, _ui: boolean, text: string) => {
      textarea.value = `${textarea.value.slice(0, textarea.selectionStart)}${text}${textarea.value.slice(textarea.selectionEnd)}`;
      return true;
    });
    vi.stubGlobal("document", { execCommand });

    const setContent = vi.fn();
    const markDirty = vi.fn();
    const trigger = detectWikiLinkTrigger(textarea.value, cursor)!;

    const next = insertWikiLinkCompletion(
      textarea as unknown as HTMLTextAreaElement,
      trigger,
      sampleNotes[1],
      setContent,
      markDirty,
    );

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "[[note:n2|Rust]]");
    expect(next).toBe("前言 [[note:n2|Rust]] 结尾");
    expect(textarea.value).toBe("前言 [[note:n2|Rust]] 结尾");
    expect(textarea.selectionStart).toBe(3 + "[[note:n2|Rust]]".length);
    expect(textarea.selectionEnd).toBe(3 + "[[note:n2|Rust]]".length);
    expect(textarea.scrollTop).toBe(320);
    expect(textarea.scrollLeft).toBe(14);
    expect(setContent).toHaveBeenCalledWith("前言 [[note:n2|Rust]] 结尾");
    expect(markDirty).toHaveBeenCalledOnce();
  });

  test("falls back to setRangeText and localizes untitled note labels", () => {
    const textarea = makeTextarea("[[", 2);
    const setContent = vi.fn();
    const markDirty = vi.fn();
    const translate = ((key: string, opts?: { defaultValue?: string }) =>
      key === "common.untitledNote"
        ? "Untitled Note"
        : (opts?.defaultValue ?? key)) as unknown as TFunction;

    const next = insertWikiLinkCompletion(
      textarea as unknown as HTMLTextAreaElement,
      { startOffset: 0, endOffset: 2, query: "" },
      sampleNotes[3],
      setContent,
      markDirty,
      translate,
    );

    expect(next).toBe("[[note:n4|Untitled Note]]");
    expect(textarea.value).toBe("[[note:n4|Untitled Note]]");
  });

  test("handles keyboard navigation when open and leaves closed editor typing untouched", () => {
    const onMove = vi.fn();
    const onSelectActive = vi.fn();
    const onDismiss = vi.fn();

    for (const key of ["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"]) {
      const preventDefault = vi.fn();
      expect(
        handleWikiLinkKeyDown(
          { key, preventDefault },
          { isOpen: false, candidateCount: 3, onMove, onSelectActive, onDismiss },
        ),
      ).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    }

    // IME composing must pass through
    const imePrevent = vi.fn();
    expect(
      handleWikiLinkKeyDown(
        { key: "Enter", nativeEvent: { isComposing: true }, preventDefault: imePrevent },
        { isOpen: true, candidateCount: 3, onMove, onSelectActive, onDismiss },
      ),
    ).toBe(false);
    expect(imePrevent).not.toHaveBeenCalled();

    // Open with candidates
    const downPrevent = vi.fn();
    expect(
      handleWikiLinkKeyDown(
        { key: "ArrowDown", preventDefault: downPrevent },
        { isOpen: true, candidateCount: 3, onMove, onSelectActive, onDismiss },
      ),
    ).toBe(true);
    expect(downPrevent).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith(1);

    const upPrevent = vi.fn();
    expect(
      handleWikiLinkKeyDown(
        { key: "ArrowUp", preventDefault: upPrevent },
        { isOpen: true, candidateCount: 3, onMove, onSelectActive, onDismiss },
      ),
    ).toBe(true);
    expect(upPrevent).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith(-1);

    const tabPrevent = vi.fn();
    expect(
      handleWikiLinkKeyDown(
        { key: "Tab", preventDefault: tabPrevent },
        { isOpen: true, candidateCount: 3, onMove, onSelectActive, onDismiss },
      ),
    ).toBe(true);
    expect(tabPrevent).toHaveBeenCalledOnce();
    expect(onSelectActive).toHaveBeenCalledTimes(1);

    const enterPrevent = vi.fn();
    expect(
      handleWikiLinkKeyDown(
        { key: "Enter", preventDefault: enterPrevent },
        { isOpen: true, candidateCount: 3, onMove, onSelectActive, onDismiss },
      ),
    ).toBe(true);
    expect(enterPrevent).toHaveBeenCalledOnce();
    expect(onSelectActive).toHaveBeenCalledTimes(2);

    const escPrevent = vi.fn();
    expect(
      handleWikiLinkKeyDown(
        { key: "Escape", preventDefault: escPrevent },
        { isOpen: true, candidateCount: 0, onMove, onSelectActive, onDismiss },
      ),
    ).toBe(true);
    expect(escPrevent).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
