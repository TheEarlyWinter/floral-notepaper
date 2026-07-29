import { useCallback, useEffect, useState } from "react";
import { getErrorMessage, listNoteVersions } from "../features/notes/api";
import type { NoteVersion } from "../features/notes/types";

interface NoteHistoryPanelProps {
  noteId: string;
  onRestore: (versionId: string) => Promise<void>;
  onClose: () => void;
}

function formatVersionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function NoteHistoryPanel({ noteId, onRestore, onClose }: NoteHistoryPanelProps) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setVersions(await listNoteVersions(noteId));
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRestore = async (version: NoteVersion) => {
    const confirmed = window.confirm(
      `恢复到 ${formatVersionTime(version.createdAt)} 的版本？当前内容会先自动备份。`,
    );
    if (!confirmed) return;

    setRestoringId(version.id);
    try {
      await onRestore(version.id);
      await reload();
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <aside className="w-[360px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between h-11 px-4 border-b border-paper-deep/25">
        <div>
          <h2 className="text-[13px] font-display font-medium text-ink-soft">版本历史</h2>
          <p className="text-[10px] text-ink-ghost mt-0.5">每篇最多保留 20 份</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭版本历史"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="py-10 text-center text-[12px] text-ink-ghost">正在读取历史版本…</div>
        ) : error ? (
          <div className="py-10 text-center text-[12px] text-red-400">{error}</div>
        ) : versions.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-ink-ghost leading-relaxed">
            保存过新的内容后，旧版本会出现在这里。
          </div>
        ) : (
          <div className="space-y-1.5">
            {versions.map((version) => (
              <div
                key={version.id}
                className="rounded-lg border border-paper-deep/25 bg-paper-warm/35 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] text-ink-soft">
                      {formatVersionTime(version.createdAt)}
                    </p>
                    <p className="mt-1 text-[10px] text-ink-ghost line-clamp-2 leading-relaxed">
                      {version.preview || "空白内容"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRestore(version)}
                    disabled={restoringId !== null}
                    className="shrink-0 px-2 py-1 rounded text-[10px] text-bamboo border border-bamboo/25 hover:bg-bamboo-mist transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-wait"
                  >
                    {restoringId === version.id ? "恢复中" : "恢复"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
