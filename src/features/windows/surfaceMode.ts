import type { WindowBounds } from "./api";

export type NoteSurfaceMode = "pad" | "tile";

export const NOTE_SURFACE_MODE_EVENT = "floral-notepaper:surface-mode";

export const SURFACE_WINDOW_SIZES: Record<
  NoteSurfaceMode,
  Pick<WindowBounds, "width" | "height">
> = {
  pad: { width: 260, height: 260 },
  tile: { width: 260, height: 260 },
};

/** Logical-pixel minimums. Tiles can stay compact; the editor always has room for controls. */
export const SURFACE_WINDOW_MIN_SIZES: Record<
  NoteSurfaceMode,
  Pick<WindowBounds, "width" | "height">
> = {
  pad: { width: 220, height: 220 },
  tile: { width: 140, height: 96 },
};

export type SurfaceWindowLayer = "alwaysOnTop" | "desktop";

export function getSurfaceWindowLayer(
  mode: NoteSurfaceMode,
  tileDesktopOnly: boolean,
): SurfaceWindowLayer {
  return mode === "tile" && tileDesktopOnly ? "desktop" : "alwaysOnTop";
}

export function isNoteSurfaceMode(value: unknown): value is NoteSurfaceMode {
  return value === "pad" || value === "tile";
}

export function getSurfaceTargetBounds(
  mode: NoteSurfaceMode,
  current: WindowBounds,
  scaleFactor = 1,
): WindowBounds {
  const minimum = SURFACE_WINDOW_MIN_SIZES[mode];
  return {
    ...current,
    width: Math.max(current.width, Math.ceil(minimum.width * scaleFactor)),
    height: Math.max(current.height, Math.ceil(minimum.height * scaleFactor)),
  };
}

export function requestSurfaceMode(mode: NoteSurfaceMode): void {
  window.dispatchEvent(new CustomEvent(NOTE_SURFACE_MODE_EVENT, { detail: { mode } }));
}

export function surfaceModeFromEvent(event: Event): NoteSurfaceMode | null {
  if (!(event instanceof CustomEvent)) return null;
  const mode = (event.detail as { mode?: unknown } | null)?.mode;
  return isNoteSurfaceMode(mode) ? mode : null;
}
