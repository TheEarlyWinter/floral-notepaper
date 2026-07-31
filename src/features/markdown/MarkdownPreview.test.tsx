import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

describe("MarkdownPreview", () => {
  test("marks rendered Markdown content as selectable", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# 花笺\n\n正文" />);

    expect(markup).toContain("markdown-selectable");
    expect(markup).toContain("<h1");
    expect(markup).toContain("花笺");
    expect(markup).toContain("正文");
  });

  test("uses rehype-slug IDs that match the outline generator for punctuation", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# 标题 & 测试" />);

    expect(markup).toContain('id="标题--测试"');
  });

  test("keeps code block controls outside the horizontally scrollable pre", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content={"```text\nvery long code line\n```"} />,
    );

    const preCloseIndex = markup.indexOf("</pre>");
    const buttonIndex = markup.indexOf("<button");

    expect(markup).toContain("markdown-code-block");
    expect(markup).toContain("markdown-code-scroll");
    expect(preCloseIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeGreaterThan(preCloseIndex);
  });

  test("renders a relative external Markdown image through the approved asset base", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview
        content="![流程图](./assets/flow.png)"
        externalImageBaseDir="C:/Users/Alice/Documents/project"
      />,
    );

    expect(markup).toContain("asset://C:/Users/Alice/Documents/project/assets/flow.png");
  });
});
