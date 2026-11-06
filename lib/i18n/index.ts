import english from "./en-US.json";

export const locales = ["zh-CN", "en-US"] as const;
export type Locale = (typeof locales)[number];
export const LOCALE_COOKIE = "messenger_locale";
export const DEFAULT_LOCALE: Locale = "zh-CN";
export type Translator = ((message: string, values?: Record<string, string | number>) => string) & { locale: Locale };

export function resolveLocale(value: string | undefined): Locale {
  return value === "en-US" ? "en-US" : DEFAULT_LOCALE;
}

const translations: Record<string, string> = english;

/** Source-language keys keep existing Chinese copy readable and serve as the fallback. */
export function createTranslator(locale: Locale): Translator {
  return Object.assign((message: string, values?: Record<string, string | number>) => {
    const translated = locale === "en-US" ? (Object.hasOwn(translations, message) ? translations[message] : message) : message;
    return values ? translated.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values[key] ?? placeholder)) : translated;
  }, { locale });
}
