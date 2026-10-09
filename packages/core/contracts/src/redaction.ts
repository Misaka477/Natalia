/**
 * Credential redaction for anything that reaches a READABLE surface.
 *
 * The 2026-10-08 audit's P0-1: a generation/verification snapshot wrote a
 * config into a workspace Markdown file, and the file carried three live
 * `apiKey` values. `security.redactToolOutput` had not saved it — that flag
 * protects the TOOL OUTPUT layer, and the snapshot was a FILE, so the
 * credentials landed on disk where the flag never looked.
 *
 * Two disciplines live here, and both are needed:
 *
 * 1. `redactCredentials` — the text a human or a model reads never carries a
 *    credential value. It handles the shapes this product actually writes:
 *    `key: value`, `key=value`, and the JSON `"key": "value"` a stringified
 *    config produces. (The old tool-output regex matched only the first two,
 *    which is why a JSON config slipped through.)
 * 2. `containsCredentials` — the SELF-CHECK GATE. A writer that must not
 *    persist a credential asks this BEFORE writing and refuses when it is
 *    true, so a new surface cannot quietly reintroduce the hole.
 */

/** The key names whose values are credentials, in this product's spellings. */
const CREDENTIAL_KEY =
  "api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|token|secret|password|passphrase|credentials?";

/** The JSON shape a stringified config produces: `"apiKey": "sk-…"`. */
const QUOTED_ASSIGNMENT = new RegExp(
  `(["'])(${CREDENTIAL_KEY})\\1\\s*:([^"']*)(["'])[^"']*\\4`,
  "giu",
);

/** The bare shapes a shell-ish text produces: `apiKey=…`, `api_key: …`. */
const BARE_ASSIGNMENT = new RegExp(
  `\\b(${CREDENTIAL_KEY})(\\s*[:=]\\s*)[^\\s"',]+`,
  "giu",
);

/** An HTTP authorization header, the way a provider's requestDefaults carries one. */
const AUTHORIZATION_HEADER = /\bauthorization\s*:\s*\S+\s+\S+/giu;

/** What a redacted value reads as. */
const REDACTED = "[REDACTED]";

/**
 * The text with every credential value replaced. Idempotent: an already
 * redacted text is returned unchanged, so a caller can redact at several
 * layers without stacking markers.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(
      QUOTED_ASSIGNMENT,
      (_match, open: string, key: string, gap: string, close: string) =>
        `${open}${key}${open}:${gap}${close}${REDACTED}${close}`,
    )
    .replace(AUTHORIZATION_HEADER, (match) => {
      const at = match.indexOf(":");
      return `${match.slice(0, at + 1)} ${REDACTED}`;
    })
    .replace(
      BARE_ASSIGNMENT,
      (_match, key: string, gap: string) => `${key}${gap}${REDACTED}`,
    );
}

/** Whether this text still carries a credential value. */
export function containsCredentials(text: string): boolean {
  return redactCredentials(text) !== text;
}

/**
 * The self-check gate a writer calls before persisting a readable surface.
 *
 * Returns the redacted text when the surface was clean-or-cleanable, and a
 * refusal naming what was found when it was not — a caller that persists
 * without checking is the hole this closes.
 */
export function credentialSafeText(text: string): {
  ok: boolean;
  text: string;
  reason?: string;
} {
  const redacted = redactCredentials(text);
  if (!containsCredentials(redacted)) return { ok: true, text: redacted };
  return {
    ok: false,
    text: redacted,
    reason:
      "this surface still carries a credential after redaction — refusing to write it",
  };
}
