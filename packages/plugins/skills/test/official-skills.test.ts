import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { pluginManifestSchema, pluginSkillDir } from "@anthelia/plugin";
import { skillsInput } from "@anthelia/runtime-services";
import { discoverSkills, skillDigest } from "../src/skills";
import { SKILLS_PLUGIN_MANIFEST } from "../src/skills-plugin";

/**
 * The official skills: the three documents this package ships in its declared
 * skills directory, discovered as source "plugin".
 *
 * They exist so the model does not have to guess the framework's shape every
 * round — how a tool is registered and made reachable, how a framework change
 * is gated, and how one self-iteration runs. These tests are the guard on the
 * SHIPPING, not the prose: the declaration exists, the directory rides the
 * package, every document parses under the same bar a self-sedimented skill
 * must clear, and the exported manifest (what the installer validates against
 * the package manifest) still declares the same directory.
 */
const packageRoot = join(import.meta.dir, "..");
const officialSkillsDir = join(packageRoot, "skills");

/** The release shape of the package manifest (the UI entry is rewritten). */
async function releasePackageManifest() {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(
      await readFile(join(packageRoot, "natalia.plugin.json"), "utf8"),
    ),
  );
  if (manifest.apiVersion === 2)
    return {
      ...manifest,
      ui: { ...manifest.ui, entry: "ui/plugin.js" },
    };
  return manifest;
}

/** What the built entry exports as its manifest (index.ts's default export). */
function exportedManifest() {
  return pluginManifestSchema.parse({
    ...SKILLS_PLUGIN_MANIFEST,
    entry: "index.js",
    requires: [skillsInput.id],
  });
}

test("the package declares its skills directory, and the exported manifest agrees", async () => {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(
      await readFile(join(packageRoot, "natalia.plugin.json"), "utf8"),
    ),
  );
  // The declaration is what makes discovery walk this package at all.
  expect(pluginSkillDir(manifest)).toBe("skills");
  // The installer compares the built entry's exported manifest against the
  // package manifest byte for byte ("plugin entry manifest does not match
  // natalia.plugin.json"), so the two declarations cannot drift: a skills
  // directory declared in one place only is a plugin whose official skills
  // either never install or never appear.
  expect(exportedManifest()).toEqual(await releasePackageManifest());
});

test("every official skill parses under the bar a self-sedimented skill must clear", async () => {
  const registry = await discoverSkills({
    workspaceRoot: await mkdtemp(join(tmpdir(), "natalia-official-skills-")),
    pluginDirs: [officialSkillsDir],
  });
  const official = registry
    .list()
    .filter((skill) => skill.source === "plugin")
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(official.map((skill) => skill.name)).toEqual([
    "edit-framework",
    "evolve-artifact",
    "write-tool",
  ]);
  for (const skill of official) {
    // The frontmatter's name is the directory's name: discovery registers by
    // the declared name, so a mismatch is a skill the model cannot find by
    // the name it was told.
    expect(skill.qualifiedName).toBe(`plugin:${skill.name}`);
    expect(skill.description.length).toBeGreaterThan(0);
    // The necessity gate's bar (the same one self-review applies before any
    // write): a real body with a heading, not a stub. The official documents
    // are the examples the loop learns from — they clear their own gate.
    expect(skill.body.length).toBeGreaterThanOrEqual(200);
    expect(/^#{1,3}\s/mu.test(skill.body)).toBe(true);
    // The digest is the file's exact bytes, so a silent edit is visible.
    expect(skill.digest).toBe(
      skillDigest(await readFile(join(skill.root, "SKILL.md"), "utf8")),
    );
  }
});

test("the official skills ship with the plugin, so self-review cannot rewrite them", async () => {
  // The boundary's write path only writes the PROJECT root, and a plugin
  // source refuses removal — which is what keeps the official documents
  // official: the loop may sediment skills beside them, never over them.
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "natalia-official-skills-write-"),
  );
  try {
    const registry = await discoverSkills({
      workspaceRoot,
      pluginDirs: [officialSkillsDir],
    });
    const before = await readFile(
      join(officialSkillsDir, "write-tool", "SKILL.md"),
      "utf8",
    );
    // A plugin source refuses removal: the skill ships with the plugin, so
    // deleting it would be undone by the next reload (or would corrupt the
    // package).
    await expect(registry.removeSkill("write-tool")).rejects.toThrow(
      /cannot remove a plugin skill/u,
    );
    // An update aimed at the official name lands as a PROJECT skill (the
    // later source wins a name collision) — the precedence rule, not a
    // rewrite of the shipped file.
    await registry.upsertSkill({
      kind: "update",
      name: "write-tool",
      description: "shadow",
      content: "# shadow\n",
    });
    expect(
      existsSync(
        join(workspaceRoot, ".natalia", "skills", "write-tool", "SKILL.md"),
      ),
    ).toBe(true);
    // The shipped file is untouched, and the plugin copy is still listed.
    expect(
      await readFile(join(officialSkillsDir, "write-tool", "SKILL.md"), "utf8"),
    ).toBe(before);
    expect(
      registry
        .list()
        .some((skill) => skill.qualifiedName === "plugin:write-tool"),
    ).toBe(true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
