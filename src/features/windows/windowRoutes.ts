export type AppView = "main" | "notepad" | "tile" | "pdf-export";

export interface AppRoute {
  view: AppView;
  noteId?: string;
  jobId?: string;
}

export function getInitialRoute(url: URL = new URL(window.location.href)): AppRoute {
  return routeFromSearch(url.search);
}

export function routeFromSearch(search: string): AppRoute {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const noteId = params.get("noteId") ?? undefined;

  if (view === "notepad") return noteId ? { view, noteId } : { view };
  if (view === "tile") return noteId ? { view, noteId } : { view };
  if (view === "pdf-export") {
    const jobId = params.get("jobId") ?? undefined;
    return jobId ? { view, jobId } : { view: "main" };
  }
  return { view: "main" };
}

export function buildNotepadUrl(noteId?: string): string {
  return buildUrl("notepad", noteId);
}

export function buildTileUrl(noteId: string): string {
  return buildUrl("tile", noteId);
}

function buildUrl(view: AppView, noteId?: string): string {
  const params = new URLSearchParams({ view });
  if (noteId) params.set("noteId", noteId);
  return `index.html?${params.toString()}`;
}
