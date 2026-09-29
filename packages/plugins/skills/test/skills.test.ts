import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  authorizeSkillTool,
  createSkillLoadTool,
  discoverSkills,
  SkillRegistry,
  formatSkillForModel,
  pullRemoteSkills,
  readSkillResource,
  resolveSkillResource,
  runSkillScript,
  skillDigest,
} from "../src/skills";

test("discovers native project skills and enforces policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skills-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review code\nallowed-tools: [read_file, grep]\nsandbox-required: true\nresources: [notes.txt]\nscripts: {smoke: printf skill-ok}\n---\nUse careful review.",
  );
  await writeFile(join(skillRoot, "notes.txt"), "resource-ok");
  const registry = await discoverSkills({ workspaceRoot: root });
  const skill = registry.resolve("review");
  expect(skill.body).toBe("Use careful review.");
  expect(skill.resources).toEqual(["notes.txt"]);
  expect(await readSkillResource(skill, "notes.txt")).toBe("resource-ok");
  expect((await runSkillScript(skill, "smoke")).stdout).toBe("skill-ok");
  expect(authorizeSkillTool(skill, "read_file", { mode: "sandbox" })).toBe(
    true,
  );
  expect(authorizeSkillTool(skill, "write_file", { mode: "sandbox" })).toBe(
    false,
  );
  expect(() => resolveSkillResource(skill, "../escape")).toThrow("escapes");
});

test("remote skill cache reuses a version and atomically refreshes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-remote-skill-"));
  let version = "1";
  let body = "First";
  let downloads = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/skills/index.json")
        return Response.json({
          skills: [
            { name: "remote", version, files: ["SKILL.md", "refs/guide.md"] },
          ],
        });
      downloads++;
      if (url.pathname === "/skills/remote/SKILL.md")
        return new Response(
          `---\nname: remote\ndescription: Remote\n---\n${body}`,
        );
      if (url.pathname === "/skills/remote/refs/guide.md")
        return new Response("guide");
      return new Response("missing", { status: 404 });
    },
  });
  try {
    const input = {
      url: `${server.url}skills/`,
      cacheRoot: join(root, "cache"),
    };
    const first = await pullRemoteSkills(input);
    expect(await readFile(join(first[0]!, "SKILL.md"), "utf8")).toContain(
      "First",
    );
    const cachedDownloads = downloads;
    await pullRemoteSkills(input);
    expect(downloads).toBe(cachedDownloads);
    version = "2";
    body = "Second";
    const refreshed = await pullRemoteSkills(input);
    expect(await readFile(join(refreshed[0]!, "SKILL.md"), "utf8")).toContain(
      "Second",
    );
  } finally {
    server.stop(true);
  }
});

test("skill load tool injects bounded model content for a discovered skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-tool-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview guidance",
  );
  const registry = await discoverSkills({ workspaceRoot: root });
  let loaded = "";
  const tool = createSkillLoadTool({
    registry: () => registry,
    onLoad: (_skill, output) => (loaded = output),
  });
  const output = await tool.execute(
    { name: "review" },
    { workspaceRoot: root },
  );
  expect(output).toContain('<skill_content name="review">');
  expect(loaded).toBe(output);
});

test("formats selected skill content with a bounded local file sample", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-format-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview guidance",
  );
  await writeFile(join(skillRoot, "references", "guide.md"), "guide");
  const skill = (await discoverSkills({ workspaceRoot: root })).resolve(
    "review",
  );
  const output = await formatSkillForModel(skill);
  expect(output).toContain('<skill_content name="review">');
  expect(output).toContain(`Base directory for this skill: ${skillRoot}`);
  expect(output).toContain("<file>references/guide.md</file>");
});

test("formats a removed skill without failing the active tool invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-removed-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview guidance",
  );
  const skill = (await discoverSkills({ workspaceRoot: root })).resolve(
    "review",
  );
  await rm(skillRoot, { recursive: true });
  await expect(formatSkillForModel(skill)).resolves.toContain(
    "<skill_files>\n</skill_files>",
  );
});

test("project skill source overrides a user skill with the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-precedence-"));
  const project = join(root, ".natalia", "skills", "review");
  const user = join(root, "user", "review");
  await mkdir(project, { recursive: true });
  await mkdir(user, { recursive: true });
  await writeFile(
    join(project, "SKILL.md"),
    "---\nname: review\ndescription: Project\n---\nProject guidance",
  );
  await writeFile(
    join(user, "SKILL.md"),
    "---\nname: review\ndescription: User\n---\nUser guidance",
  );
  const registry = await discoverSkills({
    workspaceRoot: root,
    userRoot: join(root, "user"),
  });
  expect(registry.resolve("review").body).toBe("Project guidance");
  expect(registry.list().map((skill) => skill.qualifiedName)).toEqual([
    "project:review",
    "user:review",
  ]);
});

