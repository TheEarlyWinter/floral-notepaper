import type { Element, Root } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, test } from "vitest";
import rehypeTaskLists from "./rehypeTaskLists";

function collectTaskInputs(markdown: string, withHtml = false): Element[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, {
    allowDangerousHtml: withHtml,
  });

  if (withHtml) {
    processor.use(rehypeRaw).use(rehypeSanitize, defaultSchema);
  }
  processor.use(rehypeTaskLists);

  const tree = processor.runSync(processor.parse(markdown), { value: markdown }) as Root;
  const inputs: Element[] = [];
  visit(tree, "element", (node) => {
    if (node.tagName === "input") {
      inputs.push(node);
    }
  });
  return inputs;
}

describe("rehypeTaskLists", () => {
  test("records exact source character offsets and labels for GFM task items", () => {
    const markdown = [
      "- [ ] First task",
      "* [x] Second task",
      "+ [X] Third task",
      "1. [ ] Ordered task",
      "2) [x] Paren ordered task",
    ].join("\n");

    const inputs = collectTaskInputs(markdown);
    expect(inputs).toHaveLength(5);

    expect(inputs.map((input) => input.properties.dataTaskOffset)).toEqual([3, 20, 38, 56, 76]);
    expect(inputs.map((input) => markdown[input.properties.dataTaskOffset as number])).toEqual([
      " ",
      "x",
      "X",
      " ",
      "x",
    ]);
    expect(inputs.map((input) => input.properties.dataTaskLabel)).toEqual([
      "First task",
      "Second task",
      "Third task",
      "Ordered task",
      "Paren ordered task",
    ]);
  });

  test("handles nested tasks, loose lists, blockquotes, and CRLF line endings", () => {
    const markdown = [
      "- [ ] Parent task",
      "  - [x] Nested task",
      "",
      "- [ ] Loose item",
      "",
      "  Extra paragraph",
      "",
      "> - [X] Quoted task",
    ].join("\r\n");

    const inputs = collectTaskInputs(markdown);
    expect(inputs).toHaveLength(4);

    for (const input of inputs) {
      const offset = input.properties.dataTaskOffset;
      expect(typeof offset).toBe("number");
      expect(markdown[offset as number]).toMatch(/^[ xX]$/);
    }
    expect(inputs.map((input) => input.properties.dataTaskLabel)).toEqual([
      "Parent task",
      "Nested task",
      "Loose item",
      "Quoted task",
    ]);
  });

  test("ignores fenced code blocks and never marks raw HTML inputs as interactive", () => {
    const markdown = [
      "```markdown",
      "- [ ] Inside code fence",
      "```",
      "",
      '<li class="task-list-item"><input type="checkbox" data-task-offset="0"> Forged</li>',
      "",
      '- [ ] Real task <input type="checkbox" data-task-offset="99">',
    ].join("\n");

    const inputs = collectTaskInputs(markdown, true);
    expect(inputs).toHaveLength(3);

    // Forged raw HTML checkbox before the real GFM item stays unmarked
    expect(inputs[0].properties.dataTaskOffset).toBeUndefined();
    expect(inputs[0].properties.dataTaskLabel).toBeUndefined();

    // Real GFM task checkbox receives a valid numeric offset
    expect(typeof inputs[1].properties.dataTaskOffset).toBe("number");
    expect(markdown[inputs[1].properties.dataTaskOffset as number]).toBe(" ");

    // Trailing raw HTML checkbox inside the real task item stays unmarked
    expect(inputs[2].properties.dataTaskOffset).toBeUndefined();
  });
});
