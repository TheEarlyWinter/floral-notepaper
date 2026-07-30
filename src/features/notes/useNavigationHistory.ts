import { useCallback, useRef, useState } from "react";

export interface NavigationEntry {
  noteId: string;
  title: string;
}

interface NavigationState {
  stack: NavigationEntry[];
  index: number; // 当前位置在栈中的索引
}

/**
 * 跨笔记跳转的导航历史。
 * 自动去重：如果 push 的笔记与当前栈顶相同则忽略。
 * 前进历史在 push 新笔记时被截断（浏览器式行为）。
 */
export function useNavigationHistory() {
  const stateRef = useRef<NavigationState>({ stack: [], index: -1 });
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentEntry, setCurrentEntry] = useState<NavigationEntry | null>(null);

  const syncFlags = useCallback((state: NavigationState) => {
    setCanGoBack(state.index > 0);
    setCanGoForward(state.index < state.stack.length - 1);
    setCurrentEntry(state.index >= 0 ? state.stack[state.index] : null);
  }, []);

  const push = useCallback(
    (noteId: string, title: string) => {
      const state = stateRef.current;
      // 去重：与当前栈顶相同则忽略
      if (state.index >= 0 && state.stack[state.index]?.noteId === noteId) return;
      // 截断前进历史
      const newStack = state.stack.slice(0, state.index + 1);
      newStack.push({ noteId, title });
      // 限制最大深度 50，防止内存无限制增长
      if (newStack.length > 50) {
        newStack.shift();
      }
      const newState: NavigationState = {
        stack: newStack,
        index: newStack.length - 1,
      };
      stateRef.current = newState;
      syncFlags(newState);
    },
    [syncFlags],
  );

  const goBack = useCallback((): string | null => {
    const state = stateRef.current;
    if (state.index <= 0) return null;
    const newIndex = state.index - 1;
    const newState: NavigationState = { ...state, index: newIndex };
    stateRef.current = newState;
    syncFlags(newState);
    return newState.stack[newIndex].noteId;
  }, [syncFlags]);

  const goForward = useCallback((): string | null => {
    const state = stateRef.current;
    if (state.index >= state.stack.length - 1) return null;
    const newIndex = state.index + 1;
    const newState: NavigationState = { ...state, index: newIndex };
    stateRef.current = newState;
    syncFlags(newState);
    return newState.stack[newIndex].noteId;
  }, [syncFlags]);

  const breadcrumbs = (): NavigationEntry[] => {
    const state = stateRef.current;
    if (state.index < 0) return [];
    return state.stack.slice(0, state.index + 1);
  };

  return { push, goBack, goForward, canGoBack, canGoForward, currentEntry, breadcrumbs };
}
