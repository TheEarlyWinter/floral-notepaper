import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearExternalActivity,
  getErrorMessage,
  getExecutablePath,
  listExternalActivity,
} from "../features/notes/api";
import type { ExternalActivityEntry } from "../features/notes/types";
import { showToast } from "./Toast";

export type McpClientPreset = "antigravity" | "claudeCode" | "codex" | "generic";

export const MCP_CLIENT_PRESETS: ReadonlyArray<{
  value: McpClientPreset;
  labelKey: string;
  defaultLabel: string;
  hintKey: string;
  defaultHint: string;
}> = [
  {
    value: "antigravity",
    labelKey: "settings.mcp.presets.antigravity",
    defaultLabel: "Antigravity",
    hintKey: "settings.mcp.presetHint.antigravity",
    defaultHint: "粘贴到 Antigravity 的 mcp_config.json 中。",
  },
  {
    value: "claudeCode",
    labelKey: "settings.mcp.presets.claudeCode",
    defaultLabel: "Claude Code",
    hintKey: "settings.mcp.presetHint.claudeCode",
    defaultHint: "粘贴到 Claude Code 的 .mcp.json 或 ~/.claude.json 中（已包含 type: stdio）。",
  },
  {
    value: "codex",
    labelKey: "settings.mcp.presets.codex",
    defaultLabel: "Codex",
    hintKey: "settings.mcp.presetHint.codex",
    defaultHint:
      '标准 mcpServers JSON 片段（若使用 Codex config.toml，对应 command 与 args = ["--mcp"]）。',
  },
  {
    value: "generic",
    labelKey: "settings.mcp.presets.generic",
    defaultLabel: "通用",
    hintKey: "settings.mcp.presetHint.generic",
    defaultHint: "适用于支持 mcpServers JSON 格式的任意 MCP 客户端。",
  },
];

const FALLBACK_EXECUTABLE_PATH = "floral-notepaper";

export function buildMcpConfigObject(preset: McpClientPreset, executablePath: string) {
  const command = executablePath.trim() || FALLBACK_EXECUTABLE_PATH;
  const serverConfig =
    preset === "claudeCode"
      ? { type: "stdio", command, args: ["--mcp"] }
      : { command, args: ["--mcp"] };

  return {
    mcpServers: {
      "floral-notepaper": serverConfig,
    },
  };
}

export function buildMcpConfigSnippet(preset: McpClientPreset, executablePath: string): string {
  return JSON.stringify(buildMcpConfigObject(preset, executablePath), null, 2);
}

export function formatActivityTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}

export async function copyMcpConfigSnippet(
  snippet: string,
  options: {
    writeClipboard?: (text: string) => Promise<void>;
    notify?: (message: string, type?: "error" | "warning" | "info") => void;
    successMessage: string;
    failureMessage: string;
  },
): Promise<boolean> {
  const notify = options.notify ?? showToast;
  const write =
    options.writeClipboard ??
    (async (text: string) => {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {
          // Fall back to Tauri clipboard plugin when WebView blocks navigator.clipboard.
        }
      }
      await writeClipboardText(text);
    });

  try {
    await write(snippet);
    notify(options.successMessage, "info");
    return true;
  } catch {
    notify(options.failureMessage, "error");
    return false;
  }
}

export interface McpIntegrationSectionProps {
  initialExecutablePath?: string;
  initialActivity?: ExternalActivityEntry[];
}

