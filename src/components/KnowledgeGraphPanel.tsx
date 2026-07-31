import { useEffect, useMemo, useRef, useState } from "react";
import { Network } from "vis-network/standalone";
import { DataSet } from "vis-data/standalone";
import type { Note, NoteMetadata } from "../features/notes/types";
import { extractWikiLinks, resolveWikiLink } from "../features/notes/wikiLinks";
import { getNote } from "../features/notes/api";
import type { Edge, Node } from "vis-network/standalone";

interface KnowledgeGraphPanelProps {
  notes: NoteMetadata[];
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
}

const CATEGORY_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  "": { bg: "#E8E4DF", border: "#C4BFB6", text: "#5C5650" },
  default: { bg: "#E8E4DF", border: "#C4BFB6", text: "#5C5650" },
};

const PALETTE = [
  { bg: "#F2E8D5", border: "#D4C5A0", text: "#6B5E3E" }, // 暖黄
  { bg: "#DCE8F0", border: "#A8C4D8", text: "#3E5C6B" }, // 淡蓝
  { bg: "#E8D8E8", border: "#C4A8C4", text: "#5C3E5C" }, // 淡紫
  { bg: "#D8E8D8", border: "#A4C4A4", text: "#3E5C3E" }, // 淡绿
  { bg: "#F0E0D0", border: "#D0B898", text: "#6B4E3E" }, // 淡橙
  { bg: "#D8E0E8", border: "#A0B8C8", text: "#3E5260" }, // 蓝灰
  { bg: "#E8E0D8", border: "#C8B8A0", text: "#5C4E3E" }, // 暖灰
  { bg: "#F0D8D8", border: "#D0A8A8", text: "#6B3E3E" }, // 淡粉
];

function categoryColor(category: string, index: number) {
  if (category && CATEGORY_COLORS[category]) return CATEGORY_COLORS[category];
  if (category) {
    const color = PALETTE[index % PALETTE.length];
    CATEGORY_COLORS[category] = color;
    return color;
  }
  return CATEGORY_COLORS.default;
}

export function KnowledgeGraphPanel({ notes, onOpenNote, onClose }: KnowledgeGraphPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const onOpenNoteRef = useRef(onOpenNote);
  onOpenNoteRef.current = onOpenNote;
  const [loadedNotes, setLoadedNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载所有笔记内容
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    // 防抖：连续保存（每次 notes 变化）时不反复全量重拉正文
    const timer = window.setTimeout(() => {
      void Promise.all(notes.map((n) => getNote(n.id).catch(() => null))).then((items) => {
        if (!active) return;
        const valid = items.filter((n): n is Note => n !== null);
        setLoadedNotes(valid);
        setLoading(false);
      });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [notes]);

  // 构建图数据
  const graphData = useMemo(() => {
    if (loadedNotes.length === 0) return null;

    const metadata = loadedNotes.map(({ content: _c, ...m }) => ({ ...m, preview: "" }));

    // 统计被引用次数
    const refCount = new Map<string, number>();
    const edgesSet = new Set<string>();

    const edgeList: Array<{ from: string; to: string }> = [];

    for (const note of loadedNotes) {
      const links = extractWikiLinks(note.content);
      for (const link of links) {
        const targetId = resolveWikiLink(link.target, metadata);
        if (!targetId || targetId === note.id) continue;

        const key = `${note.id}→${targetId}`;
        if (edgesSet.has(key)) continue;
        edgesSet.add(key);

        edgeList.push({ from: note.id, to: targetId });
        refCount.set(targetId, (refCount.get(targetId) ?? 0) + 1);
      }
    }

    // 过滤：只保留至少有一条边的节点
    const connectedIds = new Set<string>();
    for (const edge of edgeList) {
      connectedIds.add(edge.from);
      connectedIds.add(edge.to);
    }

    // 构建节点
    let colorIndex = 0;
    const nodes = loadedNotes
      .filter((n) => connectedIds.has(n.id))
      .map((note): Node => {
        const color = categoryColor(note.category, colorIndex++);
        const refs = refCount.get(note.id) ?? 0;
        const size = 10 + Math.min(refs * 4, 30);

        return {
          id: note.id,
          label: note.title.trim() || "无标题笔记",
          color: {
            background: color.bg,
            border: color.border,
            highlight: { background: color.bg, border: "#A08060" },
            hover: { background: color.bg, border: "#A08060" },
          },
          font: {
            color: color.text,
            size: 12,
            face: "var(--editor-font-family, sans-serif)",
          },
          shape: "dot" as const,
          size,
          borderWidth: 1.5,
        };
      });

    const edges: Edge[] = edgeList
      .filter((e) => connectedIds.has(e.from) && connectedIds.has(e.to))
      .map((e) => ({
        id: `${e.from}→${e.to}`,
        from: e.from,
        to: e.to,
        arrows: "to" as const,
        color: { color: "#C4BFB688", highlight: "#A0806088" },
        width: 1,
      }));

    return { nodes: new DataSet(nodes), edges: new DataSet(edges) };
  }, [loadedNotes]);

  // 渲染 vis-network
  useEffect(() => {
    if (!graphData || !containerRef.current) return;

    // 销毁旧实例
    if (networkRef.current) {
      networkRef.current.destroy();
      networkRef.current = null;
    }

    const network = new Network(
      containerRef.current,
      graphData,
      {
        physics: {
          solver: "forceAtlas2Based",
          forceAtlas2Based: {
            gravitationalConstant: -30,
            centralGravity: 0.008,
            springLength: 120,
            springConstant: 0.04,
          },
          stabilization: { iterations: 100 },
        },
        interaction: {
          hover: true,
          tooltipDelay: 200,
          zoomView: true,
          dragView: true,
        },
        edges: {
          smooth: true,
        },
        nodes: {
          shape: "dot",
          scaling: {
            min: 10,
            max: 40,
          },
        },
      },
    );

    network.on("click", (params) => {
      if (params.nodes.length === 1) {
        onOpenNoteRef.current(params.nodes[0] as string);
      }
    });

    networkRef.current = network;

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, [graphData]);

  const connectedCount = graphData?.nodes.length ?? 0;
  const edgeCount = graphData?.edges.length ?? 0;

  return (
    <aside className="w-[420px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/95 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25 shrink-0">
        <div>
          <h2 className="text-[13px] font-display font-medium text-ink-soft">知识图谱</h2>
          <p className="text-[10px] text-ink-ghost mt-0.5">
            {loading
              ? "正在加载笔记…"
              : `${connectedCount} 个节点 · ${edgeCount} 条关联`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭知识图谱"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[12px] text-ink-ghost">正在构建知识图谱…</p>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[12px] text-red-400">{error}</p>
          </div>
        ) : connectedCount === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <p className="text-[12px] text-ink-ghost leading-relaxed">
                还没有笔记之间建立了引用关系。
              </p>
              <p className="mt-1 text-[11px] text-ink-ghost/60">
                试试用 <code className="px-1 py-0.5 bg-paper-warm rounded text-[10px]">[[笔记标题]]</code> 链接到其他笔记。
              </p>
            </div>
          </div>
        ) : (
          <div ref={containerRef} className="w-full h-full" />
        )}
      </div>
    </aside>
  );
}
