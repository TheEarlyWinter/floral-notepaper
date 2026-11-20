import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locale-whitelist";
import { resolvedTranslations, translationOverrides, type TranslationTree } from "./resources";

function collectLeafKeys(tree: TranslationTree, prefix = ""): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(tree)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      keys.push(nextPrefix);
      continue;
    }

    keys.push(...collectLeafKeys(value, nextPrefix));
  }

  return keys.sort();
}

describe("locale resources", () => {
  const sourceKeys = collectLeafKeys(translationOverrides[DEFAULT_LOCALE]);
  const sourceKeySet = new Set(sourceKeys);

  it("resolves every supported locale with complete source-locale coverage", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(collectLeafKeys(resolvedTranslations[locale])).toEqual(sourceKeys);
    }
  });

  it("keeps non-source locale overrides within the source-locale key set", () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) {
        continue;
      }

      for (const key of collectLeafKeys(translationOverrides[locale])) {
        expect(sourceKeySet.has(key)).toBe(true);
      }
    }
  });

  it("defines quickCapture, commandPalette, and quickCaptureShortcut keys directly in all locales", () => {
    const requiredNamespaces = ["quickCapture.", "commandPalette."];
    const requiredExact = new Set([
      "settings.quickCaptureShortcut",
      "settings.shortcut.forQuickCapture",
    ]);
    const requiredKeys = sourceKeys.filter(
      (key) => requiredExact.has(key) || requiredNamespaces.some((ns) => key.startsWith(ns)),
    );

    expect(requiredKeys.length).toBeGreaterThan(0);

    for (const locale of SUPPORTED_LOCALES) {
      const directKeys = new Set(collectLeafKeys(translationOverrides[locale]));
      for (const key of requiredKeys) {
        expect(directKeys.has(key), `Missing ${key} in ${locale}`).toBe(true);
      }
    }
  });
});
