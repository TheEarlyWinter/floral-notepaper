import { useEffect, useRef, useState } from "react";

export function useColumnResize(onDrag: (event: globalThis.MouseEvent) => void) {
  const [isResizing, setIsResizing] = useState(false);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  useEffect(() => {
    if (!isResizing) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (event: globalThis.MouseEvent) => {
      onDragRef.current(event);
    };
    const onMouseUp = () => setIsResizing(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  return [isResizing, setIsResizing] as const;
}
