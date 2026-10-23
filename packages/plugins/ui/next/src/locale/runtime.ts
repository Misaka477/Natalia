/**
 * Locale runtime: the shell's single source of truth for product copy.
 *
 * Every UI plugin package registers its own dictionaries under its own
 * namespace (`ensureRegistered("mcp", { "zh-CN": zh, en })`); the shell owns
 * the shared `common` namespace. A lookup walks the active language's
 * fallback chain inside the entry namespace, then repeats it in the
 * common namespace, and finally shows the key itself — a missing key is
 * visible in development rather than silently wrong.
 *
 * Reactivity is one signal: every bound translate function and `getLocale()`
 * read the revision, so a language switch re-renders every consumer in one
 * step (the shell and all loaded plugins switch together).
 */

import { createSignal } from "solid-js";
import { SHIPPED_LANGUAGE_PACKS } from "../locales";

export const LOCALE_IDS = ["zh-CN", "en"] as const;
export type LocaleId = string;

/** zh-CN is the dictionary source of truth, so it terminates every chain. */
export const FALLBACK_LOCALE: LocaleId = "zh-CN";

/** The preference key the selection persists under. */
export const LOCALE_PREFERENCE_KEY = "uiLanguage";

/** Namespace holding the shell's shared cross-feature vocabulary. */
export const COMMON_NS = "common";

export type LocaleDict = Record<string, string>;

export interface LocaleDefinition {
  readonly id: LocaleId;
  /** Display name written in the represented language. */
  readonly label: string;
}

export interface LocaleSnapshot {
  readonly active: LocaleId;
  readonly locales: readonly LocaleDefinition[];
  /** Monotonic counter; bumps on switch and on dictionary registration. */
  readonly revision: number;
}

/** The host preference surface the selection persists through. */
export interface LocalePreferenceStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  subscribe(listener: (key: string, value: unknown) => void): () => void;
}

const BUILT_IN_LOCALES: readonly LocaleDefinition[] = Object.freeze(
  SHIPPED_LANGUAGE_PACKS.map((pack) =>
    Object.freeze({ id: pack.id, label: pack.label }),
  ),
);

function localeKey(value: string): string {
  return value.toLowerCase();
}

/** Validate a built-in locale id at the static boundary. */
export function isLocaleId(value: unknown): value is LocaleId {
  return (
    typeof value === "string" &&
    BUILT_IN_LOCALES.some((locale) => locale.id === value)
  );
}

/** The browser's ordered language tags, with non-strings dropped. */
function browserLanguageTags(): string[] {
  const nav = navigator as {
    languages?: readonly unknown[];
    language?: unknown;
  };
  const tags = (nav.languages ?? []).filter(
    (tag): tag is string => typeof tag === "string",
  );
  if (typeof nav.language === "string") tags.push(nav.language);
  return tags;
}

/**
 * The first registered locale the browser asks for: an exact regional
 * match wins before a language-wide one.
 */
export function detectBrowserLocale(
  languages: readonly string[] | undefined,
  available: readonly LocaleDefinition[] = BUILT_IN_LOCALES,
): LocaleId | undefined {
  for (const tag of languages ?? []) {
    if (typeof tag !== "string") continue;
    const requested = localeKey(tag);
    const exact = available.find(
      (locale) => localeKey(locale.id) === requested,
    );
    if (exact) return exact.id;
    const primary = requested.split("-")[0];
    const match = available.find(
      (locale) => localeKey(locale.id).split("-")[0] === primary,
    );
    if (match) return match.id;
  }
  return undefined;
}

export class LocaleRuntime {
  private readonly dicts = new Map<string, Map<string, LocaleDict>>();
  private readonly bound = new Map<string, LocaleTranslate>();
  private readonly chains = new Map<string, readonly LocaleId[]>();
  private readonly listeners = new Set<() => void>();
  private readonly localeDefs = new Map<string, LocaleDefinition>();
  /** The reactivity seat: bound translate functions read it, so one
   *  switch re-renders every consumer. */
  private readonly revision = createSignal(0);
  private snapshot: LocaleSnapshot;

