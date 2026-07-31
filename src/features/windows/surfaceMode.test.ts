import { describe, expect, test } from "vitest";
import {
  NOTE_SURFACE_MODE_EVENT,
  SURFACE_WINDOW_MIN_SIZES,
  SURFACE_WINDOW_SIZES,
  getSurfaceTargetBounds,
  getSurfaceWindowLayer,
  isNoteSurfaceMode,
} from "./surfaceMode";

describe("surface mode helpers", () => {
  test("keeps surface modes explicit", () => {
    expect(isNoteSurfaceMode("pad")).toBe(true);
    expect(isNoteSurfaceMode("tile")).toBe(true);
    expect(isNoteSurfaceMode("main")).toBe(false);
    expect(NOTE_SURFACE_MODE_EVENT).toBe("floral-notepaper:surface-mode");
  });

  test("keeps default sizes while allowing compact tiles", () => {
    expect(SURFACE_WINDOW_SIZES.pad).toEqual({ width: 260, height: 260 });
    expect(SURFACE_WINDOW_SIZES.tile).toEqual({ width: 260, height: 260 });
    expect(SURFACE_WINDOW_MIN_SIZES.pad).toEqual({ width: 220, height: 220 });
    expect(SURFACE_WINDOW_MIN_SIZES.tile).toEqual({ width: 140, height: 96 });
  });

  test("expands a compact tile before returning to the editor", () => {
    const current = {
      x: 100,
      y: 80,
      width: 160,
      height: 120,
    };

    expect(getSurfaceTargetBounds("tile", current)).toEqual(current);
    expect(getSurfaceTargetBounds("pad", current)).toEqual({
      x: 100,
      y: 80,
      width: 220,
      height: 220,
    });
  });

  test("uses the window scale factor when enforcing a minimum size", () => {
    expect(getSurfaceTargetBounds("pad", { x: 0, y: 0, width: 200, height: 200 }, 1.5)).toEqual({
      x: 0,
      y: 0,
      width: 330,
      height: 330,
    });
  });

  test("keeps desktop-only tiles below normal windows", () => {
    expect(getSurfaceWindowLayer("tile", true)).toBe("desktop");
    expect(getSurfaceWindowLayer("tile", false)).toBe("alwaysOnTop");
    expect(getSurfaceWindowLayer("pad", true)).toBe("alwaysOnTop");
  });
});
