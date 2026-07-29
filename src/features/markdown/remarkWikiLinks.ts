import type { Root, Text } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

const remarkWikiLinks: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent) => {
    if (index == null || !parent || !WIKI_LINK_PATTERN.test(node.value)) return;
    WIKI_LINK_PATTERN.lastIndex = 0;

    const children = [] as Array<Text | { type: "link"; url: string; children: Text[] }>;
    let cursor = 0;
    for (const match of node.value.matchAll(WIKI_LINK_PATTERN)) {
      const start = match.index ?? 0;
      if (start > cursor) children.push({ type: "text", value: node.value.slice(cursor, start) });

      const raw = match[1].trim();
      const separator = raw.indexOf("|");
      const target = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
      const label = (separator >= 0 ? raw.slice(separator + 1) : target).trim();
      if (!target || !label) {
        children.push({ type: "text", value: match[0] });
      } else {
        children.push({
          type: "link",
          url: `wiki:${encodeURIComponent(target)}`,
          children: [{ type: "text", value: label }],
        });
      }
      cursor = start + match[0].length;
    }
    if (cursor < node.value.length) children.push({ type: "text", value: node.value.slice(cursor) });

    parent.children.splice(index, 1, ...children);
    return index + children.length;
  });
};

export default remarkWikiLinks;
