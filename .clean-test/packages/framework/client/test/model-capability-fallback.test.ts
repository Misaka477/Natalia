import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The capability fallback, pinned across channels.
 *
 * When the selected model cannot be resolved (a catalog entry removed while a
 * session is open, a hand-edited config, a model id from another workspace),
 * every channel needs a fallback. The chat streams ask the ADAPTER
 * (`chatModelCapabilities` → `provider.imageInput`), which is the honest
 * source: the provider knows what it can send. The main channel hard-coded
 * `imageInput: false`, so an unresolvable model silently dropped every image
 * the turn was handed — the user saw an `[Attached image/png: …]` marker where
 * the picture should have been.
 *
 * This test pins that the two paths agree, and that the adapter is the one
 * consulted.
 */

const root = join(import.meta.dir, "..", "..", "..", "..");
function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

test("the main channel's fallback asks the adapter, not a hard-coded false", () => {
  const selection = source(
    "packages/framework/client/src/runtime/provider-selection.ts",
  );
  // The fallback must read the provider's declared capability.
  expect(selection).toMatch(/imageInput:\s*exec\?\.provider\?\.imageInput/u);
  expect(selection).toMatch(/videoInput:\s*exec\?\.provider\?\.videoInput/u);
  // And it must not carry the old unconditional false.
  expect(selection).not.toContain("imageInput: false,");
});

test("the chat streams' fallback already asks the adapter", () => {
  const common = source("packages/domains/collab/src/chat-turn-common.ts");
  expect(common).toContain("imageInput: provider.imageInput === true");
  expect(common).toContain("videoInput: provider.videoInput === true");
});

test("both fallbacks keep the call-and-reason capabilities on by default", () => {
  // Only the MEDIA capabilities are adapter-driven; a model we cannot resolve
  // still gets tool calling and reasoning, or a session would die on a catalog
  // edit. That half is deliberately symmetric.
  const selection = source(
    "packages/framework/client/src/runtime/provider-selection.ts",
  );
  expect(selection).toContain("toolCall: true");
  expect(selection).toContain("reasoning: true");
  expect(selection).toContain("thinking: true");
});
