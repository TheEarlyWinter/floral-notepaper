import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";
import { i18n } from "../locales";
import {
  FindReplaceBar,
  handleFindInputKeyDown,
  handleReplaceInputKeyDown,
} from "./FindReplaceBar";

describe("FindReplaceBar", () => {
  test("renders find bar with match counter and toggles, and hides when closed", () => {
    const contentRef = createRef<HTMLTextAreaElement>();
    const closedMarkup = renderToStaticMarkup(
      <FindReplaceBar
        open={false}
        showReplace={false}
        content="hello world hello"
        contentRef={contentRef}
        focusSignal={0}
        onToggleShowReplace={vi.fn()}
        onContentChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(closedMarkup).toBe("");

    const openMarkup = renderToStaticMarkup(
      <FindReplaceBar
        open={true}
        showReplace={true}
        content="hello world hello"
        contentRef={contentRef}
        focusSignal={1}
        initialQuery="hello"
        onToggleShowReplace={vi.fn()}
        onContentChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(openMarkup).toContain("find-replace-bar");
    expect(openMarkup).toContain("Aa");
    expect(openMarkup).toContain(".*");
    expect(openMarkup).toContain("0 / 2");
    expect(openMarkup).toContain("替换");
    expect(openMarkup).toContain("全部替换");
  });

  test("renders localized labels across en-US and zh-HK", async () => {
    const contentRef = createRef<HTMLTextAreaElement>();
    const en = i18n.cloneInstance({ lng: "en-US" });
    await en.changeLanguage("en-US");
    const enMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={en}>
        <FindReplaceBar
          open={true}
          showReplace={true}
          content="abc"
          contentRef={contentRef}
          focusSignal={1}
          onToggleShowReplace={vi.fn()}
          onContentChange={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(enMarkup).toContain("Find…");
    expect(enMarkup).toContain("Replace with…");
    expect(enMarkup).toContain("Replace All");

    const hk = i18n.cloneInstance({ lng: "zh-HK" });
    await hk.changeLanguage("zh-HK");
    const hkMarkup = renderToStaticMarkup(
      <I18nextProvider i18n={hk}>
        <FindReplaceBar
          open={true}
          showReplace={true}
          content="abc"
          contentRef={contentRef}
          focusSignal={1}
          onToggleShowReplace={vi.fn()}
          onContentChange={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(hkMarkup).toContain("尋找…");
    expect(hkMarkup).toContain("全部替換");
  });

  test("handles Enter, Shift+Enter, Escape, and IME composing in find & replace inputs", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();
    const onReplaceCurrent = vi.fn();

    expect(
      handleFindInputKeyDown(
        {
          key: "Enter",
          shiftKey: false,
          nativeEvent: { isComposing: true },
          preventDefault: vi.fn(),
        },
        { isComposing: false, onNext, onPrev, onClose },
      ),
    ).toBe(false);
    expect(onNext).not.toHaveBeenCalled();

    const preventEnter = vi.fn();
    expect(
      handleFindInputKeyDown(
        { key: "Enter", shiftKey: false, preventDefault: preventEnter },
        { isComposing: false, onNext, onPrev, onClose },
      ),
    ).toBe(true);
    expect(preventEnter).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();

    expect(
      handleFindInputKeyDown(
        { key: "Enter", shiftKey: true, preventDefault: vi.fn() },
        { isComposing: false, onNext, onPrev, onClose },
      ),
    ).toBe(true);
    expect(onPrev).toHaveBeenCalledOnce();

    expect(
      handleFindInputKeyDown(
        { key: "Escape", shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() },
        { isComposing: false, onNext, onPrev, onClose },
      ),
    ).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();

    expect(
      handleReplaceInputKeyDown(
        { key: "Enter", shiftKey: false, preventDefault: vi.fn() },
        { isComposing: false, onReplaceCurrent, onClose },
      ),
    ).toBe(true);
    expect(onReplaceCurrent).toHaveBeenCalledOnce();
  });
});
