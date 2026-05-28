/**
 * Completeness guard for the hand-written flat-dict i18n. Catches the
 * easy mistakes:
 *   1. zh-TW / zh-CN missing a key the English dict declares.
 *   2. zh-TW / zh-CN declaring an extra key (typo / dead translation).
 *   3. A translation that forgot to copy a `{var}` placeholder (a silent
 *      bug — the value renders but the variable disappears mid-sentence).
 *
 * Locales are added to `src/i18n/` as flat objects whose shape is pinned
 * to `LocaleKey` via TypeScript — so case (1) also fails the `pnpm tsc`
 * build. This test is the runtime cross-check and also asserts no extras
 * (which TS won't catch on a `Record<LocaleKey, string>`).
 */
import { describe, expect, it } from "vitest";
import { DICTIONARIES, SUPPORTED_LOCALES } from "../src/i18n/index.js";

const EN_KEYS = Object.keys(DICTIONARIES.en).sort();

describe("i18n dictionaries", () => {
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === "en") continue;
    it(`${locale} has the exact same key set as en`, () => {
      const keys = Object.keys(DICTIONARIES[locale]).sort();
      const missing = EN_KEYS.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !EN_KEYS.includes(k));
      expect(missing, `${locale} missing keys: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `${locale} extra keys: ${extra.join(", ")}`).toEqual([]);
    });

    it(`${locale} preserves all {var} placeholders from en`, () => {
      const offenders: string[] = [];
      for (const key of EN_KEYS) {
        const enVars = extractVars(DICTIONARIES.en[key as keyof typeof DICTIONARIES.en]);
        const locVars = extractVars(DICTIONARIES[locale][key as keyof typeof DICTIONARIES.en]);
        const missing = [...enVars].filter((v) => !locVars.has(v));
        if (missing.length > 0) {
          offenders.push(`${key} — missing {${missing.join("}, {")}}`);
        }
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});

function extractVars(template: string): Set<string> {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{(\w+)\}/g)) found.add(m[1]);
  return found;
}
