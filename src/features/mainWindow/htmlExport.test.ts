import { describe, expect, test } from "vitest";
import { escapeHtml, wrapHtml } from "./htmlExport";

describe("htmlExport", () => {
  test("escapes HTML special characters in title and body", () => {
    expect(escapeHtml(`<script>"alert('xss')" &</script>`)).toBe(
      "&lt;script&gt;&quot;alert(&#39;xss&#39;)&quot; &amp;&lt;/script&gt;",
    );
  });

  test("wraps markdown content into standalone HTML document", () => {
    const html = wrapHtml("标题 <1>", "# Hello & World");
    expect(html).toContain("<title>标题 &lt;1&gt;</title>");
    expect(html).toContain("# Hello &amp; World</pre>");
    expect(html).toContain("<!DOCTYPE html>");
  });
});
