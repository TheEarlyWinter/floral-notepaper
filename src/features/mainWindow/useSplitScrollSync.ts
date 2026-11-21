import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  createScrollSyncMap,
  interpolateScrollOffset,
  measureBlockOffsets,
  measurePreviewBlockOffsets,
  tagPreviewBlocks,
  type ScrollSyncMap,
} from "../markdown/scrollSync";
import type { ViewMode } from "../settings/types";

interface UseSplitScrollSyncOptions {
  contentRef: RefObject<HTMLTextAreaElement | null>;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  splitContainerRef: RefObject<HTMLDivElement | null>;
  effectiveViewMode: ViewMode;
  scrollSyncEnabled: boolean;
  deferredContent: string;
  selectedId: string | null;
  fontSize?: number;
  renderHtmlMarkdown?: boolean;
  splitRatio: number;
}

export function useSplitScrollSync({
  contentRef,
  previewScrollRef,
  splitContainerRef,
  effectiveViewMode,
  scrollSyncEnabled,
  deferredContent,
  selectedId,
  fontSize,
  renderHtmlMarkdown,
  splitRatio,
}: UseSplitScrollSyncOptions) {
  const scrollMaps = useRef<{
    editorToPreview: ScrollSyncMap;
    previewToEditor: ScrollSyncMap;
  } | null>(null);
  const scrollSource = useRef<"editor" | "preview" | null>(null);
  const scrollSyncRafRef = useRef<number>(0);
  const scrollReleaseRafRef = useRef<number>(0);
  const measureDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureRafRef = useRef<number>(0);
  const measureControllerRef = useRef<AbortController | null>(null);
  const prevSelectedIdRef = useRef(selectedId);

  const cancelScrollMeasurement = useCallback(() => {
    if (measureDebounceRef.current) clearTimeout(measureDebounceRef.current);
    cancelAnimationFrame(measureRafRef.current);
    measureControllerRef.current?.abort();
  }, []);

  const cancelScheduledScrollSync = useCallback(() => {
    cancelAnimationFrame(scrollSyncRafRef.current);
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollSyncRafRef.current = 0;
    scrollReleaseRafRef.current = 0;
    scrollSource.current = null;
  }, []);

  const scheduleScrollMeasurement = useCallback(
    (delayMs: number) => {
      if (effectiveViewMode !== "split" || !scrollSyncEnabled) return;
      if (!contentRef.current || !previewScrollRef.current) return;

      // 布局和测量稳定前先清空旧偏移量
      scrollMaps.current = null;
      cancelScrollMeasurement();

      const controller = new AbortController();
      measureControllerRef.current = controller;

      const measure = async () => {
        const textarea = contentRef.current;
        const preview = previewScrollRef.current;
        if (!textarea || !preview) return;

        // 用与预览一致的延迟内容测量，避免快速输入时测量与 DOM 错位
        const editorOffsets = await measureBlockOffsets(
          deferredContent,
          textarea,
          controller.signal,
        );
        if (controller.signal.aborted) return;

        tagPreviewBlocks(preview);
        const previewOffsets = measurePreviewBlockOffsets(preview);
        if (controller.signal.aborted) return;
        const editorMaxScroll = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
        const previewMaxScroll = Math.max(0, preview.scrollHeight - preview.clientHeight);
        scrollMaps.current = {
          editorToPreview: createScrollSyncMap(
            editorOffsets,
            previewOffsets,
            editorMaxScroll,
            previewMaxScroll,
          ),
          previewToEditor: createScrollSyncMap(
            previewOffsets,
            editorOffsets,
            previewMaxScroll,
            editorMaxScroll,
          ),
        };
      };

      const runAfterLayout = () => {
        measureRafRef.current = requestAnimationFrame(() => {
          void measure();
        });
      };

      if (delayMs > 0) {
        measureDebounceRef.current = setTimeout(runAfterLayout, delayMs);
      } else {
        runAfterLayout();
      }
    },
    [
      cancelScrollMeasurement,
      contentRef,
      deferredContent,
      effectiveViewMode,
      previewScrollRef,
      scrollSyncEnabled,
    ],
  );

  // 切换笔记时通过 rAF 测量（不阻塞首帧渲染），编辑时 debounce 避免频繁重排
  useEffect(() => {
    if (effectiveViewMode !== "split" || !scrollSyncEnabled) {
      scrollMaps.current = null;
      cancelScrollMeasurement();
      cancelScheduledScrollSync();
      return;
    }

    const isNoteSwitch = prevSelectedIdRef.current !== selectedId;
    prevSelectedIdRef.current = selectedId;
    scheduleScrollMeasurement(isNoteSwitch ? 0 : 250);

    return () => {
      cancelScrollMeasurement();
    };
  }, [
    cancelScrollMeasurement,
    cancelScheduledScrollSync,
    deferredContent,
    effectiveViewMode,
    fontSize,
    renderHtmlMarkdown,
    scheduleScrollMeasurement,
    scrollSyncEnabled,
    selectedId,
    splitRatio,
  ]);

  useEffect(() => {
    if (effectiveViewMode !== "split" || !scrollSyncEnabled) return;

    const observedElements: Element[] = [];
    if (splitContainerRef.current) observedElements.push(splitContainerRef.current);
    if (contentRef.current) observedElements.push(contentRef.current);
    const previewContainer = previewScrollRef.current;
    if (previewContainer) observedElements.push(previewContainer);
    const previewContent = previewContainer?.querySelector<HTMLElement>(".font-body");
    if (previewContent) observedElements.push(previewContent);

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => scheduleScrollMeasurement(120);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    if (observedElements.length === 0) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollMeasurement(120);
    });
    observedElements.forEach((element) => observer.observe(element));

    let mutationObserver: MutationObserver | undefined;
    if (previewContainer && !previewContent && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        const mountedPreview = previewContainer.querySelector<HTMLElement>(".font-body");
        if (!mountedPreview) return;
        observer.observe(mountedPreview);
        mutationObserver?.disconnect();
        scheduleScrollMeasurement(0);
      });
      mutationObserver.observe(previewContainer, { childList: true });
    }

    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [
    contentRef,
    effectiveViewMode,
    previewScrollRef,
    scheduleScrollMeasurement,
    scrollSyncEnabled,
    splitContainerRef,
  ]);

  // Reset preview scroll on note switch
  useEffect(() => {
    cancelScheduledScrollSync();
    if (previewScrollRef.current) {
      previewScrollRef.current.scrollTop = 0;
    }
  }, [cancelScheduledScrollSync, previewScrollRef, selectedId]);

  const releaseScrollSourceAfterPaint = useCallback((source: "editor" | "preview") => {
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollReleaseRafRef.current = requestAnimationFrame(() => {
      scrollReleaseRafRef.current = requestAnimationFrame(() => {
        if (scrollSource.current === source) scrollSource.current = null;
        scrollReleaseRafRef.current = 0;
      });
    });
  }, []);

  const scheduleSyncedScroll = useCallback(
    (source: "editor" | "preview") => {
      if (scrollSyncRafRef.current) return;
      scrollSyncRafRef.current = requestAnimationFrame(() => {
        scrollSyncRafRef.current = 0;
        const textarea = contentRef.current;
        const preview = previewScrollRef.current;
        const maps = scrollMaps.current;
        if (!textarea || !preview || !maps || scrollSource.current !== source) return;

        if (source === "editor") {
          preview.scrollTop = interpolateScrollOffset(maps.editorToPreview, textarea.scrollTop);
        } else {
          textarea.scrollTop = interpolateScrollOffset(maps.previewToEditor, preview.scrollTop);
        }
        releaseScrollSourceAfterPaint(source);
      });
    },
    [contentRef, previewScrollRef, releaseScrollSourceAfterPaint],
  );

  const handleEditorScroll = useCallback(() => {
    if (effectiveViewMode !== "split" || !scrollSyncEnabled || !scrollMaps.current) return;
    if (scrollSource.current === "preview") return;

    scrollSource.current = "editor";
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollReleaseRafRef.current = 0;
    scheduleSyncedScroll("editor");
  }, [effectiveViewMode, scheduleSyncedScroll, scrollSyncEnabled]);

  const handlePreviewScroll = useCallback(() => {
    if (effectiveViewMode !== "split" || !scrollSyncEnabled || !scrollMaps.current) return;
    if (scrollSource.current === "editor") return;

    scrollSource.current = "preview";
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollReleaseRafRef.current = 0;
    scheduleSyncedScroll("preview");
  }, [effectiveViewMode, scheduleSyncedScroll, scrollSyncEnabled]);

  useEffect(() => cancelScheduledScrollSync, [cancelScheduledScrollSync]);

  return { handleEditorScroll, handlePreviewScroll };
}
