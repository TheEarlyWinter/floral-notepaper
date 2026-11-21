import type { TFunction } from "i18next";

export type FormatAction =
  | "bold"
  | "italic"
  | "heading"
  | "hr"
  | "ul"
  | "ol"
  | "code"
  | "quote"
  | "inlineMath"
  | "blockMath";

export interface ToolbarButtonConfig {
  label: string;
  title: string;
  style: string;
  action: FormatAction;
}

export function applyFormat(
  textarea: HTMLTextAreaElement,
  action: FormatAction,
  translate: TFunction,
  setContent: (v: string) => void,
  markDirty: () => void,
) {
  const { selectionStart: start, selectionEnd: end, value, scrollTop, scrollLeft } = textarea;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const lineStart = before.lastIndexOf("\n") + 1;
  const currentLine = before.slice(lineStart);

  let result: string;
  let cursorStart: number;
  let cursorEnd: number;

  switch (action) {
    case "bold": {
      const fallback = translate("main.formatSample.boldText", { defaultValue: "粗体文本" });
      const wrapped = `**${selected || fallback}**`;
      result = before + wrapped + after;
      cursorStart = start + 2;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "italic": {
      const fallback = translate("main.formatSample.italicText", { defaultValue: "斜体文本" });
      const wrapped = `*${selected || fallback}*`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "heading": {
      const prefix = currentLine.match(/^(#{1,5})\s/);
      if (prefix) {
        const newLevel = prefix[1].length < 5 ? "#".repeat(prefix[1].length + 1) : "#";
        const beforeLine = value.slice(0, lineStart);
        const afterPrefix = value.slice(lineStart + prefix[0].length);
        result = beforeLine + newLevel + " " + afterPrefix;
        const offset = newLevel.length + 1 - prefix[0].length;
        cursorStart = start + offset;
        cursorEnd = end + offset;
      } else if (currentLine.length > 0 && start === end) {
        result = value.slice(0, lineStart) + "## " + value.slice(lineStart);
        cursorStart = start + 3;
        cursorEnd = cursorStart;
      } else if (selected) {
        result = before + `## ${selected}` + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + selected.length;
      } else {
        result =
          before +
          `## ${translate("main.formatSample.headingText", { defaultValue: "标题" })}` +
          after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + 2;
      }
      break;
    }
    case "hr": {
      const newlineBefore = before.endsWith("\n") || before === "" ? "" : "\n";
      const newlineAfter = after.startsWith("\n") || after === "" ? "" : "\n";
      result = before + `${newlineBefore}---${newlineAfter}` + after;
      cursorStart = cursorEnd = before.length + newlineBefore.length + 3;
      break;
    }
    case "ul": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `- ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `- ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "ol": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `1. ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "code": {
      if (selected.includes("\n")) {
        const wrapped = "```\n" + selected + "\n```";
        result = before + wrapped + after;
        cursorStart = start + 4;
        cursorEnd = cursorStart + selected.length;
      } else {
        const fallback = translate("main.formatSample.codeText", { defaultValue: "代码" });
        const wrapped = `\`${selected || fallback}\``;
        result = before + wrapped + after;
        cursorStart = start + 1;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "quote": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.quoteText", { defaultValue: "引用文本" });
        const item = `> ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "inlineMath": {
      const wrapped = `$${selected || "E=mc^2"}$`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || "E=mc^2").length;
      break;
    }
    case "blockMath": {
      const wrapped = `\n$$\n${selected || "x^2 + y^2 = r^2"}\n$$\n`;
      result = before + wrapped + after;
      cursorStart = start + 4;
      cursorEnd = cursorStart + (selected || "x^2 + y^2 = r^2").length;
      break;
    }
  }

  textarea.focus();
  // 只替换 textarea 当前内容，不走已废弃的 execCommand("insertText")。
  // setRangeText 仍保留原生输入控件的编辑语义，React state 同步后再恢复光标。
  textarea.setRangeText(result, 0, value.length, "preserve");
  setContent(result);
  markDirty();
  requestAnimationFrame(() => {
    textarea.setSelectionRange(cursorStart, cursorEnd);
    // React's controlled-value reconciliation or selection restoration can scroll a
    // textarea back to the beginning. Put the viewport back after both operations.
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  });
}

export function runEditorCommand(
  textarea: HTMLTextAreaElement | null,
  command: "undo" | "redo",
): boolean {
  if (!textarea || textarea.disabled) return false;
  textarea.focus();
  return document.execCommand(command);
}

export function getToolbarButtons(t: TFunction): ToolbarButtonConfig[] {
  return [
    {
      label: "B",
      title: t("main.toolbar.bold", { defaultValue: "粗体" }),
      style: "font-bold",
      action: "bold",
    },
    {
      label: "I",
      title: t("main.toolbar.italic", { defaultValue: "斜体" }),
      style: "italic",
      action: "italic",
    },
    {
      label: "H",
      title: t("main.toolbar.heading", { defaultValue: "标题" }),
      style: "font-bold",
      action: "heading",
    },
    {
      label: "—",
      title: t("main.toolbar.hr", { defaultValue: "分割线" }),
      style: "",
      action: "hr",
    },
    {
      label: "•",
      title: t("main.toolbar.ul", { defaultValue: "无序列表" }),
      style: "",
      action: "ul",
    },
    {
      label: "1.",
      title: t("main.toolbar.ol", { defaultValue: "有序列表" }),
      style: "font-mono text-[9px]",
      action: "ol",
    },
    {
      label: "<>",
      title: t("main.toolbar.code", { defaultValue: "代码" }),
      style: "font-mono text-[9px]",
      action: "code",
    },
    {
      label: "❝",
      title: t("main.toolbar.quote", { defaultValue: "引用" }),
      style: "",
      action: "quote",
    },
    {
      label: "∑",
      title: t("main.toolbar.inlineMath", { defaultValue: "行内公式" }),
      style: "font-mono text-[11px]",
      action: "inlineMath",
    },
    {
      label: "∫",
      title: t("main.toolbar.blockMath", { defaultValue: "块级公式" }),
      style: "font-mono text-[11px]",
      action: "blockMath",
    },
  ];
}