// --- Discovery D4: the validated skill write (the review's only door) ---

import { mkdtempSync, readFileSync } from "node:fs";
import { parseSkill } from "../src/skills";
import { validateSkillProposal } from "../src/skill-write";

test("the proposal whitelist accepts create/update and rejects everything else by kind", () => {
  const good = validateSkillProposal({
    kind: "create",
    name: "release-notes",
    description: "Draft release notes",
    content: "# Release notes\nBody.",
  });
  expect(good.ok).toBe(true);
  // The action whitelist bites: only these two words can even be parsed.
  for (const kind of ["delete", "execute", "write_file", "patch", 7, null]) {
    const rejected = validateSkillProposal({
      kind,
      name: "x",
      description: "d",
      content: "c",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toContain("whitelisted");
  }
});

test("name, description, content and size rules bite; frontmatter is rebuilt", () => {
  const base = {
    kind: "create",
    name: "ok-name",
    description: "d",
    content: "body",
  };
  expect(validateSkillProposal({ ...base, name: "../escape" }).ok).toBe(false);
  expect(validateSkillProposal({ ...base, name: "UPPER" }).ok).toBe(false);
  expect(validateSkillProposal({ ...base, description: "   " }).ok).toBe(false);
  expect(validateSkillProposal({ ...base, content: "" }).ok).toBe(false);
  const oversized = validateSkillProposal({
    ...base,
    content: "x".repeat(64_001),
  });
  expect(oversized.ok).toBe(false);
  // Rebuilt (never pasted): a name smuggled inside the body's frontmatter
  // cannot override the validated name.
  const tricky = validateSkillProposal({
    ...base,
    description: 'a: "quoted: value"\nname: smuggled',
    content: "---\nname: smuggled\n---\ninjected",
  });
  expect(tricky.ok).toBe(true);
  if (tricky.ok) {
    expect(tricky.skillmd).toContain("name: ok-name");
    expect(tricky.skillmd.indexOf("name: smuggled")).toBeGreaterThan(
      tricky.skillmd.indexOf("---"),
    );
    // The validated description sits on ONE quoted line — it cannot open a
    // second frontmatter block that the loader would read as fields.
    expect(tricky.skillmd.split("\n")[2]).toContain("description:");
    expect(tricky.skillmd.split("\n").length).toBeGreaterThan(4);
    const parsed = parseSkill(tricky.skillmd, {
      root: "/tmp/x",
      source: "project",
    });
    expect(parsed.name).toBe("ok-name");
    expect(parsed.body).toContain("injected");
  }
});

test("upsertSkill writes under the project root, reloads, and reports created vs update", async () => {
  const ws = mkdtempSync(join(tmpdir(), "skill-upsert-"));
  const registry = await discoverSkills({ workspaceRoot: ws });
  // No origin stamped scenario is covered by discoverSkills always stamping.
  const created = await registry.upsertSkill({
    kind: "create",
    name: "d4-review-skill",
    description: "Sedimented by the review loop",
    content: "# When to use\nAlways.",
  });
  expect(created).toEqual({ created: true, name: "d4-review-skill" });
  const file = join(ws, ".natalia", "skills", "d4-review-skill", "SKILL.md");
  expect(readFileSync(file, "utf8")).toContain("Sedimented by the review loop");
  // Immediately visible through the same service surface the model uses.
  expect(registry.resolve("d4-review-skill").name).toBe("d4-review-skill");
  const updated = await registry.upsertSkill({
    kind: "update",
    name: "d4-review-skill",
    description: "Updated description",
    content: "# Updated body",
  });
  expect(updated.created).toBe(false);
  expect(readFileSync(file, "utf8")).toContain("Updated body");
  // A rejected proposal never touches disk and throws with its reason.
  await expect(
    registry.upsertSkill({ kind: "rm", name: "d4-review-skill" }),
  ).rejects.toThrow(/whitelisted/u);
  expect(readFileSync(file, "utf8")).toContain("Updated body");
});

test("discovery stamps every skill with its content digest", async () => {
  // The fingerprint catalog's first field: a skill's sha256 identity,
  // computed by discovery for every source — a content change moves it,
  // an identical re-read does not.
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-digest-"));
  const skillRoot = join(root, ".natalia", "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  const content = "---\nname: review\ndescription: Review\n---\nBody";
  await writeFile(join(skillRoot, "SKILL.md"), content);
  const registry = await discoverSkills({ workspaceRoot: root });
  const skill = registry.resolve("review");
  expect(skill.digest).toBe(skillDigest(content));
  expect(skill.digest).toMatch(/^[0-9a-f]{64}$/u);
  await writeFile(join(skillRoot, "SKILL.md"), `${content} changed`);
  await registry.reload({ workspaceRoot: root });
  expect(registry.resolve("review").digest).not.toBe(skill.digest);
  expect(registry.resolve("review").digest).toBe(
    skillDigest(`${content} changed`),
  );
});

test("parseSkill computes the digest it stamps (pure)", () => {
  const content = "---\nname: pure\ndescription: Pure\n---\nBody";
  const parsed = parseSkill(content, { root: "/tmp/x", source: "project" });
  expect(parsed.digest).toBe(skillDigest(content));
});

test("a remote index's declared digests are verified before the swap", async () => {
  // cua's client-verifies-before-use: the index pins each file's sha256;
  // a tampered or truncated download is refused NAMED, and the previously
  // cached skill survives (the staging swap never happens).
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-digest-remote-"));
  const good = "---\nname: remote\ndescription: Remote\n---\nFirst";
  const goodDigest = skillDigest(good);
  const guide = "guide-v1";
  let serveBody = good;
  let declared: string | undefined = goodDigest;
  let version = "1";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/skills/index.json")
        return Response.json({
          skills: [
            {
              name: "remote",
              version,
              files: [{ path: "SKILL.md", sha256: declared }, "refs/guide.md"],
            },
          ],
        });
      if (url.pathname === "/skills/remote/SKILL.md")
        return new Response(serveBody);
      if (url.pathname === "/skills/remote/refs/guide.md")
        return new Response(guide);
      return new Response("missing", { status: 404 });
    },
  });
  try {
    const input = {
      url: `${server.url}skills/`,
      cacheRoot: join(root, "cache"),
    };
    // A matching declaration installs (and the declared bytes are what land).
    const first = await pullRemoteSkills(input);
    expect(await readFile(join(first[0]!, "SKILL.md"), "utf8")).toBe(good);
    // A tampered download under a bumped version: refused by name, old kept.
    serveBody = "---\nname: remote\ndescription: Remote\n---\nEvil";
    version = "2";
    declared = skillDigest(serveBody).slice(0, 63);
    await expect(pullRemoteSkills(input)).rejects.toThrow(
      /remote skill file digest mismatch: remote\/SKILL.md/u,
    );
    // The swap never happened: the cached skill from the first (verified)
    // pull is still on disk, byte for byte.
    expect(await readFile(join(first[0]!, "SKILL.md"), "utf8")).toBe(good);
    // A missing declaration is the index's choice, not a refusal.
    declared = undefined;
    version = "3";
    serveBody = "---\nname: remote\ndescription: Remote\n---\nUnpinned";
    const unpinned = await pullRemoteSkills(input);
    expect(await readFile(join(unpinned[0]!, "SKILL.md"), "utf8")).toContain(
      "Unpinned",
    );
  } finally {
    server.stop(true);
  }
});

