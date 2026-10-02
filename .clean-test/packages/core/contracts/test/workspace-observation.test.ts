import { expect, test } from "bun:test";
import {
  confirmedWorkspaceChangeSchema,
  workspaceCorrelationSchema,
  workspaceObservationSchema,
} from "../src/workspace-observation";

const observation = {
  id: "obs_1",
  workspaceRoot: "/srv/project",
  path: "src/app.ts",
  operation: "modified",
  health: "healthy",
  at: "2026-08-13T00:00:00.000Z",
} as const;

test("a secret-safe observation parses", () => {
  expect(workspaceObservationSchema.parse(observation)).toMatchObject({
    id: "obs_1",
    path: "src/app.ts",
    operation: "modified",
    health: "healthy",
    indeterminate: false,
  });
});

test("an observation carries correlation and health reason when present", () => {
  expect(
    workspaceObservationSchema.parse({
      ...observation,
      health: "degraded",
      healthReason: "inotify_limit",
      indeterminate: true,
      correlation: {
        sessionID: "ses_1",
        episodeID: "epi_1",
        operationID: "op_1",
      },
    }),
  ).toMatchObject({
    health: "degraded",
    healthReason: "inotify_limit",
    indeterminate: true,
    correlation: { operationID: "op_1" },
  });
});

test("the health vocabulary is closed", () => {
  for (const value of ["healthy", "degraded", "unavailable"] as const) {
    expect(
      workspaceObservationSchema.safeParse({ ...observation, health: value })
        .success,
    ).toBe(true);
  }
  expect(
    workspaceObservationSchema.safeParse({ ...observation, health: "bogus" })
      .success,
  ).toBe(false);
});

test("a confirmed change parses with every origin and attribution", () => {
  const base = {
    id: "chg_1",
    workspaceRoot: "/srv/project",
    path: "src/app.ts",
    operation: "modified",
    correlation: {},
    health: "healthy",
    at: "2026-08-13T00:00:00.000Z",
  } as const;
  for (const origin of [
    "tool",
    "sandbox_merge",
    "checkpoint_rollback",
    "external",
    "unknown",
  ] as const) {
    for (const attribution of [
      "attributed",
      "unattributed",
      "indeterminate",
    ] as const) {
      const parsed = confirmedWorkspaceChangeSchema.parse({
        ...base,
        origin,
        attribution,
      });
      expect(parsed.origin).toBe(origin);
      expect(parsed.attribution).toBe(attribution);
    }
  }
});

test("a turn identity requires callID", () => {
  expect(workspaceCorrelationSchema.safeParse({ turnID: "t_1" }).success).toBe(
    false,
  );
  expect(
    workspaceCorrelationSchema.safeParse({
      turnID: "t_1",
      callID: "c_1",
    }).success,
  ).toBe(true);
});

test("turn and operation identities are mutually exclusive", () => {
  expect(
    workspaceCorrelationSchema.safeParse({
      turnID: "t_1",
      callID: "c_1",
      operationID: "op_1",
    }).success,
  ).toBe(false);
});

test("an empty correlation is a valid external change", () => {
  expect(workspaceCorrelationSchema.parse({})).toEqual({});
});

test("the confirmed change schema rejects free-text origin", () => {
  expect(
    confirmedWorkspaceChangeSchema.safeParse({
      id: "chg_2",
      workspaceRoot: "/srv/project",
      path: "a.txt",
      operation: "added",
      origin: "my custom tool",
      attribution: "attributed",
      correlation: {},
      health: "healthy",
      at: "2026-08-13T00:00:00.000Z",
    }).success,
  ).toBe(false);
});
