import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { DEFAULT_SIDEBAR_ACTION_ORDER, type SidebarActionId } from "../settings/sidebarOrder";

export type SidebarSortKind = "action" | "category";
export type SidebarPointerDragKind = SidebarSortKind | "note";

export interface SidebarPointerDragState {
  kind: SidebarSortKind;
  sourceId: string;
  targetId: string | null;
}

interface SidebarPointerDrag {
  kind: SidebarPointerDragKind;
  sourceId: string;
  sourceCategory?: string;
  targetId: string | null;
  pointerId: number;
  startX: number;
  startY: number;
  isDragging: boolean;
}

interface SidebarPointerDropTarget {
  kind: SidebarSortKind;
  id: string;
}

const SIDEBAR_POINTER_DRAG_THRESHOLD = 6;
const SIDEBAR_POINTER_SCROLL_EDGE = 40;
const SIDEBAR_POINTER_SCROLL_SPEED = 12;

function isSidebarActionId(value: string): value is SidebarActionId {
  return (DEFAULT_SIDEBAR_ACTION_ORDER as readonly string[]).includes(value);
}

function getSidebarSortTarget(clientX: number, clientY: number): SidebarPointerDropTarget | null {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-sidebar-sort-kind][data-sidebar-sort-id]");
  const kind = element?.dataset.sidebarSortKind;
  const id = element?.dataset.sidebarSortId;
  if ((kind !== "action" && kind !== "category") || !id) return null;
  return { kind, id };
}

function getSidebarNoteDropTarget(clientX: number, clientY: number): string | null {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-sidebar-note-drop-category]");
  return element?.dataset.sidebarNoteDropCategory ?? null;
}

interface UseSidebarPointerDragOptions {
  onReorderAction: (source: SidebarActionId, target: SidebarActionId) => void;
  onReorderCategory: (source: string, target: string) => void;
  onMoveNote: (noteId: string, targetCategory: string) => void;
}

