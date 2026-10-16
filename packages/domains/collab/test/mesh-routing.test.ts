/**
 * The collaboration graph is a full MESH (the 2026-10-13 user ruling; audit
 * item 11): any agent may send to any agent, and the ONLY excluded pair is a
 * message to itself — a no-op that would wake the sender for nothing.
 *
 * The two halves the ruling names are pinned here from the source, because the
 * behavior needs three live agents in one session to exercise:
 *
 *   1. `to` = every participant EXCEPT the sender (the mesh), refused when it
 *      names the sender;
 *   2. the wake follows the chosen recipient (`live_chat` gets Navi's wake,
 *      `nia` gets hers) — cross-agent, not always-the-main-agent.
 *
 * The comment that documents the ruling lives in `collaboration-tools.ts`
 * (the main agent's side); this file is the sisters' side, where the mesh work
 * was: their chat tool had no `to` at all and could only reach the main agent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(
  join(import.meta.dir, "..", "src", "mailbox-plans.ts"),
  "utf8",
);

describe("the mesh routing", () => {
  test("the sender's own address is the only pair the mesh drops", () => {
    expect(source).toContain("(participant) => participant !== sender");
    expect(source).toContain("cannot send to yourself");
  });

  test("the tool's `to` enumerates that mesh, not a fixed sister", () => {
    expect(source).toContain("enum: [...meshRecipients]");
    // The description says it in words the model reads.
    expect(source).toContain("The full mesh: any agent can send any agent");
    // The main agent's OWN tool excludes itself (it addresses the sisters):
    // that enum lives in collaboration-tools.ts and is the two sisters.
    const tools = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "framework",
        "collaboration",
        "src",
        "collaboration-tools.ts",
      ),
      "utf8",
    );
    expect(tools).toContain('COLLAB_CHAT_RECIPIENTS = ["live_chat", "nia"]');
    expect(tools).toContain("the mesh excludes");
  });

  test("the wake follows the recipient — cross-agent, not to main by default", () => {
    // Both sibling recipients have their own wake branch, and the service's
    // default (no `to`) is what decides where an OMINED one lands.
    expect(source).toContain('result.wake.recipient === "live_chat"');
    expect(source).toContain('result.wake.recipient === "nia"');
    const service = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "framework",
        "collaboration",
        "src",
        "collaboration-service.ts",
      ),
      "utf8",
    );
    expect(service).toContain(
      'input.from === "main_agent" ? "live_chat" : "main_agent"',
    );
  });
});
