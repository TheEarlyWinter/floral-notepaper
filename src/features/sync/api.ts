import { invoke } from "@tauri-apps/api/core";
import type { SyncProvider } from "../settings/types";

export type SyncSecretKind = "webdav" | "git";

export type SyncRunState = "idle" | "syncing" | "success" | "conflict" | "error";

export interface SyncConflictItem {
  path: string;
  conflictCopyPath: string;
  timestamp: string;
}

export interface SyncStatus {
  provider: SyncProvider;
  state: SyncRunState;
  running: boolean;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastMessage: string | null;
  lastError: string | null;
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: SyncConflictItem[];
  hasWebdavPassword: boolean;
  hasGitToken: boolean;
  keyringAvailable: boolean;
}

export interface SyncTestResult {
  ok: boolean;
  provider: SyncProvider;
  message: string;
  latencyMs: number;
}

export function getSyncStatus(): Promise<SyncStatus> {
  return invoke("sync_get_status");
}

export function setSyncSecret(provider: SyncSecretKind, secret: string): Promise<void> {
  return invoke("sync_set_secret", { provider, secret });
}

export function hasSyncSecret(provider: SyncSecretKind): Promise<boolean> {
  return invoke("sync_has_secret", { provider });
}

export function clearSyncSecret(provider: SyncSecretKind): Promise<void> {
  return invoke("sync_clear_secret", { provider });
}

export function testSyncConnection(): Promise<SyncTestResult> {
  return invoke("sync_test_connection");
}

export function runSyncNow(): Promise<SyncStatus> {
  return invoke("sync_run_now");
}
