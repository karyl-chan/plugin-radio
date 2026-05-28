/**
 * Server-side i18n for Discord-facing replies.
 *
 * Pattern mirrors plugin-quest-game / plugin-xiangqi: a flat dotted-key
 * dictionary per locale, hand-written `{var}` substitution, type-checked
 * key names via `LocaleKey` (= `keyof typeof en`). No i18next dep.
 *
 * Locale resolution: `ctx.locale → ctx.guildLocale → "en"`. Both fields
 * are BCP-47 tags as Discord sends them (`zh-TW`, `en-US`, `ja`, …); the
 * `normalizeTag` step collapses them to one of `en` / `zh-TW` / `zh-CN`.
 *
 * The plugin frontend keeps its own (vue-i18n) i18n setup at `web/src/`
 * — out of scope for this module.
 */
import { en, type LocaleKey } from "./en.js";

/**
 * Hand-rolled mirror of discord-api-types' `LocalizationMap` so this
 * module doesn't have to take a peer dep on it. Discord accepts any
 * BCP-47 tag as the key; we only ever emit the three we ship — `en-US`,
 * `zh-TW`, `zh-CN` — so the value side is required, not optional.
 */
export type LocalizationMap = Partial<Record<string, string | null>>;
import { zhTW } from "./zh-TW.js";
import { zhCN } from "./zh-CN.js";

export const SUPPORTED_LOCALES = ["en", "zh-TW", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: Locale = "en";

export const DICTIONARIES: Record<Locale, Record<LocaleKey, string>> = {
  en,
  "zh-TW": zhTW,
  "zh-CN": zhCN,
};

function isSupportedLocale(tag: string): tag is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(tag);
}

/**
 * Map an arbitrary BCP-47 tag (Discord sends `en-US`, `zh-TW`, `ja`, …)
 * to one of our supported locales, or null if it doesn't map to any.
 * Script subtags (Hant/Hans) take precedence over region heuristics.
 */
function normalizeTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  if (isSupportedLocale(tag)) return tag;
  const n = tag.toLowerCase();
  if (n.startsWith("en")) return "en";
  if (n.startsWith("zh")) {
    if (n.includes("hant") || /-(tw|hk|mo)\b/.test(n)) return "zh-TW";
    if (n.includes("hans") || /-(cn|sg|my)\b/.test(n)) return "zh-CN";
    return "zh-CN"; // bare "zh" — default to Simplified
  }
  return null;
}

/**
 * Resolve a plugin-SDK context (or anything with `locale` /
 * `guildLocale` fields) to one of our supported locales.
 *
 * Fallback chain:
 *   1. ctx.locale (user's Discord client locale)
 *   2. ctx.guildLocale (server preferred locale, if any)
 *   3. "en"
 */
export function resolveLocale(ctx: {
  locale?: string | null;
  guildLocale?: string | null;
}): Locale {
  const fromUser = normalizeTag(ctx.locale);
  if (fromUser) return fromUser;
  const fromGuild = normalizeTag(ctx.guildLocale);
  if (fromGuild) return fromGuild;
  return DEFAULT_LOCALE;
}

/**
 * Translate `key` for `locale`, substituting `{name}` placeholders from
 * `vars`. Missing keys log a console warning and return the key itself
 * (loud but non-fatal — a slash command should still reply).
 */
export function t(
  locale: Locale | undefined,
  key: LocaleKey,
  vars: Record<string, string | number> = {},
): string {
  const dict = DICTIONARIES[locale ?? DEFAULT_LOCALE];
  let value: string | undefined = dict[key];
  if (value === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
    value = DICTIONARIES[DEFAULT_LOCALE][key];
    if (value === undefined) return key;
  }
  return interpolate(value, vars);
}

function interpolate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

/**
 * Build a Discord `LocalizationMap` for `key` covering every supported
 * locale. Use on slash-command / option / choice definitions as
 * `description_localizations: localizedDescriptions("cmd.foo.description")`.
 *
 * Discord uses `en-US` (not `en`) as its English key — expanded on the
 * way out.
 */
export function localizedDescriptions(
  key: LocaleKey,
  vars: Record<string, string | number> = {},
): LocalizationMap {
  return {
    "en-US": t("en", key, vars),
    "zh-TW": t("zh-TW", key, vars),
    "zh-CN": t("zh-CN", key, vars),
  } as LocalizationMap;
}

/**
 * Canonical English string for `key` — paired with
 * `localizedDescriptions` so one source feeds both the `description`
 * (canonical) and `description_localizations` (map) fields of a
 * Discord ApplicationCommand definition.
 */
export function describeEn(
  key: LocaleKey,
  vars: Record<string, string | number> = {},
): string {
  return t("en", key, vars);
}

export type { LocaleKey };