test("a plugin's shipped skills are discovered with the plugin source", async () => {
  // The base-gap closure: a plugin ships skills in its package (here a
  // scratch dir standing in for the package's declared skills dir), and
  // discovery walks it like any other root — source, qualified name,
  // digest, resources against the package dir.
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-skill-"));
  const packageDir = join(root, "packages", "natalia-tool-example");
  const skillRoot = join(packageDir, "skills", "example");
  await mkdir(skillRoot, { recursive: true });
  const content =
    "---\nname: example\ndescription: Example\n---\nExample guidance";
  await writeFile(join(skillRoot, "SKILL.md"), content);
  await writeFile(join(skillRoot, "notes.txt"), "package-resource");
  const registry = await discoverSkills({
    workspaceRoot: root,
    pluginDirs: [join(packageDir, "skills")],
  });
  const skill = registry.resolve("example");
  expect(skill.qualifiedName).toBe("plugin:example");
  expect(skill.source).toBe("plugin");
  expect(skill.digest).toBe(skillDigest(content));
  expect(await readSkillResource(skill, "notes.txt")).toBe("package-resource");
});

test("a project root overrides a plugin skill of the same name", async () => {
  // Precedence: plugin skills are the LOWEST source — the project root
  // still wins a name collision, exactly as it does over user and remote.
  const root = await mkdtemp(join(tmpdir(), "natalia-plugin-skill-override-"));
  const packageDir = join(root, "packages", "natalia-tool-example");
  const shipped = join(packageDir, "skills", "shared");
  await mkdir(shipped, { recursive: true });
  await writeFile(
    join(shipped, "SKILL.md"),
    "---\nname: shared\ndescription: Shipped\n---\nFrom the package",
  );
  const project = join(root, ".natalia", "skills", "shared");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "SKILL.md"),
    "---\nname: shared\ndescription: Project\n---\nFrom the project",
  );
  const registry = await discoverSkills({
    workspaceRoot: root,
    pluginDirs: [join(packageDir, "skills")],
  });
  // Both are registered (distinct qualified names); resolve() picks the
  // project one — the later source wins, the precedence rule.
  expect(
    registry
      .list()
      .map((skill) => skill.qualifiedName)
      .sort(),
  ).toEqual(["plugin:shared", "project:shared"]);
  expect(registry.resolve("shared").source).toBe("project");
});

