import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A directory link that exists on this host.
 *
 * An unprivileged Windows process cannot create a directory symlink
 * (EPERM), and realpath resolves a junction identically — so the
 * containment judgement under test is the same one either way. What is
 * NOT the same is the link kind, and asserting the escape through a
 * link the host refuses to make tests nothing.
 */
const link = (target: string, path: string) =>
  symlink(target, path, process.platform === "win32" ? "junction" : "dir");
import {
  pathWithinDomains,
  relativeToRoot,
} from "../src/runtime/sandbox-policy";

/**
 * The sandbox policy's path law — the containment judgement every write
 * path answers to. The escapes it must refuse are the ones a prefix match
 * waves through: `..` traversal, an absolute path outside the root, and a
 * symlink whose target sits outside while its spelling sits inside.
 */

test("a path inside the domain passes; one outside fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await writeFile(join(root, "allowed", "a.txt"), "a");
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "a.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(true);
  expect(
    pathWithinDomains({
      path: join(root, "elsewhere", "b.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a `..` traversal that lexically starts inside is refused", async () => {
  // THE escape the prefix match waved through: the spelling starts with
  // the domain, the kernel resolves it outside the root.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "..", "..", "outside", "x.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a symlink inside the root pointing outside is refused", async () => {
  // The other half of canonicalize-then-contain: the spelling is inside,
  // the identity is not.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  const outside = await mkdtemp(join(tmpdir(), "natalia-outside-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await writeFile(join(outside, "secret.txt"), "s");
  await link(outside, join(root, "allowed", "link"));
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "link", "secret.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a path whose tail does not exist yet is judged on its directory", async () => {
  // The write about to create the file: the deepest existing ancestor is
  // resolved, the answer about the directory is the truthful one.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "new.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(true);
  expect(
    pathWithinDomains({
      path: join(root, "elsewhere", "new.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("a not-yet-existing file under an out-pointing symlink is refused", async () => {
  // The hole landedPath closed: the tail does not exist (it is the file the
  // write is about to create), so a whole-path realpath returns the
  // spelling as-is — and the spelling sits inside the domain while the
  // kernel would create the file outside it.
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "natalia-domain-out-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await link(outside, join(root, "allowed", "link"));
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "link", "brand-new.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
  // And the same path with the tail existing is refused too (the realpath
  // case the first implementation already covered).
  await writeFile(join(outside, "existing.txt"), "x");
  expect(
    pathWithinDomains({
      path: join(root, "allowed", "link", "existing.txt"),
      root,
      domains: ["allowed"],
    }),
  ).toBe(false);
});

test("isInsideRoot judges where the write lands, not how it spells", async () => {
  // The main agent's in-process writes have no kernel fence, so their
  // containment is this judgement: a symlink inside the workspace spelling
  // its way out is refused, and so is a traversal, while a plain inside
  // write passes. `workspacePath`'s lexical check alone would wave both
  // escapes through.
  const root = await mkdtemp(join(tmpdir(), "natalia-inside-root-"));
  const outside = await mkdtemp(join(tmpdir(), "natalia-inside-out-"));
  await mkdir(join(root, "allowed"), { recursive: true });
  await writeFile(join(root, "allowed", "inside.txt"), "x");
  await link(outside, join(root, "allowed", "link"));
  expect(isInsideRoot(join(root, "allowed", "inside.txt"), root)).toBe(true);
  // A file that does not exist yet, inside: allowed (the write creates it).
  expect(isInsideRoot(join(root, "allowed", "new.txt"), root)).toBe(true);
  // The escapes.
  expect(isInsideRoot(join(root, "allowed", "link", "escaped.txt"), root)).toBe(
    false,
  );
  expect(isInsideRoot(join(root, "allowed", "..", "..", "escape"), root)).toBe(
    false,
  );
  expect(isInsideRoot("/etc/passwd", root)).toBe(false);
  // The root itself is inside itself.
  expect(isInsideRoot(root, root)).toBe(true);
});

test("an absolute path outside the root never matches a relative domain", () => {
  expect(relativeToRoot("/etc/passwd", "/tmp/root")).toBe("/etc/passwd");
  expect(
    pathWithinDomains({
      path: "/etc/passwd",
      root: "/tmp/root",
      domains: ["etc"],
    }),
  ).toBe(false);
});

test("the root itself reads as position empty, and a bare domain never matches it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-domain-"));
  // The root is inside at position "" — and "" is not a domain name, so a
  // domain list of ["."] does not silently come to mean "the whole root".
  expect(relativeToRoot(root, root)).toBe("");
  expect(pathWithinDomains({ path: root, root, domains: ["."] })).toBe(false);
});

/**
 * The policy home (洞 2's item 1): one resolution entry every write path
 * asks. The precedence and the root-fallback are the load-bearing halves —
 * bash and fs asking the same resolve is what makes the split-world state
 * impossible rather than merely forbidden.
 */

import {
  isInsideRoot,
  isWritableUnderPolicy,
  resolveDeploymentMode,
  resolveSandboxPolicy,
  sandboxWritableRoots,
  type SandboxPolicySources,
} from "../src/runtime/sandbox-policy";

// `os: "linux"` is the default on purpose: these tests are about the
// policy's PRECEDENCE and root law, and the platform gate that closes
// the chain has its own test below (which names both hosts explicitly).
// Without a named host the question becomes "what can THIS host
// enforce", and on a rung-less host (Windows) every mode degrades to
// danger-full-access — correct behaviour, wrong subject.
const sources = (
  over: Partial<SandboxPolicySources> = {},
): SandboxPolicySources => ({
  deploymentRoot: "/repo/workspace",
  os: "linux",
  ...over,
});

test("the row beats the config key beats the schema default", () => {
  // No profile, no key: the schema default.
  expect(resolveDeploymentMode(sources())).toBe("workspace-write");
  // The config key is the row's fallback.
  expect(resolveDeploymentMode(sources({ configMode: "read-only" }))).toBe(
    "read-only",
  );
  // The row wins over the key.
  expect(
    resolveDeploymentMode(
      sources({
        configMode: "read-only",
        profile: {
          rows: [
            { id: "anthelia.sandbox", config: { mode: "danger-full-access" } },
          ],
        } as never,
      }),
    ),
  ).toBe("danger-full-access");
});

test("the platform gate: a mode this host cannot enforce degrades, said once", () => {
  // Windows has no rung: the requested read-only degrades to full rather
  // than advertising a sandbox the machine never had.
  expect(
    resolveDeploymentMode(sources({ configMode: "read-only", os: "win32" })),
  ).toBe("danger-full-access");
  // Linux has the rung: the mode stands.
  expect(
    resolveDeploymentMode(sources({ configMode: "read-only", os: "linux" })),
  ).toBe("read-only");
});

test("the per-call precedence: explicit beats session beats deployment", () => {
  const base = sources({ configMode: "workspace-write" });
  // The session's rung override wins over the deployment default.
  expect(resolveSandboxPolicy({ ...base, sessionMode: "read-only" }).mode).toBe(
    "read-only",
  );
  // An explicit grant (the escalation's per-call widening) wins over both.
  expect(
    resolveSandboxPolicy({
      ...base,
      sessionMode: "read-only",
      explicitMode: "danger-full-access",
    }).mode,
  ).toBe("danger-full-access");
});

test("the session's own root beats the configured one", () => {
  // A sub-agent's worktree is ITS root; the configured workspace root is
  // the fallback for a session without one.
  expect(
    resolveSandboxPolicy(sources({ sessionRoot: "/worktrees/agent-7" }))
      .workspaceRoot,
  ).toBe("/worktrees/agent-7");
  expect(resolveSandboxPolicy(sources()).workspaceRoot).toBe("/repo/workspace");
});

test("the writable roots are the mode's own set, and the judgement lands", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-policy-roots-"));
  const policy = resolveSandboxPolicy(
    sources({ configMode: "workspace-write", sessionRoot: root }),
  );
  // The workspace rides the roots beside the platform temp set — the same
  // set the kernel wrapper grants, so fs and bash cannot disagree.
  expect(sandboxWritableRoots(policy)).toContain(root);
  // Inside: allowed. Outside: refused. The escapes are judged on where
  // they LAND, not how they spell.
  await mkdir(join(root, "allowed"), { recursive: true });
  await writeFile(join(root, "allowed", "a.txt"), "a");
  expect(isWritableUnderPolicy(policy, join(root, "allowed", "a.txt"))).toBe(
    true,
  );
  expect(isWritableUnderPolicy(policy, "/etc/passwd")).toBe(false);
  // A workspace that is NOT under the platform temp dir, so the escape
  // lands outside every writable root (escaping a /tmp workspace lands in
  // /tmp, which workspace-write legitimately grants).
  const rooted = resolveSandboxPolicy(
    sources({ configMode: "workspace-write", sessionRoot: "/repo/workspace" }),
  );
  expect(
    isWritableUnderPolicy(rooted, "/repo/workspace/allowed/../../escape"),
  ).toBe(false);
  // The symlink's target sits OUTSIDE every writable root
  // (workspace-write grants the workspace and the platform's temp dir;
  // a target under the temp dir would be legitimately writable and prove
  // nothing about the containment).
  //
  // On POSIX that outside is the /dev/shm tmpfs, which is neither. On
  // Windows there is no /dev/shm, and the equivalent outside is the
  // user's home directory — not the temp dir, and not this test's
  // workspace (which is itself a mkdtemp under the temp dir).
  const outsideBase = process.platform === "win32" ? homedir() : "/dev/shm";
  const outside = await mkdtemp(join(outsideBase, "natalia-policy-out-"));
  await writeFile(join(outside, "secret.txt"), "s");
  await link(outside, join(root, "allowed", "link"));
  expect(
    isWritableUnderPolicy(policy, join(root, "allowed", "link", "secret.txt")),
  ).toBe(false);
  // A read-only policy writes nowhere but the platform's drain.
  const ro = resolveSandboxPolicy(
    sources({ configMode: "read-only", sessionRoot: root }),
  );
  expect(sandboxWritableRoots(ro)).toEqual(["/dev/null"]);
  expect(isWritableUnderPolicy(ro, join(root, "allowed", "a.txt"))).toBe(false);
});
