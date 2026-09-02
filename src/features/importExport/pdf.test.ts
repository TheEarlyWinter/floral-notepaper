import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { exportMarkdownPdf, exportPreparedPdf, pdfFileName } from "./pdf";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PDF export", () => {
  test("submits the complete PDF request to the hidden export window", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const request = {
      path: "C:\\Users\\tester\\note.pdf",
      title: "测试笔记",
      markdown: "# 内容",
      fontSize: 14,
      renderHtml: false,
    };

    await exportMarkdownPdf(request);

    expect(mockedInvoke).toHaveBeenCalledWith("start_pdf_export", { request });
  });

  test("invokes the native direct-to-file PDF command", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await exportPreparedPdf("C:\\Users\\tester\\note.pdf");

    expect(mockedInvoke).toHaveBeenCalledWith("export_pdf", {
      path: "C:\\Users\\tester\\note.pdf",
    });
  });

  test("sanitizes invalid Windows filename characters", () => {
    expect(pdfFileName('会议: "第一版"?')).toBe("会议_ _第一版__.pdf");
    expect(pdfFileName("... ")).toBe("未命名.pdf");
  });
});
