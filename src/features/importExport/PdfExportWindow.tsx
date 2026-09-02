import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownPreview } from "../markdown/MarkdownPreview";
import type { PdfExportOptions } from "./pdf";
import "../../App.css";
import "katex/dist/katex.min.css";

const PDF_STYLE = `
  :root {
    color-scheme: light !important;
    --color-paper: #ffffff;
    --color-paper-warm: #f3f3f0;
    --color-paper-deep: #d8d8d2;
    --color-ink: #11110f;
    --color-ink-soft: #242421;
    --color-ink-faint: #4f4f49;
    --color-ink-ghost: #696963;
    --color-bamboo: #235438;
    --color-bamboo-light: #2d6745;
    --color-bamboo-mist: #e8f0eb;
    --color-bamboo-glow: #d4e8da;
    --color-stone: #5d5d57;
    --color-cloud: #ffffff;
    --code-bg: #f3f3f0;
    --code-text: #20201d;
    --code-border: #d8d8d2;
    --editor-font-family: "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif;
    --editor-line-height: 1.75;
    --pdf-font-size: 14px;
  }

  html, body, #root {
    width: auto !important;
    min-width: 0 !important;
    height: auto !important;
    min-height: 100%;
    margin: 0 !important;
    overflow: visible !important;
    background: #fff !important;
    color: #20201d !important;
  }

  body {
    user-select: text !important;
    -webkit-user-select: text !important;
    font-family: "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif !important;
    -webkit-font-smoothing: auto;
    text-rendering: optimizeLegibility;
  }

  #root {
    box-sizing: border-box;
    width: 210mm !important;
    min-height: 297mm;
    padding: 16mm;
    background: #fff !important;
  }

  .floral-pdf-document,
  .floral-pdf-document .markdown-selectable {
    box-sizing: border-box;
    width: auto !important;
    max-width: none !important;
    margin: 0 !important;
    color: #11110f !important;
    font-size: var(--pdf-font-size) !important;
    font-weight: 400 !important;
    opacity: 1 !important;
    filter: none !important;
    text-shadow: none !important;
    line-height: 1.75 !important;
  }

  .floral-pdf-document .markdown-selectable,
  .floral-pdf-document .markdown-selectable * {
    color: #11110f !important;
    opacity: 1 !important;
    filter: none !important;
    text-shadow: none !important;
  }

  .floral-pdf-document .markdown-selectable a,
  .floral-pdf-document .markdown-selectable em,
  .floral-pdf-document .markdown-alert-title {
    color: #235438 !important;
  }

  .floral-pdf-title {
    margin: 0 0 10mm !important;
    color: #050504 !important;
    font-family: "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif !important;
    font-size: calc(var(--pdf-font-size) * 1.57) !important;
    font-weight: 700 !important;
    line-height: 1.25 !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
  }

  .floral-pdf-document .markdown-selectable h1,
  .floral-pdf-document .markdown-selectable h2,
  .floral-pdf-document .markdown-selectable h3,
  .floral-pdf-document .markdown-selectable h4,
  .floral-pdf-document .markdown-selectable strong,
  .floral-pdf-document .markdown-selectable th {
    color: #050504 !important;
  }

  .floral-pdf-document .markdown-selectable pre,
  .floral-pdf-document .markdown-selectable th {
    background: #f3f3f0 !important;
  }

  .floral-pdf-document .markdown-selectable pre {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
  }

  .floral-pdf-document .markdown-selectable table {
    width: 100% !important;
  }

  .floral-pdf-document .markdown-selectable img {
    max-width: 100% !important;
    height: auto !important;
  }

  .floral-pdf-document button {
    display: none !important;
  }

  @page { size: A4 portrait; margin: 0; }
  @media print {
    .floral-pdf-document pre,
    .floral-pdf-document blockquote,
    .floral-pdf-document table,
    .floral-pdf-document img,
    .floral-pdf-document .markdown-alert {
      break-inside: avoid-page;
    }
  }
`;

interface PdfExportWindowProps {
  jobId: string;
}

function nextFrame(): Promise<void> {
  // Hidden WebView2 surfaces may throttle requestAnimationFrame; a timer keeps
  // readiness checks progressing while the window remains invisible.
  return new Promise((resolve) => window.setTimeout(resolve, 16));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForImages(root: HTMLElement): Promise<void> {
  // External Markdown images resolve through an IPC cache call after the first React commit.
  // Wait for that placeholder to settle before taking the image snapshot.
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (!root.querySelector(".markdown-image-loading")) break;
    await wait(50);
  }

  const images = Array.from(root.querySelectorAll("img"));
  for (const image of images) image.loading = "eager";
  await Promise.race([
    Promise.all(
      images.map(async (image) => {
        if (!image.complete) {
          await new Promise<void>((resolve) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          });
        }
        if (typeof image.decode === "function") {
          await image.decode().catch(() => undefined);
        }
      }),
    ),
    wait(8_000),
  ]);
}

async function waitForDocument(root: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (root.querySelector(".markdown-selectable")) return;
    await nextFrame();
  }
  throw new Error("PDF 文档渲染超时");
}

export function PdfExportWindow({ jobId }: PdfExportWindowProps) {
  const [request, setRequest] = useState<PdfExportOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<PdfExportOptions>("take_pdf_export", { jobId })
      .then((value) => {
        if (!cancelled) setRequest(value);
      })
      .catch((reason) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        void invoke("finish_pdf_export", {
          jobId,
          success: false,
          error: message,
        }).catch(() => undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const root = document.getElementById("root");
    if (!root) return;

    const style = document.createElement("style");
    style.id = "floral-pdf-window-style";
    style.textContent = PDF_STYLE;
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.removeAttribute("data-preset-theme");
    document.documentElement.setAttribute("data-code-theme", "light");
    const requestedFontSize = Number(request.fontSize);
    const fontSize = Number.isFinite(requestedFontSize)
      ? Math.min(Math.max(requestedFontSize, 10), 32)
      : 14;
    document.documentElement.style.setProperty("--pdf-font-size", `${fontSize}px`);
    document.head.appendChild(style);
    document.title = request.title || "未命名";

    void (async () => {
      try {
        await waitForDocument(root);
        await document.fonts?.ready;
        await waitForImages(root);
        await nextFrame();
        await nextFrame();
        if (cancelled) return;
        await invoke("export_pdf", { path: request.path });
        await invoke("finish_pdf_export", { jobId, success: true, error: null });
      } catch (reason) {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        await invoke("finish_pdf_export", { jobId, success: false, error: message }).catch(
          () => undefined,
        );
      }
    })();

    return () => {
      cancelled = true;
      style.remove();
    };
  }, [jobId, request]);

  if (error) {
    return <div className="floral-pdf-document">{error}</div>;
  }
  if (!request) return null;

  return (
    <main className="floral-pdf-document">
      <h1 className="floral-pdf-title">{request.title || "未命名"}</h1>
      <MarkdownPreview
        content={request.markdown}
        fontSize={request.fontSize}
        renderHtml={request.renderHtml}
        imageBaseDir={request.imageBaseDir}
        externalImageBaseDir={request.externalImageBaseDir}
        externalFilePath={request.externalFilePath}
      />
    </main>
  );
}