export function McpIntegrationSection({
  initialExecutablePath,
  initialActivity,
}: McpIntegrationSectionProps) {
  const { t } = useTranslation();
  const [executablePath, setExecutablePath] = useState(initialExecutablePath ?? "");
  const [resolvingPath, setResolvingPath] = useState(initialExecutablePath === undefined);
  const [preset, setPreset] = useState<McpClientPreset>("antigravity");
  const [copied, setCopied] = useState(false);
  const [activity, setActivity] = useState<ExternalActivityEntry[]>(initialActivity ?? []);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [clearingActivity, setClearingActivity] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;

    if (initialExecutablePath === undefined) {
      getExecutablePath()
        .then((path) => {
          if (!alive) return;
          setExecutablePath(path);
        })
        .catch(() => {
          if (!alive) return;
          setExecutablePath("");
        })
        .finally(() => {
          if (!alive) return;
          setResolvingPath(false);
        });
    }

    if (initialActivity === undefined) {
      setLoadingActivity(true);
      listExternalActivity()
        .then((entries) => {
          if (!alive) return;
          setActivity(entries);
        })
        .catch(() => {
          // Ignore initial load error in non-Tauri environments; manual refresh surfaces errors.
        })
        .finally(() => {
          if (!alive) return;
          setLoadingActivity(false);
        });
    }

    return () => {
      alive = false;
    };
  }, [initialExecutablePath, initialActivity]);

  const activePresetMeta = useMemo(
    () => MCP_CLIENT_PRESETS.find((item) => item.value === preset) ?? MCP_CLIENT_PRESETS[0],
    [preset],
  );

  const snippet = useMemo(
    () => buildMcpConfigSnippet(preset, executablePath),
    [preset, executablePath],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyMcpConfigSnippet(snippet, {
      successMessage: t("settings.mcp.copiedToast", {
        defaultValue: "MCP 配置已复制到剪贴板",
      }),
      failureMessage: t("settings.mcp.copyFailedToast", {
        defaultValue: "复制 MCP 配置失败",
      }),
    });
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
    }
  }, [snippet, t]);

  const handleRefreshActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      const entries = await listExternalActivity();
      setActivity(entries);
    } catch (error) {
      showToast(
        `${t("settings.mcp.activity.loadFailed", { defaultValue: "读取外部活动失败" })}: ${getErrorMessage(error, t)}`,
        "error",
      );
    } finally {
      setLoadingActivity(false);
    }
  }, [t]);

  const handleClearActivity = useCallback(async () => {
    setClearingActivity(true);
    try {
      await clearExternalActivity();
      setActivity([]);
      showToast(
        t("settings.mcp.activity.clearedToast", { defaultValue: "已清空外部活动记录" }),
        "info",
      );
    } catch (error) {
      showToast(getErrorMessage(error, t), "error");
    } finally {
      setClearingActivity(false);
    }
  }, [t]);

  return (
    <section className="space-y-3 pt-3 border-t border-paper-deep/20">
      <div className="space-y-0.5">
        <h3 className="text-[11px] font-display font-medium text-ink-faint/80">
          {t("settings.mcp.heading", { defaultValue: "MCP 与 CLI 集成" })}
        </h3>
        <p className="text-[10.5px] leading-relaxed text-ink-ghost">
          {t("settings.mcp.description", {
            defaultValue: "通过标准 MCP stdio 或命令行访问花笺笔记、待办与提醒。",
          })}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
          {t("settings.mcp.executablePathLabel", { defaultValue: "可执行文件路径" })}
        </label>
        <input
          type="text"
          readOnly
          value={
            resolvingPath
              ? t("settings.mcp.executablePathLoading", { defaultValue: "正在读取路径…" })
              : executablePath || FALLBACK_EXECUTABLE_PATH
          }
          title={executablePath || FALLBACK_EXECUTABLE_PATH}
          aria-label={t("settings.mcp.executablePathLabel", { defaultValue: "可执行文件路径" })}
          className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none truncate"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-[11px] font-body text-ink-faint/70 px-0.5">
          {t("settings.mcp.presetLabel", { defaultValue: "客户端预设" })}
        </label>
        <div className="grid grid-cols-2 gap-1.5" role="group">
          {MCP_CLIENT_PRESETS.map((item) => {
            const active = item.value === preset;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                onClick={() => setPreset(item.value)}
                className={`h-7 px-2.5 rounded-lg border text-[11px] transition-colors cursor-pointer truncate ${
                  active
                    ? "bg-bamboo-mist/70 border-bamboo text-bamboo font-medium"
                    : "bg-paper-warm/50 border-paper-deep/35 text-ink-faint hover:text-ink-soft hover:border-paper-deep/55"
                }`}
              >
                {t(item.labelKey, { defaultValue: item.defaultLabel })}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] leading-relaxed text-ink-ghost px-0.5">
          {t(activePresetMeta.hintKey, { defaultValue: activePresetMeta.defaultHint })}
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[11px] font-body text-ink-faint/70">
            {t("settings.mcp.snippetLabel", { defaultValue: "mcpServers 配置片段" })}
          </span>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="h-6 px-2.5 rounded-md border border-paper-deep/45 text-[10.5px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
          >
            {copied
              ? t("settings.mcp.copiedButton", { defaultValue: "已复制" })
              : t("settings.mcp.copyButton", { defaultValue: "复制配置" })}
          </button>
        </div>
        <pre className="p-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[10.5px] leading-relaxed font-mono text-ink-soft overflow-x-auto select-all">
          <code>{snippet}</code>
        </pre>
      </div>

      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-[11px] font-body text-ink-faint/80">
            {t("settings.mcp.activity.heading", { defaultValue: "最近外部活动" })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={loadingActivity}
              onClick={() => void handleRefreshActivity()}
              className="h-6 px-2 rounded-md border border-paper-deep/45 text-[10.5px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {loadingActivity
                ? t("settings.mcp.activity.refreshing", { defaultValue: "刷新中…" })
                : t("settings.mcp.activity.refresh", { defaultValue: "刷新" })}
            </button>
            <button
              type="button"
              disabled={clearingActivity || activity.length === 0}
              onClick={() => void handleClearActivity()}
              className="h-6 px-2 rounded-md border border-paper-deep/45 text-[10.5px] text-ink-faint hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {t("settings.mcp.activity.clear", { defaultValue: "清空" })}
            </button>
          </div>
        </div>

        {activity.length === 0 ? (
          <div className="rounded-lg bg-paper-warm/40 border border-paper-deep/25 px-3 py-3 text-[11px] text-ink-ghost text-center">
            {t("settings.mcp.activity.empty", { defaultValue: "暂无 CLI 或 MCP 调用记录" })}
          </div>
        ) : (
          <ul className="max-h-52 overflow-y-auto space-y-1.5 pr-0.5">
            {activity.map((entry) => (
              <li
                key={entry.id}
                className="rounded-lg bg-paper-warm/45 border border-paper-deep/25 px-2.5 py-2 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="px-1.5 py-0.5 rounded bg-paper-deep/30 text-[9.5px] font-mono uppercase text-ink-faint shrink-0">
                      {entry.source}
                    </span>
                    <span className="text-[11px] font-mono text-ink-soft truncate">
                      {entry.action}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`text-[9.5px] px-1.5 py-0.5 rounded ${
                        entry.ok ? "bg-bamboo-mist/70 text-bamboo" : "bg-red-400/15 text-red-400"
                      }`}
                    >
                      {entry.ok
                        ? t("settings.mcp.activity.statusOk", { defaultValue: "成功" })
                        : t("settings.mcp.activity.statusError", { defaultValue: "失败" })}
                    </span>
                    <span className="text-[10px] font-mono text-ink-ghost tabular-nums">
                      {formatActivityTimestamp(entry.timestamp)}
                    </span>
                  </div>
                </div>
                {(entry.target || entry.summary) && (
                  <p className="text-[10.5px] text-ink-faint break-words">
                    {entry.target ? (
                      <span className="font-mono text-ink-soft/85 mr-1.5">{entry.target}</span>
                    ) : null}
                    <span>{entry.summary}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
