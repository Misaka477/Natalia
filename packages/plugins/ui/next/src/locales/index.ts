import { zh, type CommonKey } from "./zh";
import { en } from "./en";

export { zh, type CommonKey } from "./zh";
export { en } from "./en";

export interface LanguagePack {
  readonly id: string;
  readonly label: string;
  readonly dictionary: Record<string, string>;
}

/**
 * Shipped language packs discovered by the locale runtime at startup. Adding a
 * new language file here registers its id, native label, and common dictionary
 * automatically without hardcoding language choices in UI components.
 */
export const SHIPPED_LANGUAGE_PACKS: readonly LanguagePack[] = Object.freeze([
  Object.freeze({ id: "zh-CN", label: "简体中文", dictionary: zh }),
  Object.freeze({ id: "en", label: "English", dictionary: en }),
]);
