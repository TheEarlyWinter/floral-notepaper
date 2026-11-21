import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../features/notes/api";
import { saveConfig } from "../features/settings/api";
import type { AppConfig, SyncProvider } from "../features/settings/types";
import {
  clearSyncSecret,
  getSyncStatus,
  runSyncNow,
  setSyncSecret,
  testSyncConnection,
  type SyncSecretKind,
  type SyncStatus,
} from "../features/sync/api";
import { SlidingButtonGroup } from "./SlidingButtonGroup";

export interface SyncSettingsSectionProps {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  initialStatus?: SyncStatus;
  onSaveConfig?: (config: AppConfig) => Promise<AppConfig>;
}

type SyncBusyAction = "secret" | "test" | "sync" | null;

type SyncNotice = {
  tone: "success" | "warning" | "error" | "idle";
  text: string;
};

const PRESET_INTERVAL_MINUTES = ["0", "5", "15", "30", "60"] as const;

export function formatSyncTimestamp(iso: string | null | undefined, neverText: string): string {
  if (!iso) return neverText;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function SyncSettingsSection({
  config,
  onChange,
  initialStatus,
  onSaveConfig = saveConfig,
}: SyncSettingsSectionProps) {
  const { t } = useTranslation();
  const provider: SyncProvider = config.syncProvider ?? "none";
  const intervalMinutes = config.syncAutoIntervalMinutes ?? 0;

  const [status, setStatus] = useState<SyncStatus | null>(initialStatus ?? null);
  const [secretInput, setSecretInput] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<SyncBusyAction>(null);
  const [notice, setNotice] = useState<SyncNotice | null>(null);

  const setField = <Key extends keyof AppConfig>(key: Key, value: AppConfig[Key]) => {
    onChange({ ...config, [key]: value });
  };

  useEffect(() => {
    if (initialStatus) return;
    let alive = true;
    getSyncStatus()
      .then((loaded) => {
        if (alive) setStatus(loaded);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [initialStatus]);

  useEffect(() => {
    let disposed = false;
    const promise = listen<SyncStatus>("sync://status-changed", (event) => {
      if (!disposed) {
        setStatus(event.payload);
      }
    }).catch(() => undefined);

    return () => {
      disposed = true;
      void promise.then((unlisten) => unlisten?.());
    };
  }, []);

  // 切换同步方式时清空临时输入框，避免将一种凭据误提交给另一种方式
  useEffect(() => {
    setSecretInput("");
    setShowSecret(false);
    setNotice(null);
  }, [provider]);

  const providerOptions = useMemo<Array<{ value: SyncProvider; label: string }>>(
    () => [
      { value: "none", label: t("settings.sync.provider.none", { defaultValue: "关闭" }) },
      { value: "webdav", label: t("settings.sync.provider.webdav", { defaultValue: "WebDAV" }) },
      { value: "git", label: t("settings.sync.provider.git", { defaultValue: "Git" }) },
    ],
    [t],
  );

  const intervalOptions = useMemo<Array<{ value: string; label: string }>>(() => {
    const base = [
      { value: "0", label: t("settings.sync.interval.off", { defaultValue: "关闭" }) },
      { value: "5", label: t("settings.sync.interval.minutes5", { defaultValue: "5 分钟" }) },
      { value: "15", label: t("settings.sync.interval.minutes15", { defaultValue: "15 分钟" }) },
      { value: "30", label: t("settings.sync.interval.minutes30", { defaultValue: "30 分钟" }) },
      { value: "60", label: t("settings.sync.interval.minutes60", { defaultValue: "60 分钟" }) },
    ];
    const currentStr = String(intervalMinutes);
    if (
      intervalMinutes > 0 &&
      !PRESET_INTERVAL_MINUTES.includes(currentStr as (typeof PRESET_INTERVAL_MINUTES)[number])
    ) {
      return [
        ...base,
        {
          value: currentStr,
          label: t("settings.sync.interval.custom", {
            minutes: intervalMinutes,
            defaultValue: "{{minutes}} 分钟",
          }),
        },
      ];
    }
    return base;
  }, [intervalMinutes, t]);

  const activeSecretKind: SyncSecretKind | null =
    provider === "webdav" ? "webdav" : provider === "git" ? "git" : null;
  const hasSavedSecret =
    provider === "webdav"
      ? Boolean(status?.hasWebdavPassword)
      : provider === "git"
        ? Boolean(status?.hasGitToken)
        : false;
  const controlsDisabled = busy !== null || Boolean(status?.running);

  const refreshStatus = async () => {
    try {
      const next = await getSyncStatus();
      setStatus(next);
    } catch {
      // Ignore transient status refresh failures
    }
  };

  const handleSaveSecret = async () => {
    if (!activeSecretKind) return;
    const trimmed = secretInput.trim();
    if (!trimmed) {
      setNotice({
        tone: "warning",
        text: t("settings.sync.secretEmpty", { defaultValue: "请输入凭据后再保存" }),
      });
      return;
    }
    setBusy("secret");
    setNotice(null);
    try {
      await setSyncSecret(activeSecretKind, trimmed);
      setSecretInput("");
      setShowSecret(false);
      await refreshStatus();
      setNotice({
        tone: "success",
        text: t("settings.sync.secretSavedToast", {
          defaultValue: "凭据已保存到系统安全存储",
        }),
      });
    } catch (error) {
      setNotice({ tone: "error", text: getErrorMessage(error, t) });
    } finally {
      setBusy(null);
    }
  };

  const handleClearSecret = async () => {
    if (!activeSecretKind) return;
    setBusy("secret");
    setNotice(null);
    try {
      await clearSyncSecret(activeSecretKind);
      setSecretInput("");
      await refreshStatus();
      setNotice({
        tone: "idle",
        text: t("settings.sync.secretClearedToast", { defaultValue: "已清除保存的凭据" }),
      });
    } catch (error) {
      setNotice({ tone: "error", text: getErrorMessage(error, t) });
    } finally {
      setBusy(null);
    }
  };

  const handleTestConnection = async () => {
    setBusy("test");
    setNotice(null);
    try {
      await onSaveConfig(config);
      const res = await testSyncConnection();
      setNotice({
        tone: res.ok ? "success" : "error",
        text: res.ok
          ? t("settings.sync.testSuccess", {
              latencyMs: res.latencyMs,
              defaultValue: "连接成功（{{latencyMs}} ms）",
            })
          : res.message,
      });
    } catch (error) {
      setNotice({ tone: "error", text: getErrorMessage(error, t) });
    } finally {
      setBusy(null);
    }
  };

  const handleSyncNow = async () => {
    setBusy("sync");
    setNotice(null);
    try {
      await onSaveConfig(config);
      const nextStatus = await runSyncNow();
      setStatus(nextStatus);
      setNotice({
        tone: nextStatus.conflicts.length > 0 ? "warning" : "success",
        text:
          nextStatus.lastMessage ?? t("settings.sync.syncSuccess", { defaultValue: "同步完成" }),
      });
    } catch (error) {
      setNotice({ tone: "error", text: getErrorMessage(error, t) });
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = (() => {
    if (busy === "sync" || status?.running) {
      return t("settings.sync.state.syncing", { defaultValue: "同步中" });
    }
    switch (status?.state) {
      case "success":
        return t("settings.sync.state.success", { defaultValue: "已同步" });
      case "conflict":
        return t("settings.sync.state.conflict", { defaultValue: "有冲突" });
      case "error":
        return t("settings.sync.state.error", { defaultValue: "失败" });
      default:
        return t("settings.sync.state.idle", { defaultValue: "空闲" });
    }
  })();

  const statusBadgeClass = (() => {
    if (busy === "sync" || status?.running) {
      return "border-bamboo/40 bg-bamboo-mist/40 text-bamboo";
    }
    switch (status?.state) {
      case "success":
        return "border-bamboo/40 bg-bamboo-mist/40 text-bamboo";
      case "conflict":
        return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300";
      case "error":
        return "border-red-400/40 bg-red-400/10 text-red-500";
      default:
        return "border-paper-deep/35 bg-paper-warm/50 text-ink-ghost";
    }
  })();

  return (
    <section className="space-y-3 pt-3 border-t border-paper-deep/20">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-display font-medium text-ink-faint/80">
          {t("settings.sync.heading", { defaultValue: "云同步" })}
        </h3>
        {provider !== "none" && status ? (
          <span
            className={`px-2 py-0.5 rounded-full border text-[10px] font-mono ${statusBadgeClass}`}
          >
            {statusLabel}
          </span>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className="block text-[11px] font-body text-ink-faint">
          {t("settings.sync.provider.label", { defaultValue: "同步方式" })}
        </label>
        <SlidingButtonGroup
          options={providerOptions}
          value={provider}
          onChange={(next) => setField("syncProvider", next)}
        />
      </div>

      {provider === "webdav" ? (
        <div className="space-y-2.5">
          <div className="space-y-1">
            <label className="block text-[11px] font-body text-ink-faint/70">
              {t("settings.sync.webdav.url", { defaultValue: "服务器地址" })}
            </label>
            <input
              type="url"
              value={config.syncWebdavUrl ?? ""}
              onChange={(event) => setField("syncWebdavUrl", event.target.value)}
              placeholder={t("settings.sync.webdav.urlPlaceholder", {
                defaultValue: "https://dav.example.com/dav",
              })}
              spellCheck={false}
              className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="block text-[11px] font-body text-ink-faint/70">
                {t("settings.sync.webdav.username", { defaultValue: "用户名" })}
              </label>
              <input
                type="text"
                value={config.syncWebdavUsername ?? ""}
                onChange={(event) => setField("syncWebdavUsername", event.target.value)}
                placeholder={t("settings.sync.webdav.usernamePlaceholder", {
                  defaultValue: "username",
                })}
                spellCheck={false}
                className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-body text-ink-faint/70">
                {t("settings.sync.webdav.remoteDir", { defaultValue: "远端目录" })}
              </label>
              <input
                type="text"
                value={config.syncWebdavRemoteDir ?? "floral-notepaper"}
                onChange={(event) => setField("syncWebdavRemoteDir", event.target.value)}
                placeholder="floral-notepaper"
                spellCheck={false}
                className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
              />
            </div>
          </div>

          <SecretCredentialRow
            label={t("settings.sync.webdav.password", { defaultValue: "密码 / 应用专用密码" })}
            placeholder={
              hasSavedSecret
                ? t("settings.sync.secretSavedPlaceholder", {
                    defaultValue: "已安全保存（输入新凭据以覆盖）",
                  })
                : t("settings.sync.webdav.passwordPlaceholder", {
                    defaultValue: "输入 WebDAV 密码",
                  })
            }
            value={secretInput}
            showSecret={showSecret}
            hasSavedSecret={hasSavedSecret}
            disabled={controlsDisabled}
            onChange={setSecretInput}
            onToggleShow={() => setShowSecret((prev) => !prev)}
            onSave={() => void handleSaveSecret()}
            onClear={() => void handleClearSecret()}
          />
        </div>
      ) : null}

      {provider === "git" ? (
        <div className="space-y-2.5">
          <div className="space-y-1">
            <label className="block text-[11px] font-body text-ink-faint/70">
              {t("settings.sync.git.remoteUrl", { defaultValue: "远程仓库地址" })}
            </label>
            <input
              type="text"
              value={config.syncGitRemoteUrl ?? ""}
              onChange={(event) => setField("syncGitRemoteUrl", event.target.value)}
              placeholder={t("settings.sync.git.remoteUrlPlaceholder", {
                defaultValue: "https://github.com/user/notes.git",
              })}
              spellCheck={false}
              className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="block text-[11px] font-body text-ink-faint/70">
                {t("settings.sync.git.branch", { defaultValue: "分支" })}
              </label>
              <input
                type="text"
                value={config.syncGitBranch ?? "main"}
                onChange={(event) => setField("syncGitBranch", event.target.value)}
                placeholder="main"
                spellCheck={false}
                className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-body text-ink-faint/70">
                {t("settings.sync.git.username", { defaultValue: "用户名（可选）" })}
              </label>
              <input
                type="text"
                value={config.syncGitUsername ?? ""}
                onChange={(event) => setField("syncGitUsername", event.target.value)}
                placeholder={t("settings.sync.git.usernamePlaceholder", {
                  defaultValue: "git / username",
                })}
                spellCheck={false}
                className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
              />
            </div>
          </div>

          <SecretCredentialRow
            label={t("settings.sync.git.token", { defaultValue: "个人访问令牌（PAT）" })}
            placeholder={
              hasSavedSecret
                ? t("settings.sync.secretSavedPlaceholder", {
                    defaultValue: "已安全保存（输入新凭据以覆盖）",
                  })
                : t("settings.sync.git.tokenPlaceholder", {
                    defaultValue: "输入访问令牌（SSH 可留空）",
                  })
            }
            value={secretInput}
            showSecret={showSecret}
            hasSavedSecret={hasSavedSecret}
            disabled={controlsDisabled}
            onChange={setSecretInput}
            onToggleShow={() => setShowSecret((prev) => !prev)}
            onSave={() => void handleSaveSecret()}
            onClear={() => void handleClearSecret()}
          />
        </div>
      ) : null}

      {provider !== "none" ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-[11px] font-body text-ink-faint">
              {t("settings.sync.interval.label", { defaultValue: "自动同步间隔" })}
            </label>
            <SlidingButtonGroup
              options={intervalOptions}
              value={String(intervalMinutes)}
              onChange={(value) => setField("syncAutoIntervalMinutes", Number(value))}
            />
          </div>

          {status && !status.keyringAvailable ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-600 dark:text-amber-300 leading-relaxed">
              {t("settings.sync.keyringUnavailable", {
                defaultValue: "当前系统安全凭据库不可用，无法保存密码或令牌。",
              })}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void handleTestConnection()}
              className="flex-1 h-8 px-3 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {busy === "test"
                ? t("settings.sync.testing", { defaultValue: "测试中..." })
                : t("settings.sync.testConnection", { defaultValue: "测试连接" })}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void handleSyncNow()}
              className="flex-1 h-8 px-3 rounded-lg bg-bamboo text-white text-[11px] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity cursor-pointer"
            >
              {busy === "sync" || status?.running
                ? t("settings.sync.syncing", { defaultValue: "同步中..." })
                : t("settings.sync.syncNow", { defaultValue: "立即同步" })}
            </button>
          </div>

          {notice ? (
            <p
              className={`rounded-lg border px-2.5 py-2 text-[10.5px] leading-relaxed ${
                notice.tone === "error"
                  ? "border-red-400/40 bg-red-400/10 text-red-500"
                  : notice.tone === "warning"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                    : notice.tone === "success"
                      ? "border-bamboo/40 bg-bamboo-mist/40 text-bamboo"
                      : "border-paper-deep/30 bg-paper-warm/45 text-ink-faint"
              }`}
            >
              {notice.text}
            </p>
          ) : null}

          {status ? (
            <div className="space-y-1.5 rounded-lg border border-paper-deep/25 bg-paper-warm/40 px-2.5 py-2 text-[10px] font-mono text-ink-ghost">
              <div className="flex items-center justify-between gap-2">
                <span>{t("settings.sync.lastSyncLabel", { defaultValue: "上次同步" })}</span>
                <span className="text-ink-faint">
                  {formatSyncTimestamp(
                    status.lastSyncAt,
                    t("settings.sync.neverSynced", { defaultValue: "尚未同步" }),
                  )}
                </span>
              </div>
              {status.lastSyncAt ? (
                <div className="text-ink-faint">
                  {t("settings.sync.statsSummary", {
                    uploaded: status.uploaded,
                    downloaded: status.downloaded,
                    deleted: status.deletedLocal + status.deletedRemote,
                    defaultValue: "上传 {{uploaded}} · 下载 {{downloaded}} · 删除 {{deleted}}",
                  })}
                </div>
              ) : null}
              {status.lastError ? (
                <p className="text-red-500 break-words">{status.lastError}</p>
              ) : null}
              {status.conflicts.length > 0 ? (
                <div className="space-y-1 pt-1 border-t border-paper-deep/20">
                  <p className="text-amber-600 dark:text-amber-300">
                    {t("settings.sync.conflictsSummary", {
                      count: status.conflicts.length,
                      defaultValue: "检测到 {{count}} 个冲突副本（已保留本地文件）：",
                    })}
                  </p>
                  <ul className="space-y-0.5 text-[9.5px] text-ink-faint break-all">
                    {status.conflicts.map((item) => (
                      <li key={`${item.path}-${item.conflictCopyPath}`}>
                        {item.path} → {item.conflictCopyPath}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[10.5px] text-ink-ghost leading-relaxed">
          {t("settings.sync.disabledHint", {
            defaultValue: "同步默认关闭；选择 WebDAV 或 Git 后可跨设备同步笔记、图片与提醒。",
          })}
        </p>
      )}
    </section>
  );
}

interface SecretCredentialRowProps {
  label: string;
  placeholder: string;
  value: string;
  showSecret: boolean;
  hasSavedSecret: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onToggleShow: () => void;
  onSave: () => void;
  onClear: () => void;
}

function SecretCredentialRow({
  label,
  placeholder,
  value,
  showSecret,
  hasSavedSecret,
  disabled,
  onChange,
  onToggleShow,
  onSave,
  onClear,
}: SecretCredentialRowProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-[11px] font-body text-ink-faint/70">{label}</label>
        <span
          className={`text-[10px] font-mono ${hasSavedSecret ? "text-bamboo" : "text-ink-ghost"}`}
        >
          {hasSavedSecret
            ? t("settings.sync.secretSaved", { defaultValue: "已保存" })
            : t("settings.sync.secretNotSet", { defaultValue: "未配置" })}
        </span>
      </div>
      <div className="flex gap-1.5">
        <input
          type={showSecret ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[11px] font-mono text-ink-soft outline-none focus:border-bamboo/40"
        />
        <button
          type="button"
          onClick={onToggleShow}
          disabled={!value}
          className="h-8 px-2 rounded-lg border border-paper-deep/45 text-[10px] text-ink-ghost hover:text-ink-faint disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          title={
            showSecret
              ? t("settings.sync.hideSecret", { defaultValue: "隐藏" })
              : t("settings.sync.showSecret", { defaultValue: "显示" })
          }
        >
          {showSecret
            ? t("settings.sync.hideSecret", { defaultValue: "隐藏" })
            : t("settings.sync.showSecret", { defaultValue: "显示" })}
        </button>
        <button
          type="button"
          disabled={disabled || !value.trim()}
          onClick={onSave}
          className="h-8 px-2.5 rounded-lg border border-paper-deep/45 text-[11px] text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
        >
          {t("settings.sync.saveSecret", { defaultValue: "保存" })}
        </button>
        {hasSavedSecret ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="h-8 px-2.5 rounded-lg border border-red-400/40 text-[11px] text-red-400 hover:bg-red-400/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          >
            {t("settings.sync.clearSecret", { defaultValue: "清除" })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
