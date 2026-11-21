/** 转义 HTML 特殊字符，防止导出内容破坏文档结构 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 将 Markdown 内容包装为完整 HTML 页面 */
export function wrapHtml(title: string, markdown: string): string {
  const escapedTitle = escapeHtml(title);
  const escaped = escapeHtml(markdown);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapedTitle}</title>
<style>
  body { max-width: 800px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, BlinkMacSystemFont, "HarmonyOS Sans SC", "PingFang SC", sans-serif; font-size: 16px; line-height: 1.8; color: #2a2a26; background: #f6f3ec; }
  pre { background: #f0ebe0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 14px; }
  code { background: #f0ebe0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre code { padding: 0; background: none; }
  blockquote { border-left: 3px solid #8a8a80; margin: 0; padding: 4px 16px; color: #5a5a52; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d0c8; padding: 8px 12px; text-align: left; }
  h1, h2, h3 { margin-top: 1.5em; margin-bottom: 0.5em; }
  img { max-width: 100%; }
  @media print { body { background: white; color: black; } }
</style>
</head>
<body>
<pre style="white-space: pre-wrap; font-family: inherit; background: none; padding: 0;">${escaped}</pre>
</body>
</html>`;
}
