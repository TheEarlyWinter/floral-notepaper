export interface FindMatch {
  start: number;
  end: number;
  text: string;
}

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface FindResult {
  matches: FindMatch[];
  error: string | null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchPattern(query: string, options: FindOptions, sticky = false): RegExp {
  const source = options.regex ? query : escapeRegExp(query);
  const flags = `${options.caseSensitive ? "" : "i"}${sticky ? "y" : "g"}`;
  return new RegExp(source, flags);
}

export function findMatches(content: string, query: string, options: FindOptions): FindResult {
  if (!query) {
    return { matches: [], error: null };
  }

  let pattern: RegExp;
  try {
    pattern = buildSearchPattern(query, options, false);
  } catch (error) {
    return {
      matches: [],
      error: error instanceof Error ? error.message : "Invalid regular expression",
    };
  }

  const matches: FindMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[0].length === 0) {
      // Zero-width regexes (e.g., `^`, `a*`, `\b`) would otherwise loop forever on the same index.
      if (pattern.lastIndex >= content.length) {
        break;
      }
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }

  return { matches, error: null };
}

export function findInitialMatchIndex(matches: FindMatch[], cursorOffset: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((match) => match.start >= cursorOffset);
  return index >= 0 ? index : 0;
}

export function stepMatchIndex(currentIndex: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) {
    return direction === 1 ? 0 : total - 1;
  }
  return (((currentIndex + direction) % total) + total) % total;
}

function expandRegexReplacement(
  content: string,
  match: FindMatch,
  query: string,
  replacement: string,
  caseSensitive: boolean,
): string {
  if (!replacement.includes("$")) {
    return replacement;
  }

  let execResult: RegExpExecArray | null = null;
  try {
    const sticky = buildSearchPattern(query, { caseSensitive, regex: true }, true);
    sticky.lastIndex = match.start;
    execResult = sticky.exec(content);
  } catch {
    return replacement;
  }

  if (!execResult) {
    return replacement;
  }

  let output = "";
  for (let i = 0; i < replacement.length; i += 1) {
    const ch = replacement[i];
    if (ch !== "$" || i + 1 >= replacement.length) {
      output += ch;
      continue;
    }

    const next = replacement[i + 1];
    if (next === "$") {
      output += "$";
      i += 1;
      continue;
    }
    if (next === "&") {
      output += execResult[0];
      i += 1;
      continue;
    }
    if (next === "`") {
      output += content.slice(0, match.start);
      i += 1;
      continue;
    }
    if (next === "'") {
      output += content.slice(match.end);
      i += 1;
      continue;
    }
    if (next === "<") {
      const closeIdx = replacement.indexOf(">", i + 2);
      if (closeIdx > i + 2) {
        const groupName = replacement.slice(i + 2, closeIdx);
        output += execResult.groups?.[groupName] ?? "";
        i = closeIdx;
        continue;
      }
    }
    if (next >= "0" && next <= "9") {
      const twoDigits = replacement.slice(i + 1, i + 3);
      if (twoDigits.length === 2 && twoDigits[1] >= "0" && twoDigits[1] <= "9") {
        const idx2 = Number(twoDigits);
        if (idx2 >= 1 && idx2 < execResult.length) {
          output += execResult[idx2] ?? "";
          i += 2;
          continue;
        }
      }
      const idx1 = Number(next);
      if (idx1 >= 1 && idx1 < execResult.length) {
        output += execResult[idx1] ?? "";
        i += 1;
        continue;
      }
    }

    output += "$";
  }

  return output;
}

export function replaceMatchAt(
  content: string,
  matches: FindMatch[],
  activeIndex: number,
  query: string,
  replacement: string,
  options: FindOptions,
): { nextContent: string; replaced: boolean; replacedEndOffset: number } {
  if (activeIndex < 0 || activeIndex >= matches.length) {
    return { nextContent: content, replaced: false, replacedEndOffset: 0 };
  }

  const match = matches[activeIndex];
  const substitute = options.regex
    ? expandRegexReplacement(content, match, query, replacement, options.caseSensitive)
    : replacement;

  const nextContent = content.slice(0, match.start) + substitute + content.slice(match.end);
  return {
    nextContent,
    replaced: true,
    replacedEndOffset: match.start + substitute.length,
  };
}

export function replaceAllMatches(
  content: string,
  query: string,
  replacement: string,
  options: FindOptions,
): { nextContent: string; count: number; error: string | null } {
  const { matches, error } = findMatches(content, query, options);
  if (error || matches.length === 0) {
    return { nextContent: content, count: 0, error };
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(content.slice(cursor, match.start));
    const substitute = options.regex
      ? expandRegexReplacement(content, match, query, replacement, options.caseSensitive)
      : replacement;
    parts.push(substitute);
    cursor = match.end;
  }
  parts.push(content.slice(cursor));

  return {
    nextContent: parts.join(""),
    count: matches.length,
    error: null,
  };
}

export function selectAndScrollTextareaMatch(
  textarea: HTMLTextAreaElement | null,
  match: FindMatch | undefined,
): void {
  if (!textarea || !match) return;
  textarea.setSelectionRange(match.start, match.end);

  const computed = typeof getComputedStyle === "function" ? getComputedStyle(textarea) : null;
  const parsedLineHeight = computed ? Number.parseFloat(computed.lineHeight) : Number.NaN;
  const lineHeight =
    Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : 22;

  const line = textarea.value.slice(0, match.start).split("\n").length - 1;
  const targetTop = line * lineHeight;
  const viewTop = textarea.scrollTop;
  const viewHeight = textarea.clientHeight;
  if (viewHeight > 0) {
    const viewBottom = viewTop + viewHeight;
    if (targetTop < viewTop + lineHeight || targetTop > viewBottom - lineHeight * 2) {
      textarea.scrollTop = Math.max(0, targetTop - viewHeight / 3);
    }
  }
}
