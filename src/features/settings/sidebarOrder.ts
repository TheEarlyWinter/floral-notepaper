export const DEFAULT_SIDEBAR_ACTION_ORDER = [
  "daily",
  "inbox",
  "journal",
  "dashboard",
  "new-note",
  "todos",
  "import",
] as const;

export type SidebarActionId = (typeof DEFAULT_SIDEBAR_ACTION_ORDER)[number];

export function normalizeOrder<T extends string>(savedOrder: readonly string[] | undefined, available: readonly T[]): T[] {
  const availableSet = new Set(available);
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of savedOrder ?? []) {
    if (availableSet.has(item as T) && !seen.has(item)) {
      seen.add(item);
      result.push(item as T);
    }
  }

  for (const item of available) {
    if (!seen.has(item)) result.push(item);
  }

  return result;
}

export function moveOrderItem<T extends string>(order: readonly T[], item: T, target: T): T[] {
  if (item === target) return [...order];
  const sourceIndex = order.indexOf(item);
  const targetIndex = order.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return [...order];
  const next = [...order];
  next.splice(sourceIndex, 1);
  next.splice(next.indexOf(target), 0, item);
  return next;
}
