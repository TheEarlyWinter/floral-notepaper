export type FileSrcConverter = (path: string) => string;

const NOTE_IMAGE_PREFIX = "images/";

function decodePathSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve a Markdown-relative asset without letting `..` leave the folder the
 * user explicitly opened. External URLs, fragments, and absolute paths stay
 * under browser/Markdown handling instead of being granted asset-protocol access.
 */
function resolveExternalRelativeImagePath(baseDir: string, src: string): string | null {
  const normalizedSrc = decodePathSafely(src.replace(/\\/g, "/"));
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(normalizedSrc)) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalizedSrc.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return null;
  return `${baseDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${segments.join("/")}`;
}

export function resolveMarkdownImageSrc(
  src: string | undefined,
  imageBaseDir: string | undefined,
  convertFileSrc: FileSrcConverter,
  externalImageBaseDir?: string,
): string {
  if (!src) {
    return "";
  }

  if (externalImageBaseDir) {
    const externalPath = resolveExternalRelativeImagePath(externalImageBaseDir, src);
    if (externalPath) return convertFileSrc(externalPath);
  }

  const normalizedSrc = src.replace(/\\/g, "/");
  if (!imageBaseDir || !normalizedSrc.startsWith(NOTE_IMAGE_PREFIX)) {
    return src;
  }

  return convertFileSrc(`${imageBaseDir}/${normalizedSrc}`);
}
