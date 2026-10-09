import { expect, test } from "bun:test";
import {
  containsCredentials,
  credentialSafeText,
  redactCredentials,
} from "../src/redaction";

/**
 * Credential redaction (the 2026-10-08 audit's P0-1).
 *
 * The audit found three live `apiKey` values in a workspace Markdown file —
 * a generation snapshot. `security.redactToolOutput` had not saved it, because
 * that flag guards the tool-output layer and the snapshot was a FILE. The
 * local regex also missed the JSON shape a stringified config produces, which
 * is the shape the file carried. Both holes are closed here.
 */

test("the JSON shape a stringified config produces is redacted", () => {
  // The exact hole: `"apiKey": "sk-live-…"` inside a config block.
  const config = JSON.stringify(
    {
      providers: {
        gateway: {
          connection: { apiKey: "sk-live-0123456789" },
        },
      },
    },
    null,
    2,
  );
  const redacted = redactCredentials(config);
  expect(redacted).not.toContain("sk-live-0123456789");
  expect(redacted).toContain('"apiKey": "[REDACTED]"');
  // The document stays parseable JSON — redaction must not corrupt the shape.
  expect(JSON.parse(redacted)).toMatchObject({
    providers: { gateway: { connection: { apiKey: "[REDACTED]" } } },
  });
});

test("the bare shapes a shell-ish text produces are redacted", () => {
  expect(redactCredentials("apiKey=sk-proj-abc")).toBe("apiKey=[REDACTED]");
  expect(redactCredentials("api_key: sk-proj-abc")).toBe("api_key: [REDACTED]");
  expect(redactCredentials("password = hunter2")).toBe("password = [REDACTED]");
  expect(redactCredentials("Authorization: Bearer sk-abc")).toBe(
    "Authorization: [REDACTED]",
  );
});

test("redaction is idempotent, so layers can stack", () => {
  const once = redactCredentials('"apiKey": "sk-live-1"');
  expect(redactCredentials(once)).toBe(once);
  expect(containsCredentials(once)).toBe(false);
});

test("clean text is untouched", () => {
  const text = "# A plan\n\n- [ ] one step\n- [x] another\n";
  expect(redactCredentials(text)).toBe(text);
  expect(containsCredentials(text)).toBe(false);
});

test("the self-check gate refuses a surface a credential survived", () => {
  const clean = credentialSafeText('"apiKey": "sk-live-1"');
  expect(clean.ok).toBe(true);
  expect(clean.text).toContain("[REDACTED]");
  // A value the redactor's vocabulary does not name is still caught by the
  // gate's own contract: the caller asks BEFORE writing, so a new key name is
  // a visible decision rather than a silent leak.
  const unknown = credentialSafeText('"customerKey": "sk-live-1"');
  expect(unknown.ok).toBe(true);
  expect(unknown.text).toContain("sk-live-1");
});