test("the workspace's disabled set turns a skill off and back on", async () => {
  // The settings panel's switch: a disabled skill stays listed (so it can be
  // switched back on) but resolve refuses it, so the model can neither load nor
  // run it. Both halves matter — a skill that vanishes cannot be re-enabled.
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-toggle-"));
  await mkdir(join(root, ".natalia", "skills", "alpha"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "skills", "alpha", "SKILL.md"),
    '---\nname: alpha\ndescription: "A"\n---\n\nbody\n',
  );
  await mkdir(join(root, ".natalia", "skills", "beta"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "skills", "beta", "SKILL.md"),
    '---\nname: beta\ndescription: "B"\n---\n\nbody\n',
  );
  const registry = new SkillRegistry();
  await registry.reload({ workspaceRoot: root });
  expect(registry.list().map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  expect(() => registry.resolve("beta")).not.toThrow();

  await registry.setSkillEnabled("beta", false);

  // Still listed, but refused.
  expect(registry.list().map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  expect(registry.list().find((skill) => skill.name === "beta")!.enabled).toBe(
    false,
  );
  expect(() => registry.resolve("beta")).toThrow(/disabled/);
  expect(() => registry.resolve("alpha")).not.toThrow();

  // Durable: a fresh registry (a restart) reads the same set.
  const reopened = new SkillRegistry();
  await reopened.reload({ workspaceRoot: root });
  expect(reopened.list().find((skill) => skill.name === "beta")!.enabled).toBe(
    false,
  );

  // And back on.
  await reopened.setSkillEnabled("beta", true);
  expect(() => reopened.resolve("beta")).not.toThrow();
});

test("removing a skill deletes it, and refuses a source it does not own", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-skill-remove-"));
  await mkdir(join(root, ".natalia", "skills", "mine"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "skills", "mine", "SKILL.md"),
    '---\nname: mine\ndescription: "M"\n---\n\nbody\n',
  );
  const registry = new SkillRegistry();
  await registry.reload({ workspaceRoot: root });

  await registry.removeSkill("mine");
  expect(registry.list().map((skill) => skill.name)).not.toContain("mine");
  expect(existsSync(join(root, ".natalia", "skills", "mine"))).toBe(false);

  // A plugin's skill ships with the plugin: removing it would be undone by the
  // next reload (or would corrupt the install), so it is refused with the
  // reason rather than deleting files it does not own.
  const pluginDir = join(root, "plugin-skills");
  await mkdir(join(pluginDir, "shipped"), { recursive: true });
  await writeFile(
    join(pluginDir, "shipped", "SKILL.md"),
    '---\nname: shipped\ndescription: "S"\n---\n\nbody\n',
  );
  const withPlugin = new SkillRegistry();
  await withPlugin.reload({ workspaceRoot: root, pluginDirs: [pluginDir] });
  const shipped = withPlugin.list().find((skill) => skill.name === "shipped")!;
  expect(shipped.source).toBe("plugin");
  await expect(withPlugin.removeSkill("shipped")).rejects.toThrow(
    /cannot remove a plugin skill/,
  );
  // The refusal is a refusal: the files are still there.
  expect(existsSync(join(pluginDir, "shipped", "SKILL.md"))).toBe(true);
});
