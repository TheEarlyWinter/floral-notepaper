import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface SlidingButtonGroupProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
}

export function SlidingButtonGroup<T extends string>({
  options,
  value,
  onChange,
  className = "",
  buttonClassName = "h-7",
}: SlidingButtonGroupProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [animated, setAnimated] = useState(false);

  const updateHighlight = useCallback(() => {
    const btn = buttonsRef.current.get(value);
    if (!btn) return;
    setPos({
      left: btn.offsetLeft,
      top: btn.offsetTop,
      width: btn.offsetWidth,
      height: btn.offsetHeight,
    });
  }, [value]);

  useLayoutEffect(() => {
    updateHighlight();
    const frame = requestAnimationFrame(updateHighlight);
    const group = groupRef.current;
    if (!group) return () => cancelAnimationFrame(frame);

    const observer = new ResizeObserver(updateHighlight);
    observer.observe(group);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [updateHighlight, options]);

  useEffect(() => {
    requestAnimationFrame(() => setAnimated(true));
  }, []);

  const transition = animated
    ? "left 0.25s cubic-bezier(0.22,1,0.36,1), top 0.25s cubic-bezier(0.22,1,0.36,1), width 0.25s cubic-bezier(0.22,1,0.36,1), height 0.25s cubic-bezier(0.22,1,0.36,1)"
    : "none";

  return (
    <div
      ref={groupRef}
      className={`relative flex items-center gap-1 bg-paper-warm/60 rounded-lg p-[2px] border border-paper-deep/30 ${className}`}
    >
      <div
        className="absolute rounded-md bg-cloud shadow-[0_1px_2px_rgba(0,0,0,0.04)] pointer-events-none sliding-highlight"
        style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height, transition }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          ref={(el) => {
            if (el) buttonsRef.current.set(option.value, el);
            else buttonsRef.current.delete(option.value);
          }}
          type="button"
          onClick={() => onChange(option.value)}
          className={`relative z-[1] flex-1 rounded-md text-[11px] transition-colors duration-200 cursor-pointer ${buttonClassName} ${
            value === option.value
              ? "text-bamboo font-medium"
              : "text-ink-ghost hover:text-ink-faint"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
