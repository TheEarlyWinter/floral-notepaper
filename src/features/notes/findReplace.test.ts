import { describe, expect, test, vi } from "vitest";
import {
  findInitialMatchIndex,
  findMatches,
  replaceAllMatches,
  replaceMatchAt,
  selectAndScrollTextareaMatch,
  stepMatchIndex,
} from "./findReplace";

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
});
