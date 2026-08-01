import { describe, expect, test } from "vitest";
import { canRenderRawHtml } from "./renderPolicy";

describe("canRenderRawHtml", () => {
  test("allows explicitly enabled raw HTML for managed notes", () => {
    expect(canRenderRawHtml(false, true)).toBe(true);
  });

  test("never enables raw HTML for externally opened files", () => {
    expect(canRenderRawHtml(true, true)).toBe(false);
    expect(canRenderRawHtml(true, false)).toBe(false);
  });
});
