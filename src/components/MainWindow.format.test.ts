import type { TFunction } from "i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyFormat } from "./MainWindow";

type TextareaStub = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  scrollLeft: number;
  focus: () => void;
  setRangeText: (replacement: string, start: number, end: number) => void;
  setSelectionRange: (start: number, end: number) => void;
};

function makeTextarea(value: string, selectionStart: number): TextareaStub {
  return {
    value,
    selectionStart,
    selectionEnd: selectionStart,
    scrollTop: 480,
    scrollLeft: 12,
    focus: vi.fn(),
    setRangeText(replacement, start, end) {
      this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
      // Simulate a browser scrolling the selection back into view during reconciliation.
      this.scrollTop = 0;
      this.scrollLeft = 0;
    },
  };
}

const translate = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyFormat", () => {
  test("preserves the editor viewport after formatting content near the bottom", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const textarea = makeTextarea("top\n\ncontent near the bottom", 25);
    const setContent = vi.fn();
    const markDirty = vi.fn();

    applyFormat(textarea as unknown as HTMLTextAreaElement, "hr", translate, setContent, markDirty);

    expect(textarea.scrollTop).toBe(480);
    expect(textarea.scrollLeft).toBe(12);
    expect(setContent).toHaveBeenCalledOnce();
    expect(markDirty).toHaveBeenCalledOnce();
  });
});
