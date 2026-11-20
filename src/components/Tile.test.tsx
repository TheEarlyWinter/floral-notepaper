import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { MarkdownPreview } from "../features/markdown/MarkdownPreview";
import { Tile } from "./Tile";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("../features/markdown/MarkdownPreviewLazy", () => ({
  MarkdownPreviewLazy: MarkdownPreview,
}));

describe("Tile", () => {
  test("passes onContentChange through to MarkdownPreview for interactive tile task lists", () => {
    const markdown = "- [ ] Tile task\n- [x] Finished";

    const editableMarkup = renderToStaticMarkup(
      <Tile content={markdown} renderMarkdown onContentChange={vi.fn()} />,
    );
    const editableInputs = editableMarkup.match(/<input[^>]*>/g) ?? [];
    expect(editableInputs).toHaveLength(2);
    expect(editableInputs[0]).not.toContain("disabled");
    expect(editableInputs[0]).toContain('aria-label="Tile task"');
    expect(editableInputs[1]).not.toContain("disabled");
    expect(editableInputs[1]).toContain('checked=""');

    const readOnlyMarkup = renderToStaticMarkup(<Tile content={markdown} renderMarkdown />);
    const readOnlyInputs = readOnlyMarkup.match(/<input[^>]*>/g) ?? [];
    expect(readOnlyInputs).toHaveLength(2);
    expect(readOnlyInputs[0]).toContain('disabled=""');
    expect(readOnlyInputs[1]).toContain('disabled=""');
  });

  test("still auto-enables Markdown rendering when content contains images", () => {
    const markup = renderToStaticMarkup(
      <Tile content="![diagram](images/diagram.png)" renderMarkdown={false} />,
    );

    expect(markup).toContain("markdown-selectable");
  });
});
