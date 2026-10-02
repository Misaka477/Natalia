import { expect, test } from "bun:test";
import { CapabilityRegistry } from "@anthelia/capability";
import type { PluginWorkspaceResource } from "@anthelia/plugin";
import {
  resolveNamedPluginWorkspaceResource,
  resolvePluginWorkspaceResource,
} from "../src/runtime/plugin-workspace-resources";

const resource: PluginWorkspaceResource = {
  name: "session-todo-store",
  kind: "workspace-file",
  access: "read",
  scope: "session",
  path: ".natalia/todos/{sessionID}.json",
};

function registryWithResource() {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner({
    id: "natalia-tool-todo",
    name: "Todo Tools",
    version: "1.0.0",
    scope: "session",
    grants: ["resources"],
  });
  const release = owner.contribute("resources", resource.name, resource);
  return { registry, owner, release };
}

test("a declared plugin workspace resource resolves for its current session", () => {
  const { registry } = registryWithResource();
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/todos/ses_current.json",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toEqual({
    pluginID: "natalia-tool-todo",
    contributionName: "session-todo-store",
    relativePath: ".natalia/todos/ses_current.json",
    access: "read",
  });
});

test("a declared resource does not resolve for another session or path", () => {
  const { registry } = registryWithResource();
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/todos/ses_other.json",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toBeUndefined();
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/todos/ses_current.json/extra",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toBeUndefined();
});

test("unloading the owning plugin removes the resource", () => {
  const { registry, release } = registryWithResource();
  release();
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/todos/ses_current.json",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toBeUndefined();
});

test("reserved or non-.natalia paths are not promoted to plugin resources", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner({
    id: "fixture.resources",
    name: "Fixture Resources",
    version: "1.0.0",
    scope: "session",
    grants: ["resources"],
  });
  owner.contribute("resources", "config", {
    name: "config",
    kind: "workspace-file",
    access: "read",
    scope: "session",
    path: ".natalia/config.json",
  } satisfies PluginWorkspaceResource);
  owner.contribute("resources", "outside", {
    name: "outside",
    kind: "workspace-file",
    access: "read",
    scope: "session",
    path: "src/{sessionID}.json",
  } satisfies PluginWorkspaceResource);

  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/config.json",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toBeUndefined();
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: "src/ses_current.json",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toBeUndefined();
});

test("named resource reads enforce reader allowlists and carry audit intent", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner({
    id: "natalia-tool-todo",
    name: "Todo Tools",
    version: "1.0.0",
    scope: "session",
    grants: ["resources"],
  });
  owner.contribute("resources", resource.name, {
    ...resource,
    readers: ["natalia.ui.todo"],
    audit: true,
  });

  expect(
    resolveNamedPluginWorkspaceResource({
      registry,
      resource: resource.name,
      params: { sessionID: "ses_current" },
      sessionID: "ses_current",
      reader: "natalia.ui.todo",
    }),
  ).toEqual({
    pluginID: "natalia-tool-todo",
    contributionName: resource.name,
    relativePath: ".natalia/todos/ses_current.json",
    access: "read",
    audit: true,
  });
  expect(
    resolveNamedPluginWorkspaceResource({
      registry,
      resource: resource.name,
      params: { sessionID: "ses_current" },
      sessionID: "ses_current",
      reader: "other.plugin",
    }),
  ).toBeUndefined();
});

test("reader-scoped resources are not exposed through the path surface", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner({
    id: "natalia-tool-todo",
    name: "Todo Tools",
    version: "1.0.0",
    scope: "session",
    grants: ["resources"],
  });
  owner.contribute("resources", resource.name, {
    ...resource,
    readers: ["natalia.ui.todo"],
  });
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/todos/ses_current.json",
      sessionID: "ses_current",
      access: "read",
    }),
  ).toBeUndefined();
});

test("named reads can fill plugin-declared path params safely", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner({
    id: "natalia-skills",
    name: "Skills",
    version: "1.0.0",
    scope: "workspace",
    grants: ["resources"],
  });
  const resourceName = "workspace-skill-document";
  owner.contribute("resources", resourceName, {
    name: resourceName,
    kind: "workspace-file",
    access: "read",
    scope: "workspace",
    params: ["skillName"],
    path: ".natalia/skills/{skillName}/SKILL.md",
    readers: ["natalia.ui.skills-settings"],
  });

  expect(
    resolveNamedPluginWorkspaceResource({
      registry,
      resource: resourceName,
      params: { skillName: "release" },
      reader: "natalia.ui.skills-settings",
    }),
  ).toMatchObject({
    pluginID: "natalia-skills",
    contributionName: resourceName,
    relativePath: ".natalia/skills/release/SKILL.md",
    access: "read",
  });
  expect(
    resolveNamedPluginWorkspaceResource({
      registry,
      resource: resourceName,
      params: { skillName: "../secret" },
      reader: "natalia.ui.skills-settings",
    }),
  ).toBeUndefined();
  expect(
    resolvePluginWorkspaceResource({
      registry,
      path: ".natalia/skills/release/SKILL.md",
      access: "read",
    }),
  ).toBeUndefined();
});
