export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type SidePanelMode =
  | "about"
  | "settings"
  | "todos"
  | "history"
  | "backlinks"
  | "reminders"
  | "library"
  | "workspace"
  | "outline"
  | "knowledgeGraph";

export interface NoteMenuState {
  x: number;
  y: number;
  noteId: string;
}

export interface CategoryMenuState {
  x: number;
  y: number;
  category: string;
}
