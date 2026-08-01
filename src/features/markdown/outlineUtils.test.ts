import { describe, expect, test } from "vitest";
import { extractOutlineHeadings } from "./outlineUtils";

describe("extractOutlineHeadings", () => {
  test("uses the same github-slugger IDs as rehype-slug for punctuation and duplicates", () => {
    const headings = extractOutlineHeadings("# 标题 & 测试\n\n## 重复\n\n## 重复");

    expect(headings.map((heading) => heading.id)).toEqual(["标题--测试", "重复", "重复-1"]);
  });

  test("does not turn fenced code comments into outline headings", () => {
    const headings = extractOutlineHeadings(
      "# 真标题\n\n```md\n# 代码里的假标题\n```\n\n## 第二节",
    );

    expect(headings.map((heading) => heading.text)).toEqual(["真标题", "第二节"]);
    expect(headings.map((heading) => heading.line)).toEqual([1, 7]);
  });

  test("strips ATX closing hashes before producing title and slug", () => {
    const headings = extractOutlineHeadings("### 收尾标题 ###");

    expect(headings).toEqual([{ level: 3, text: "收尾标题", id: "收尾标题", line: 1 }]);
  });

  test("strips inline HTML and decodes entities so slugs match the rendered preview", () => {
    const headings = extractOutlineHeadings(
      "# <span>标题</span> &amp; 测试\n\n## 实体 &lt;b&gt; 内容",
    );

    expect(headings.map((heading) => heading.id)).toEqual(["标题--测试", "实体-b-内容"]);
  });

  test("strips highlight and inline math markers like the preview renderer does", () => {
    const headings = extractOutlineHeadings("# ==高亮== 文字\n\n## 公式 $E=mc^2$");

    expect(headings.map((heading) => heading.id)).toEqual(["高亮-文字", "公式-emc2"]);
  });
});
