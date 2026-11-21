import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyTextareaEditWithUndo,
  buildHighlightSegments,
  findInitialMatchIndex,
  findMatches,
  replaceAllMatches,
  replaceMatchAt,
  selectAndScrollTextareaMatch,
  stepMatchIndex,
} from "./findReplace";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findReplace", () => {
  test("finds literal matches with case-insensitive and case-sensitive modes", () => {
    const text = "Hello hello HELLO";

    const insensitive = findMatches(text, "hello", { caseSensitive: false, regex: false });
    expect(insensitive.error).toBeNull();
    expect(insensitive.matches).toEqual([
      { start: 0, end: 5, text: "Hello" },
      { start: 6, end: 11, text: "hello" },
      { start: 12, end: 17, text: "HELLO" },
    ]);

    const sensitive = findMatches(text, "hello", { caseSensitive: true, regex: false });
    expect(sensitive.error).toBeNull();
    expect(sensitive.matches).toEqual([{ start: 6, end: 11, text: "hello" }]);
  });

  test("escapes special regex characters in literal mode", () => {
    const text = "Price is $10.00 (USD) [ok]?";
    const result = findMatches(text, "$10.00 (USD)", { caseSensitive: false, regex: false });
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ start: 9, end: 21, text: "$10.00 (USD)" }]);
  });

  test("handles valid regex, zero-width regex safety, and invalid regex errors without crashing", () => {
    const invalid = findMatches("hello world", "([unclosed", { caseSensitive: false, regex: true });
    expect(invalid.matches).toEqual([]);
    expect(invalid.error).toBeTruthy();

    // Zero-width regex (`a*`, `^`) must terminate cleanly without infinite loops.
    const zeroWidth = findMatches("aba", "a*", { caseSensitive: false, regex: true });
    expect(zeroWidth.error).toBeNull();
    expect(zeroWidth.matches).toEqual([
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "a" },
    ]);
  });

  test("selects initial match from cursor offset and steps circularly", () => {
    const matches = [
      { start: 2, end: 5, text: "foo" },
      { start: 10, end: 13, text: "foo" },
      { start: 20, end: 23, text: "foo" },
    ];

    expect(findInitialMatchIndex(matches, 0)).toBe(0);
    expect(findInitialMatchIndex(matches, 7)).toBe(1);
    expect(findInitialMatchIndex(matches, 25)).toBe(0);
    expect(findInitialMatchIndex([], 0)).toBe(-1);

    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(-1, 3, -1)).toBe(2);
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
  });

  test("replaces current match and all matches in literal and regex modes", () => {
    const content = "item-1, item-2, item-3";
    const literalMatches = findMatches(content, "item-", { caseSensitive: true, regex: false });
    const single = replaceMatchAt(content, literalMatches.matches, 1, "item-", "$&", {
      caseSensitive: true,
      regex: false,
    });
    expect(single.replaced).toBe(true);
    // Literal mode must keep `$&` verbatim instead of expanding it.
    expect(single.nextContent).toBe("item-1, $&2, item-3");

    const regexAll = replaceAllMatches(content, "item-(\\d+)", "#$1", {
      caseSensitive: true,
      regex: true,
    });
    expect(regexAll.error).toBeNull();
    expect(regexAll.count).toBe(3);
    expect(regexAll.nextContent).toBe("#1, #2, #3");
  });

  test("selects range and scrolls textarea match into view", () => {
    const setSelectionRange = vi.fn();
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
    const targetStart = lines.indexOf("line-30");
    const textarea = {
      value: lines,
      scrollTop: 0,
      clientHeight: 200,
      setSelectionRange,
    } as unknown as HTMLTextAreaElement;

    selectAndScrollTextareaMatch(textarea, {
      start: targetStart,
      end: targetStart + 7,
      text: "line-30",
    });

    expect(setSelectionRange).toHaveBeenCalledWith(targetStart, targetStart + 7);
    expect(textarea.scrollTop).toBeGreaterThan(0);
  });

  test("builds contiguous highlight segments with active flag and capped match window", () => {
    expect(buildHighlightSegments("", [], 0)).toEqual([]);
    expect(buildHighlightSegments("abc", [], 0)).toEqual([]);

    const content = "one foo two foo three";
    const { matches } = findMatches(content, "foo", { caseSensitive: true, regex: false });
    expect(buildHighlightSegments(content, matches, 1)).toEqual([
      { text: "one ", isMatch: false, isActive: false },
      { text: "foo", isMatch: true, isActive: false },
      { text: " two ", isMatch: false, isActive: false },
      { text: "foo", isMatch: true, isActive: true },
      { text: " three", isMatch: false, isActive: false },
    ]);

    const many = "a a a a a";
    const allA = findMatches(many, "a", { caseSensitive: true, regex: false }).matches;
    const capped = buildHighlightSegments(many, allA, 3, 2);
    const activeCount = capped.filter((segment) => segment.isActive).length;
    const matchCount = capped.filter((segment) => segment.isMatch).length;
    expect(capped.map((segment) => segment.text).join("")).toBe(many);
    expect(matchCount).toBe(2);
    expect(activeCount).toBe(1);
    expect(capped.find((segment) => segment.isActive)).toBeDefined();
  });

  test("applies textarea edits via execCommand insertText/delete, preserves scroll/focus, and falls back to setRangeText", () => {
    class FakeElement {}
    vi.stubGlobal("HTMLElement", FakeElement);

    const replaceInputFocus = vi.fn();
    const replaceInput = Object.assign(Object.create(FakeElement.prototype), {
      focus: replaceInputFocus,
    }) as HTMLElement;

    const createFakeTextarea = (initialValue: string) => {
      let selectionStart = 0;
      let selectionEnd = 0;
      const ta = {
        value: initialValue,
        disabled: false,
        scrollTop: 120,
        scrollLeft: 4,
        focus: vi.fn(),
        setSelectionRange: vi.fn((start: number, end: number) => {
          selectionStart = start;
          selectionEnd = end;
        }),
        setRangeText: vi.fn((replacement: string, start: number, end: number) => {
          ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(end);
        }),
        get selection() {
          return { selectionStart, selectionEnd };
        },
      };
      return ta;
    };

    // 1. insertText path
    const ta1 = createFakeTextarea("hello foo world");
    const execInsert = vi.fn((cmd: string, _showUi: boolean, text?: string) => {
      if (cmd === "insertText" && typeof text === "string") {
        const { selectionStart, selectionEnd } = ta1.selection;
        ta1.value = ta1.value.slice(0, selectionStart) + text + ta1.value.slice(selectionEnd);
        return true;
      }
      return false;
    });
    vi.stubGlobal("document", {
      activeElement: replaceInput,
      execCommand: execInsert,
    });

    const ok1 = applyTextareaEditWithUndo(
      ta1 as unknown as HTMLTextAreaElement,
      6,
      9,
      "bar",
      "hello bar world",
    );
    expect(ok1).toBe(true);
    expect(execInsert).toHaveBeenCalledWith("insertText", false, "bar");
    expect(ta1.setRangeText).not.toHaveBeenCalled();
    expect(ta1.value).toBe("hello bar world");
    expect(ta1.scrollTop).toBe(120);
    expect(ta1.scrollLeft).toBe(4);
    expect(replaceInputFocus).toHaveBeenCalledWith({ preventScroll: true });

    // 2. delete path when replacementText is empty
    const ta2 = createFakeTextarea("hello foo world");
    const execDelete = vi.fn((cmd: string) => {
      if (cmd === "delete") {
        const { selectionStart, selectionEnd } = ta2.selection;
        ta2.value = ta2.value.slice(0, selectionStart) + ta2.value.slice(selectionEnd);
        return true;
      }
      return false;
    });
    vi.stubGlobal("document", {
      activeElement: replaceInput,
      execCommand: execDelete,
    });

    const ok2 = applyTextareaEditWithUndo(
      ta2 as unknown as HTMLTextAreaElement,
      6,
      9,
      "",
      "hello  world",
    );
    expect(ok2).toBe(true);
    expect(execDelete).toHaveBeenCalledWith("delete", false);
    expect(ta2.value).toBe("hello  world");

    // 3. fallback to setRangeText when execCommand returns false
    const ta3 = createFakeTextarea("hello foo world");
    vi.stubGlobal("document", {
      activeElement: replaceInput,
      execCommand: vi.fn(() => false),
    });

    const ok3 = applyTextareaEditWithUndo(
      ta3 as unknown as HTMLTextAreaElement,
      6,
      9,
      "baz",
      "hello baz world",
    );
    expect(ok3).toBe(true);
    expect(ta3.setRangeText).toHaveBeenCalledWith("baz", 6, 9, "end");
    expect(ta3.value).toBe("hello baz world");

    expect(applyTextareaEditWithUndo(null, 0, 1, "x", "x")).toBe(false);
  });
});