export function useSidebarPointerDrag({
  onReorderAction,
  onReorderCategory,
  onMoveNote,
}: UseSidebarPointerDragOptions) {
  const sidebarPointerDragRef = useRef<SidebarPointerDrag | null>(null);
  const [activeSidebarPointerDrag, setActiveSidebarPointerDrag] =
    useState<SidebarPointerDragState | null>(null);
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const sidebarAutoScrollFrameRef = useRef<number | null>(null);
  const sidebarAutoScrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const suppressNextSidebarClickRef = useRef(false);

  const onReorderActionRef = useRef(onReorderAction);
  onReorderActionRef.current = onReorderAction;
  const onReorderCategoryRef = useRef(onReorderCategory);
  onReorderCategoryRef.current = onReorderCategory;
  const onMoveNoteRef = useRef(onMoveNote);
  onMoveNoteRef.current = onMoveNote;

  const suppressNextSidebarClick = useCallback(() => {
    suppressNextSidebarClickRef.current = true;
    window.setTimeout(() => {
      suppressNextSidebarClickRef.current = false;
    }, 0);
  }, []);

  const consumeSidebarPointerClick = useCallback(() => {
    if (!suppressNextSidebarClickRef.current) return false;
    suppressNextSidebarClickRef.current = false;
    return true;
  }, []);

  const beginSidebarPointerDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, kind: SidebarSortKind, sourceId: string) => {
      if (event.button !== 0 || !event.isPrimary) return;
      if (kind === "category" && (event.target as Element).closest("button, input, select")) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      sidebarPointerDragRef.current = {
        kind,
        sourceId,
        targetId: null,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        isDragging: false,
      };
    },
    [],
  );

  // Windows native file drops can suppress DOM HTML5 DnD, so note relocation shares the Pointer path.
  const beginSidebarNotePointerDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, noteId: string, sourceCategory: string) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      sidebarPointerDragRef.current = {
        kind: "note",
        sourceId: noteId,
        sourceCategory,
        targetId: null,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        isDragging: false,
      };
    },
    [],
  );

  const sidebarActionDragClass = useCallback(
    (action: SidebarActionId) => {
      if (activeSidebarPointerDrag?.kind !== "action") return "";
      if (activeSidebarPointerDrag.sourceId === action) return "opacity-50";
      return activeSidebarPointerDrag.targetId === action
        ? "bg-bamboo/15 ring-1 ring-bamboo/20"
        : "";
    },
    [activeSidebarPointerDrag],
  );

  useEffect(() => {
    const stopSidebarAutoScroll = () => {
      sidebarAutoScrollDirectionRef.current = 0;
      if (sidebarAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarAutoScrollFrameRef.current);
        sidebarAutoScrollFrameRef.current = null;
      }
    };

    const startSidebarAutoScroll = () => {
      if (sidebarAutoScrollFrameRef.current !== null) return;
      const tick = () => {
        const scrollContainer = sidebarScrollRef.current;
        const direction = sidebarAutoScrollDirectionRef.current;
        if (!scrollContainer || direction === 0) {
          sidebarAutoScrollFrameRef.current = null;
          return;
        }
        scrollContainer.scrollTop += direction * SIDEBAR_POINTER_SCROLL_SPEED;
        sidebarAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
      };
      sidebarAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };

    const updateSidebarAutoScroll = (event: PointerEvent) => {
      const scrollContainer = sidebarScrollRef.current;
      if (!scrollContainer) return;
      const { top, bottom } = scrollContainer.getBoundingClientRect();
      const nextDirection: -1 | 0 | 1 =
        event.clientY < top + SIDEBAR_POINTER_SCROLL_EDGE
          ? -1
          : event.clientY > bottom - SIDEBAR_POINTER_SCROLL_EDGE
            ? 1
            : 0;
      if (nextDirection === sidebarAutoScrollDirectionRef.current) return;
      sidebarAutoScrollDirectionRef.current = nextDirection;
      if (nextDirection === 0) stopSidebarAutoScroll();
      else startSidebarAutoScroll();
    };

    const cancelPointerDrag = () => {
      sidebarPointerDragRef.current = null;
      setActiveSidebarPointerDrag(null);
      setDragOverCategory(null);
      stopSidebarAutoScroll();
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = sidebarPointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if ((event.buttons & 1) === 0) {
        cancelPointerDrag();
        return;
      }

      if (!drag.isDragging) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance < SIDEBAR_POINTER_DRAG_THRESHOLD) return;
        drag.isDragging = true;
      }

      updateSidebarAutoScroll(event);
      if (drag.kind === "note") {
        const targetCategory = getSidebarNoteDropTarget(event.clientX, event.clientY);
        if (targetCategory === drag.targetId) {
          event.preventDefault();
          return;
        }
        drag.targetId = targetCategory;
        setDragOverCategory(targetCategory);
        event.preventDefault();
        return;
      }

      const target = getSidebarSortTarget(event.clientX, event.clientY);
      const targetId = target?.kind === drag.kind ? target.id : null;
      if (targetId === drag.targetId) {
        event.preventDefault();
        return;
      }
      drag.targetId = targetId;
      setActiveSidebarPointerDrag({
        kind: drag.kind,
        sourceId: drag.sourceId,
        targetId,
      });
      event.preventDefault();
    };

    const finishPointerDrag = (event: PointerEvent, cancelled = false) => {
      const drag = sidebarPointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      sidebarPointerDragRef.current = null;
      setActiveSidebarPointerDrag(null);
      setDragOverCategory(null);
      stopSidebarAutoScroll();
      if (!drag.isDragging) return;

      event.preventDefault();
      suppressNextSidebarClick();
      if (cancelled) return;

      if (drag.kind === "note") {
        const targetCategory = getSidebarNoteDropTarget(event.clientX, event.clientY);
        if (targetCategory !== null && targetCategory !== drag.sourceCategory) {
          onMoveNoteRef.current(drag.sourceId, targetCategory);
        }
        return;
      }

      const target = getSidebarSortTarget(event.clientX, event.clientY);
      if (!target || target.kind !== drag.kind || target.id === drag.sourceId) return;
      if (
        drag.kind === "action" &&
        isSidebarActionId(drag.sourceId) &&
        isSidebarActionId(target.id)
      ) {
        onReorderActionRef.current(drag.sourceId, target.id);
      } else if (drag.kind === "category") {
        onReorderCategoryRef.current(drag.sourceId, target.id);
      }
    };

    const onPointerCancel = (event: PointerEvent) => finishPointerDrag(event, true);
    const onWindowBlur = () => cancelPointerDrag();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancelPointerDrag();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finishPointerDrag, { passive: false });
    window.addEventListener("pointercancel", onPointerCancel, { passive: false });
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopSidebarAutoScroll();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [suppressNextSidebarClick]);

  return {
    sidebarScrollRef,
    activeSidebarPointerDrag,
    dragOverCategory,
    consumeSidebarPointerClick,
    beginSidebarPointerDrag,
    beginSidebarNotePointerDrag,
    sidebarActionDragClass,
  };
}
