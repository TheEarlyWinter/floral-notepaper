import { useMemo, useRef } from "react";

export interface LoadEpoch {
  // 开始一次新的异步加载，返回本次 epoch token；之后用 isCurrent 校验是否仍然有效
  bump: () => number;
  // 只读取当前 epoch 而不自增：用于"记录事件到达瞬间的代次，期间若发生切换则过期"
  peek: () => number;
  // 异步完成后调用：仅当期间未发生新的 bump（用户未切换/重载）时为 true
  isCurrent: (token: number) => boolean;
}

// 统一封装"加载竞态守卫"：每次切换/加载笔记自增 epoch，异步结果回来后用
// isCurrent 判断是否过期。集中此处后，新增异步加载路径只需 bump/isCurrent 两步，
// 避免裸 ref 在多处内联导致的"忘记连线 → stale 结果覆盖新选中"竞态回归
export function useLoadEpoch(): LoadEpoch {
  const ref = useRef(0);
  return useMemo<LoadEpoch>(
    () => ({
      bump: () => (ref.current += 1),
      peek: () => ref.current,
      isCurrent: (token: number) => ref.current === token,
    }),
    [],
  );
}
