import type { NoteTemplate } from "../settings/types";

export const BUILT_IN_TEMPLATES: NoteTemplate[] = [
  { id: "daily", name: "今日计划", content: "# {{date}}\n\n## 待办\n- [ ] \n\n## 随手记\n" },
  {
    id: "reading",
    name: "阅读笔记",
    content: "# 书名 / 文章\n\n## 摘录\n\n## 想法\n\n## 行动\n- [ ] ",
  },
  {
    id: "meeting",
    name: "会议记录",
    content: "# 会议主题\n\n时间：{{date}}\n\n## 结论\n\n## 待办\n- [ ] ",
  },
];

export function renderTemplateContent(content: string): string {
  const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
  return content.replace(/\{\{date\}\}/g, date);
}
