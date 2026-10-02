import { expect, test } from "bun:test";
import { workspaceCorrelationSchema } from "@anthelia/contracts";
import {
  assertSecretSafeObservation,
  attributionFor,
  observationHealth,
  operationCorrelation,
  turnCorrelation,
} from "../src/workspace-observation";

test("the secret-safe guard rejects content and command fields", () => {
  for (const forbidden of [
    "content",
    "diff",
    "patch",
    "command",
    "args",
    "arguments",
    "result",
    "output",
    "thinking",
    "reasoning",
    "context",
    "error",
    "stderr",
    "stdout",
  ]) {
    expect(() =>
      assertSecretSafeObservation({ path: "a.txt", [forbidden]: "x" }),
    ).toThrow(`forbidden field: ${forbidden}`);
  }
});

test("the secret-safe guard accepts only contract fields", () => {
  expect(() =>
    assertSecretSafeObservation({
      id: "obs_1",
      workspaceRoot: "/srv/project",
      path: "a.txt",
      operation: "modified",
      health: "healthy",
      at: "2026-08-13T00:00:00.000Z",
    }),
  ).not.toThrow();
});

test("health carries an optional reason", () => {
  expect(observationHealth("healthy")).toEqual({ status: "healthy" });
  expect(observationHealth("degraded", "inotify_limit")).toEqual({
    status: "degraded",
    reason: "inotify_limit",
  });
});

test("turn correlation requires turnID and callID together", () => {
  const correlation = turnCorrelation({
    sessionID: "ses_1",
    episodeID: "epi_1",
    turnID: "t_1",
    callID: "c_1",
  });
  expect(workspaceCorrelationSchema.parse(correlation)).toMatchObject({
    turnID: "t_1",
    callID: "c_1",
  });
});

test("operation correlation uses the non-turn identity", () => {
  const correlation = operationCorrelation({
    sessionID: "ses_1",
    operationID: "op_1",
  });
  expect(workspaceCorrelationSchema.parse(correlation)).toMatchObject({
    operationID: "op_1",
  });
});

test("attribution is never forced without a reliable identity", () => {
  expect(
    attributionFor("tool", { hasReliableIdentity: true, indeterminate: false }),
  ).toBe("attributed");
  expect(
    attributionFor("tool", {
      hasReliableIdentity: false,
      indeterminate: false,
    }),
  ).toBe("unattributed");
  expect(
    attributionFor("external", {
      hasReliableIdentity: true,
      indeterminate: false,
    }),
  ).toBe("unattributed");
  expect(
    attributionFor("tool", { hasReliableIdentity: true, indeterminate: true }),
  ).toBe("indeterminate");
});
