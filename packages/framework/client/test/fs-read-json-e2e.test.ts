// A: read_file on a JSON document must not fail the output-schema check.
//
// THE bug, in the user's own words:
//   tool "read_file" returned output that does not match its declared schema:
//   value.$schema: unexpected property ... value.content: missing required
//   property "content"
//
// Root cause: the execution boundary handed read_file's CONTENT string to
// validateToolOutput, which JSON.parses it and matches the tool's declared
// `{content: string}`. Reading a package.json therefore compared the FILE's
// JSON against the tool's schema, so every key in the file became an
// "unexpected property" and the tool's own field was "missing".
//
// This is the regression test for that: drive a real turn that reads a real
// JSON file, through the real execution boundary, and assert it SUCCEEDS.
// Before the fix the failure was `status=failed` with exactly the message above.
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createRealRuntimeClient } from "./real-runtime-harness";
// `officialPluginWorkspace`, NOT node:fs/promises' mkdtemp: the harness aliases
// it AS mkdtemp so a test reaching for "mkdtemp" gets a workspace with the
// official plugins provisioned. The raw one gives no plugin store, and every
// tool call then fails with "Unknown tool" — four rounds lost to that.
import { officialPluginWorkspace as mkdtemp } from "./plugin-test-helpers";

const JSON_FILE = "probe-package.json";
const JSON_BODY = JSON.stringify(
  {
    $schema: "https://json.schemastore.org/package.json",
    name: "@probe/fixture",
    version: "9.9.9",
    private: true,
    type: "module",
    license: "MIT",
    workspaces: ["packages/*"],
    scripts: { build: "bun run build" },
    dependencies: { "@anthelia/contracts": "workspace:*" },
    devDependencies: { bun: "1.4.0" },
  },
  null,
  2,
);

test("read_file on a JSON document succeeds instead of failing its output schema", async () => {
  const root = await mkdtemp("fs-read-json");
  await writeFile(join(root, JSON_FILE), JSON_BODY, "utf8");
  await mkdir(join(root, ".natalia"), { recursive: true });

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_fs_read_json",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "read-json-1",
                name: "read_file",
                arguments: JSON.stringify({ path: JSON_FILE }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "read it" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event), { replay: "none" });
  await client.submitAndWait!("read the JSON fixture");

  const forRead = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" && event.name === "read_file",
  );
  const done = forRead.at(-1);
  expect(done).toBeDefined();
  // THE assertion. The failing message named every key of the JSON document as
  // an unexpected property, so a regression shows up here with that text.
  expect(
    done!.status,
    `read_file ended as ${done!.status}: ${done!.summary ?? ""}`,
  ).toBe("succeeded");
  // And the document's own content came back. read_file returns the kernel's
  // string contract, and since the windowing round its text IS a JSON envelope
  // carrying the page plus the window facts (`content`, `totalLines`,
  // `truncated`) — the same shape glob and grep use. Pinning the bare document
  // here pinned an implementation detail of a tool this test does not own;
  // what it does own is that the document's text survives the round trip.
  const envelope = JSON.parse(done!.result) as {
    content?: string;
    totalLines?: number;
    truncated?: boolean;
  };
  expect(envelope.content).toContain('"@probe/fixture"');
  expect(envelope.content).toContain('"workspaces"');
  expect(envelope.totalLines).toBe(20);
  expect(envelope.truncated).toBe(false);

  await client.dispose?.();
});
