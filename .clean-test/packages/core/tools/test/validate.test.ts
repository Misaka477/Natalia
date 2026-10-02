import { expect, test } from "bun:test";
import { validateToolParameters } from "../src";

test("nested array items and object properties report a readable path", () => {
  const schema = {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["pending", "done"] },
            count: { type: "integer", minimum: 1 },
          },
          required: ["status"],
        },
      },
    },
    required: ["items"],
  };

  expect(
    validateToolParameters(schema, {
      items: [{ status: "pending", count: 2 }],
    }),
  ).toEqual([]);

  expect(
    validateToolParameters(schema, {
      items: [{ status: "bad" }, { count: 0 }],
    }),
  ).toEqual([
    { path: "items[0].status", message: "expected one of: pending, done" },
    { path: "items[1].status", message: 'missing required property "status"' },
    { path: "items[1].count", message: "must be at least 1" },
  ]);
});
