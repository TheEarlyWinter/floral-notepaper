import { useState, useEffect, useCallback } from "react";
import { getImagesBaseDir } from "./api";

/**
 * 图片基准目录。迁移数据目录后调用 refresh() 重新获取，
 * 否则旧路径会让已有笔记图片全部失效。
 */
export function useImageBaseDir(): { dir: string | null; refresh: () => void } {
  const [dir, setDir] = useState<string | null>(null);
  const refresh = useCallback(() => {
    getImagesBaseDir()
      .then(setDir)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { dir, refresh };
}
