import { expect, test } from "bun:test";
import {
  isPluginWorkspaceResource,
  normalizePluginWorkspacePath,
  pluginWorkspaceResourcePath,
  type PluginWorkspaceResource,
} from "../src";

const validResource: PluginWorkspaceResource = {
  name: "session-todo-store",
  kind: "workspace-file",
  access: "read",
  scope: "session",
  path: ".natalia/todos/{sessionID}.json",
};

test("a valid plugin workspace resource declaration is recognized", () => {
  expect(isPluginWorkspaceResource(validResource)).toBe(true);
  expect(
    isPluginWorkspaceResource({
      ...validResource,
      readers: ["natalia.ui.todo"],
      audit: true,
    }),
  ).toBe(true);
});

test("plugin-declared params are accepted and resolved as single segments", () => {
  const resource = {
    ...validResource,
    name: "workspace-skill-document",
    scope: "workspace" as const,
    params: ["skillName"],
    path: ".natalia/skills/{skillName}/SKILL.md",
  };
  expect(isPluginWorkspaceResource(resource)).toBe(true);
  expect(pluginWorkspaceResourcePath(resource, { skillName: "release" })).toBe(
    ".natalia/skills/release/SKILL.md",
  );
  expect(pluginWorkspaceResourcePath(resource, {})).toBeUndefined();
  expect(
    pluginWorkspaceResourcePath(resource, { skillName: "../secret" }),
  ).toBeUndefined();
  expect(
    pluginWorkspaceResourcePath(resource, { skillName: "a/b" }),
  ).toBeUndefined();
});

test("invalid declared params are rejected", () => {
  for (const resource of [
    { ...validResource, params: "skillName" },
    { ...validResource, params: ["bad-name"] },
    { ...validResource, params: ["skillName", "skillName"] },
    { ...validResource, params: ["sessionID"] },
    {
      ...validResource,
      params: ["skillName"],
      path: ".natalia/skills/{other}/SKILL.md",
    },
  ])
    expect(isPluginWorkspaceResource(resource)).toBe(false);
});

test("invalid reader lists and audit flags are rejected", () => {
  expect(
    isPluginWorkspaceResource({ ...validResource, readers: ["ok", 1] }),
  ).toBe(false);
  expect(isPluginWorkspaceResource({ ...validResource, readers: [""] })).toBe(
    false,
  );
  expect(isPluginWorkspaceResource({ ...validResource, audit: "yes" })).toBe(
    false,
  );
});

test("unsafe or unsupported workspace resource templates are rejected", () => {
  for (const path of [
    "/absolute.json",
    "../outside.json",
    ".natalia/todos/*.json",
    ".natalia/todos/**",
    ".natalia/todos/{sessionID}/{unknown}.json",
    ".natalia/todos/{other}.json",
    ".natalia/todos//double.json",
  ])
    expect(isPluginWorkspaceResource({ ...validResource, path })).toBe(false);
});

test("resource path templates resolve only with safe trusted params", () => {
  expect(
    pluginWorkspaceResourcePath(validResource, { sessionID: "ses_current" }),
  ).toBe(".natalia/todos/ses_current.json");
  expect(pluginWorkspaceResourcePath(validResource, {})).toBeUndefined();
  expect(
    pluginWorkspaceResourcePath(validResource, { sessionID: "../secret" }),
  ).toBeUndefined();
  expect(
    pluginWorkspaceResourcePath(validResource, { sessionID: "a/b" }),
  ).toBeUndefined();
});

test("workspace path normalization keeps matching on a single POSIX shape", () => {
  expect(normalizePluginWorkspacePath("./.natalia//todos/x.json")).toBe(
    ".natalia/todos/x.json",
  );
  expect(normalizePluginWorkspacePath(".natalia/../x.json")).toBeUndefined();
  expect(normalizePluginWorkspacePath("/x.json")).toBeUndefined();
});
