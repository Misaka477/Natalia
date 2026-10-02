import { expect, test } from "bun:test";
import { createFakeBackend } from "../src/fixture";

test("local fixture transport exposes runtime client boundary", async () => {
  const client = createFakeBackend();
  const events: string[] = [];
  client.start((event) => events.push(event.type));
  await client.submit("/modal");
  expect(events).toContain("session.created");
  expect(events).toContain("approval.request");
  expect(events).toContain("question.request");
});
