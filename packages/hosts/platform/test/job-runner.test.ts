/**
 * The detached-process owner, pinned.
 *
 * The behavioural half lives in `detached-process.test.ts` (Windows only, driven
 * against the real binary). This half is the part that must hold on every host
 * — the shape of the helper and the rules it encodes — because the release
 * builder and the runtime both depend on it, and a shape regression is invisible
 * on Linux until a Windows user's background process loses its tree.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The repository root: this test is packages/hosts/platform/test, so three levels
// up. Spelled with `import.meta.dir` (which is this directory) rather than a
// relative literal, because the harness runs tests from the root and a relative
// path would resolve against that.
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const source = readFileSync(
  join(
    repoRoot,
    "packages",
    "hosts",
    "platform",
    "native",
    "win",
    "natalia-job-runner.cc",
  ),
  "utf8",
);
/** The same file with `//` comment lines dropped: shape assertions are about the
 *  CODE, and the comments deliberately name what was removed. */
const code = source.replace(/^\s*\/\/.*$/gmu, "");

test("the owner creates a job that dies with its last handle", () => {
  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the whole point: when the owner ends —
  // normally, by request, or by being killed — the handle closes and Windows ends
  // the tree. A job without it owns nothing.
  expect(source).toContain("CreateJobObjectW");
  expect(source).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
  expect(source).toContain("SetInformationJobObject");
});

test("the target is assigned before it can run", () => {
  // CREATE_SUSPENDED, then AssignProcessToJobObject, then ResumeThread: a target
  // that starts running before the assignment could spawn a child the job never
  // sees. The order is the mechanism.
  expect(source).toContain("CREATE_SUSPENDED");
  const suspendAt = source.indexOf("CREATE_SUSPENDED");
  const assignAt = source.indexOf("AssignProcessToJobObject");
  const resumeAt = source.indexOf("ResumeThread");
  expect(assignAt).toBeGreaterThan(suspendAt);
  expect(resumeAt).toBeGreaterThan(assignAt);
});

test("termination ends the job, and the target inherits the runner's stdio", () => {
  // `{"type":"terminate"}` terminates the JOB, not a process — every descendant
  // goes at once. And bInheritHandles TRUE with no STARTF_USESTDHANDLES, which is
  // THE measured difference between a detached worker that runs and one that
  // exits without running its command: a console app whose stdio it cannot use
  // dies silently (pwsh 7.4 answers `-Command "exit 42"` with 0 and no output).
  // The first version copied the ConPTY idiom (FALSE + STARTF_USESTDHANDLES with
  // NULL handles), which is right for a pane a pseudo-console owns and wrong for
  // a detached process, which has no pseudo-console.
  expect(source).toContain("TerminateJobObject");
  expect(source).toContain('"type":"terminate"');
  // bInheritHandles is POSITIONAL in CreateProcessW: TRUE, so the target
  // inherits this runner's own stdio (the log file the caller opened).
  expect(code).toContain("TRUE, flags");
  expect(code).not.toContain("FALSE, flags");
  expect(code).not.toContain("STARTF_USESTDHANDLES");
});

test("the spec's environment is applied the way Windows requires", () => {
  // A sorted block with CREATE_UNICODE_ENVIRONMENT — the ConPTY idiom — and NOT
  // SetEnvironmentVariableW, which would mutate this runner's own environment for
  // the children it starts afterwards.
  expect(source).toContain("buildEnvironmentBlock");
  expect(source).toContain("CREATE_UNICODE_ENVIRONMENT");
  expect(source).toContain("GetEnvironmentStringsW");
  expect(source).toContain('extractStringMap(spec, "env")');
  expect(source).not.toContain("SetEnvironmentVariableW");
});

test("the spec's environment is parsed quote-aware", () => {
  // A value may hold braces, brackets and quotes of its own — the platform's
  // worker script does — so the reader must never mistake one of them for the
  // object's end. (The first version was correct on this count too, measured by
  // feeding both versions the same script; the pin is what keeps the next
  // rewrite honest.)
  expect(code).toContain("readJsonString");
  expect(code).not.toContain("json.find('}', at)");
  expect(code).not.toContain("json.find(']', at)");
});

test("the release stages the owner, and fails loudly when it is missing", () => {
  // A release whose detached starts cannot find their owner would ship the old
  // behaviour silently.
  const build = readFileSync(
    join(repoRoot, "scripts", "build-standalone.ts"),
    "utf8",
  );
  expect(build).toContain("stagePlatformOwner");
  expect(build).toContain("platform:build-job-runner:windows");
});

test("the platform resolves the owner where the release stages it", () => {
  const platform = readFileSync(
    join(repoRoot, "packages", "hosts", "platform", "src", "index.ts"),
    "utf8",
  );
  expect(platform).toContain("detachedOwnerCommand");
  expect(platform).toContain("natalia-job-runner");
  // A missing binary is a refusal naming its build command, never a silent
  // degrade to an unowned chain.
  expect(platform).toContain("the detached-process owner is not built");
});
