import { describe, expect, test } from "bun:test";
import {
  classifyPermissionFamily,
  PERMISSION_FAMILIES,
} from "../src/permission-families";

describe("permission families", () => {
  test("separates filesystem reads from writes", () => {
    expect(classifyPermissionFamily("read_file").id).toBe("filesystem-read");
    expect(classifyPermissionFamily("grep").id).toBe("filesystem-read");
    expect(classifyPermissionFamily("write_file").id).toBe("filesystem-write");
    expect(classifyPermissionFamily("apply_edits").id).toBe("filesystem-write");
  });

  test("groups terminal operations across terminal IDs and risk levels", () => {
    expect(classifyPermissionFamily("interactive_terminal_start")).toEqual(
      PERMISSION_FAMILIES.interactiveTerminal,
    );
    expect(classifyPermissionFamily("interactive_terminal_keys")).toEqual(
      PERMISSION_FAMILIES.interactiveTerminal,
    );
    expect(classifyPermissionFamily("terminal_observe")).toEqual(
      PERMISSION_FAMILIES.interactiveTerminal,
    );
  });

  test("returns copies so consumers cannot mutate the shared catalog", () => {
    const classified = classifyPermissionFamily("write_file");
    classified.scope = "changed by consumer";
    expect(PERMISSION_FAMILIES.filesystemWrite.scope).toBe(
      "All filesystem write tools in this session",
    );
  });

  test("does not group unknown plugin tools by plugin owner", () => {
    expect(classifyPermissionFamily("plugin_read", "plugin:demo").id).toBe(
      "tool:plugin_read",
    );
    expect(classifyPermissionFamily("plugin_write", "plugin:demo").id).toBe(
      "tool:plugin_write",
    );
  });

  test("uses known capability owners conservatively", () => {
    expect(
      classifyPermissionFamily("background_start", "natalia-tool-process").id,
    ).toBe("managed-process");
    expect(classifyPermissionFamily("custom", "natalia-tool-web").id).toBe(
      "network",
    );
    expect(classifyPermissionFamily("custom", "natalia-tool-fs").id).toBe(
      "tool:custom",
    );
  });

  test("groups every approval-requiring built-in workflow family", () => {
    expect(classifyPermissionFamily("sandbox_execute").id).toBe("sandbox");
    expect(classifyPermissionFamily("sandbox_merge").id).toBe("sandbox");
    expect(classifyPermissionFamily("plan").id).toBe("planning");
    expect(classifyPermissionFamily("todo_write").id).toBe("planning");
    expect(classifyPermissionFamily("skill_load").id).toBe("skills");
  });
});
