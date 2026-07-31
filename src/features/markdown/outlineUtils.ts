import GithubSlugger from "github-slugger";

/**
 * 从 Markdown 文本中提取标题，生成大纲结构。
 *
 * ID 必须由与 rehype-slug 相同的 github-slugger 生成，不能维护另一套近似
 * slugify 规则，否则特殊符号或重复标题会让大纲找不到预览中的真实 DOM 节点。
 */
export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
  line: number;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*$/;

function closesFence(line: string, marker: string): boolean {
  const escaped = marker[0] === "`" ? "`" : "~";
  return new RegExp(`^\\s{0,3}${escaped}{${marker.length},}\\s*$`).test(line);
}

function normalizeHeadingText(raw: string): string {
  // CommonMark 会忽略 ATX 标题末尾由空白分隔的 closing sequence。
  return raw.replace(/[ \t]+#+[ \t]*$/, "").trim();
}

/**
 * 剥离行内标记后再 slug：rehype-slug 对渲染后的文本节点生成 id，
 * 大纲如果对原始 Markdown（如 `**重点**`）做 slug，生成的 id 与预览
 * DOM 不一致，点击大纲将无法定位。
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)([^*_]*)\1/g, "$2")
    .replace(/~~([^~]*)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|[^*])\*([^*\n]*)\*(?=$|[^*])/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]*)_(?=$|[^_])/g, "$1$2")
    .trim();
}

export function extractOutlineHeadings(content: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const slugger = new GithubSlugger();
  let openFence: string | null = null;
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    if (openFence) {
      if (closesFence(line, openFence)) {
        openFence = null;
      }
      return;
    }

    const fence = line.match(FENCE_RE)?.[1];
    if (fence) {
      openFence = fence;
      return;
    }

    const match = line.match(HEADING_RE);
    if (!match) return;
    const text = normalizeHeadingText(match[2]);
    if (!text) return;

    headings.push({
      level: match[1].length,
      text,
      id: slugger.slug(stripInlineMarkdown(text)) || `heading-${headings.length + 1}`,
      line: index + 1,
    });
  });

  return headings;
}
