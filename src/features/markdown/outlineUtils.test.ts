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
});
