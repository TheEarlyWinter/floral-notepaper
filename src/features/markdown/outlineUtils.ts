/**
 * 从 Markdown 文本中提取标题，生成大纲结构。
 */

export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
  line: number;
}

/** 生成与 rehype-slug（github-slugger）一致的 slug */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

export function extractOutlineHeadings(content: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const slugCount = new Map<string, number>();

  HEADING_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HEADING_RE.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    if (!text) continue;

    let baseSlug = slugify(text) || `heading-${headings.length + 1}`;
    const count = slugCount.get(baseSlug) ?? 0;
    if (count > 0) {
      baseSlug = `${baseSlug}-${count}`;
    }
    slugCount.set(slugify(text), count + 1);

    const beforeMatch = content.slice(0, match.index);
    const line = beforeMatch.split("\n").length;

    headings.push({ level, text, id: baseSlug, line });
  }

  return headings;
}
