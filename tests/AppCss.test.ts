import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

describe("app CSS", () => {
  test("uses HarmonyOS Sans SC as the CJK fallback for monospace UI text", () => {
    expect(css).toMatch(/--font-mono:[\s\S]*"HarmonyOS Sans SC"[\s\S]*monospace;/);
  });

  test("wraps long unbroken Markdown preview text", () => {
    expect(css).toMatch(/\.markdown-selectable\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });
});