  constructor(private readonly host?: LocalePreferenceStore) {
    for (const def of BUILT_IN_LOCALES) {
      this.localeDefs.set(localeKey(def.id), def);
    }
    const stored = host?.get<unknown>(LOCALE_PREFERENCE_KEY);
    const browser =
      typeof navigator === "undefined"
        ? undefined
        : detectBrowserLocale(browserLanguageTags(), this.listLocaleDefs());
    const active =
      typeof stored === "string" && this.hasLocale(stored)
        ? stored
        : (browser ?? FALLBACK_LOCALE);
    this.snapshot = Object.freeze({
      active,
      locales: this.listLocaleDefs(),
      revision: 0,
    });
    host?.subscribe((key, value) => {
      if (
        key === LOCALE_PREFERENCE_KEY &&
        typeof value === "string" &&
        this.hasLocale(value)
      ) {
        this.adopt(value);
      }
    });
  }

  private listLocaleDefs(): readonly LocaleDefinition[] {
    return Object.freeze([...this.localeDefs.values()]);
  }

  private hasLocale(id: string): boolean {
    return this.localeDefs.has(localeKey(id));
  }

  /**
   * Register a discoverable language pack definition (id + native label).
   */
  defineLocale(definition: LocaleDefinition): void {
    const id = definition.id.trim();
    if (!id) throw new Error("locale definition requires a non-empty id");
    const frozen = Object.freeze({
      id,
      label: definition.label.trim() || id,
    });
    this.localeDefs.set(localeKey(id), frozen);
    this.publish(this.snapshot.active, false);
  }

  /** The current immutable snapshot (reactive in Solid render tracking). */
  getLocale(): LocaleSnapshot {
    this.revision[0]();
    return this.snapshot;
  }

  /** LocaleFace subscribe: notified on every snapshot change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Register one namespace's dictionaries, every shipped locale in one
   * call. A namespace's texts have one owner: a duplicate (namespace,
   * locale) throws. Registration bumps the revision so mounted consumers
   * pick up late-arriving dictionaries.
   */
  register(
    ns: string,
    dicts: Record<string, LocaleDict | undefined>,
  ): () => void {
    let locales = this.dicts.get(ns);
    if (!locales) {
      locales = new Map();
      this.dicts.set(ns, locales);
    }
    const pairs: [string, LocaleDict][] = Object.entries(dicts).map(
      ([locale, dict]) => [locale, dict as LocaleDict],
    );
    for (const [locale, dict] of pairs) {
      if (locales?.has(localeKey(locale))) {
        throw new Error(
          `locale namespace "${ns}" already has locale "${locale}"`,
        );
      }
      if (!dict || typeof dict !== "object") {
        throw new Error(
          `locale namespace "${ns}" has no dictionary for "${locale}"`,
        );
      }
    }
    for (const [locale, dict] of pairs) {
      locales?.set(localeKey(locale), dict);
    }
    this.publish(this.snapshot.active, false);
    return () => {
      const owner = this.dicts.get(ns);
      if (!owner) return;
      let removed = false;
      for (const [locale, dict] of pairs) {
        if (owner.get(localeKey(locale)) === dict) {
          owner.delete(localeKey(locale));
          removed = true;
        }
      }
      if (removed) this.publish(this.snapshot.active, false);
    };
  }

  /**
   * Idempotent dictionary registration for dynamically mounted plugin UIs:
   * merges or replaces the namespace's dictionaries without throwing on
   * remount.
   */
  ensureRegistered(
    ns: string,
    dicts: Record<string, LocaleDict | undefined>,
  ): void {
    let locales = this.dicts.get(ns);
    if (!locales) {
      locales = new Map();
      this.dicts.set(ns, locales);
    }
    let changed = false;
    for (const [locale, dict] of Object.entries(dicts)) {
      if (!dict || typeof dict !== "object") continue;
      if (locales.get(localeKey(locale)) !== dict) {
        locales.set(localeKey(locale), dict);
        changed = true;
      }
    }
    if (changed) this.publish(this.snapshot.active, false);
  }

