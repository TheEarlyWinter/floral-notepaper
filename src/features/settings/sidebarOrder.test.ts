import { describe, expect, test } from "vitest";
import { moveOrderItem, normalizeOrder } from "./sidebarOrder";

describe("sidebar order", () => {
  test("normalizes stale, duplicated, and missing entries", () => {
    expect(
      normalizeOrder(["journal", "unknown", "journal"], ["daily", "inbox", "journal"]),
    ).toEqual(["journal", "daily", "inbox"]);
  });

  test("moves an item before the drop target without mutating the source", () => {
    const source = ["daily", "inbox", "journal"];
    expect(moveOrderItem(source, "journal", "daily")).toEqual(["journal", "daily", "inbox"]);
    expect(source).toEqual(["daily", "inbox", "journal"]);
  });

  test("moves an earlier item before a later target", () => {
    expect(moveOrderItem(["daily", "inbox", "journal"], "daily", "journal")).toEqual([
      "inbox",
      "daily",
      "journal",
    ]);
  });

  test("keeps order unchanged when an item is dropped onto itself", () => {
    expect(moveOrderItem(["daily", "inbox"], "daily", "daily")).toEqual(["daily", "inbox"]);
  });
});
