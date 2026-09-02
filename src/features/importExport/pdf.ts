import { invoke } from "@tauri-apps/api/core";

export interface PdfExportOptions {
  path: string;
  title: string;
  markdown: string;
  fontSize?: number;
  renderHtml?: boolean;
  imageBaseDir?: string;
  externalImageBaseDir?: string;
  externalFilePath?: string;
}

let exportInProgress = false;

export function pdfFileName(title: string): string {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return `${safeTitle || "未命名"}.pdf`;
}

/** Low-level native PrintToPdf call. Only the hidden PDF WebView may invoke it. */
export function exportPreparedPdf(path: string): Promise<void> {
  return invoke("export_pdf", { path });
}

/** Submit a one-shot hidden-WebView PDF export task. */
export async function exportMarkdownPdf(options: PdfExportOptions): Promise<void> {
  if (exportInProgress) throw new Error("PDF 正在导出，请稍候");
  exportInProgress = true;

  try {
    await invoke("start_pdf_export", { request: options });
  } finally {
    exportInProgress = false;
  }
}