  /**
   * Bind a namespace to a translate function. The returned reference is
   * stable per namespace and reads the revision at call time, so any
   * component that translates during render re-renders on a switch.
   */
  bind(ns: string): LocaleTranslate {
    let translate = this.bound.get(ns);
    if (!translate) {
      translate = (key, params) => {
        this.revision[0]();
        return this.translate(ns, key, params);
      };
      this.bound.set(ns, translate);
    }
    return translate;
  }

  /** The shell's own translate function, bound to the common namespace. */
  get t(): LocaleTranslate {
    return this.bind(COMMON_NS);
  }

  /**
   * Switch the active locale — the only user-preference write entry. The
   * durable write happens even when the id already matches, because the
   * active value may be a browser-derived resolution nothing has stored.
   */
  setLocale(id: string): void {
    const def = this.localeDefs.get(localeKey(id));
    if (!def) throw new Error(`locale "${id}" is not registered`);
    this.host?.set(LOCALE_PREFERENCE_KEY, def.id);
    this.adopt(def.id);
  }

  /** Adopt a selection without writing it back (a preference change). */
  private adopt(id: LocaleId): void {
    if (this.snapshot.active === id) return;
    this.publish(id, true);
  }

  private translate(
    ns: string,
    key: string,
    params?: Record<string, unknown>,
  ): string {
    const chain = this.chain(this.snapshot.active);
    const template =
      this.lookup(ns, key, chain) ??
      (ns === COMMON_NS ? undefined : this.lookup(COMMON_NS, key, chain)) ??
      key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  }

  private lookup(
    ns: string,
    key: string,
    chain: readonly LocaleId[],
  ): string | undefined {
    const locales = this.dicts.get(ns);
    for (const locale of chain) {
      const value = locales?.get(localeKey(locale))?.[key];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** The fallback chain for a locale, always terminating at the source. */
  private chain(start: LocaleId): readonly LocaleId[] {
    const cached = this.chains.get(start);
    if (cached) return cached;
    const chain: LocaleId[] = [start];
    if (start !== FALLBACK_LOCALE) chain.push(FALLBACK_LOCALE);
    const resolved = Object.freeze(chain);
    this.chains.set(start, resolved);
    return resolved;
  }

  private publish(active: LocaleId, changed: boolean): void {
    this.snapshot = Object.freeze({
      active,
      locales: this.listLocaleDefs(),
      revision: this.snapshot.revision + 1,
    });
    this.revision[1](this.snapshot.revision);
    this.syncDocumentLanguage();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        // One throwing subscriber must not strand the rest on a stale
        // revision (they would keep the previous language).
        console.error("locale subscriber crashed:", error);
      }
    }
    if (changed && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("natalia:locale-change", {
          detail: { locale: active },
        }),
      );
    }
  }

  /** Point `<html lang>` at the active locale. */
  private syncDocumentLanguage(): void {
    if (typeof document === "undefined") return;
    const language =
      this.snapshot.active === "zh-CN" ? "zh-CN" : this.snapshot.active;
    if (document.documentElement.lang !== language) {
      document.documentElement.lang = language;
    }
  }
}

/** A namespace-bound translate function with `{name}` interpolation. */
export type LocaleTranslate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

/** Create the shell's runtime: shipped language packs registered, preference wired. */
export function createLocaleRuntime(
  host?: LocalePreferenceStore,
): LocaleRuntime {
  const runtime = new LocaleRuntime(host);
  const dicts: Record<string, LocaleDict> = {};
  for (const pack of SHIPPED_LANGUAGE_PACKS) {
    runtime.defineLocale({ id: pack.id, label: pack.label });
    dicts[pack.id] = pack.dictionary;
  }
  runtime.register(COMMON_NS, dicts);
  return runtime;
}
