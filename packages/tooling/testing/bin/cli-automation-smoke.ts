import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "natalia-cli-smoke-home-"));
const workspaceRoot = await mkdtemp(join(tmpdir(), "natalia-cli-smoke-root-"));
const repoRoot = join(import.meta.dir, "..");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".state"),
};

await mkdir(join(workspaceRoot, ".natalia"), { recursive: true });
await writeFile(
  join(workspaceRoot, ".natalia", "config.json"),
  JSON.stringify({
    version: 3,
    permissionProfiles: {
      unattended_read: {
        approval: "auto",
        description: "Automation smoke profile",
        permissions: { tools: { allow: ["read_file"] } },
      },
    },
  }),
);

const once = run(["--once", "--json", "/doctor"]);
assertDoctor("--once --json", once);
assertHeadlessExecution("first --once --json", once);

const secondOnce = run(["--once", "--json", "/doctor"]);
assertDoctor("second --once --json", secondOnce);
assertHeadlessExecution("second --once --json", secondOnce);
const firstSession = sessionCreated(once);
const secondSession = sessionCreated(secondOnce);
if (firstSession.sessionID === secondSession.sessionID)
  throw new Error("separate --once executions reused a session ID");
if (firstSession.episodeID === secondSession.episodeID)
  throw new Error("separate --once executions reused an episode ID");

const profiled = run([
  "--once",
  "--permission",
  "unattended_read",
  "--json",
  "/doctor",
]);
assertDoctor("--once --permission unattended_read --json", profiled);
if (
  !profiled.some(
    (event) => event.type === "status.snapshot" && event.permissions === "auto",
  )
)
  throw new Error("--permission did not select the requested approval profile");

const stdio = run(["--stdio"], `${JSON.stringify({ prompt: "/doctor" })}\n`);
assertDoctor("--stdio", stdio);
assertHeadlessExecution("--stdio", stdio);

const failure = run(
  ["--once", "--json", "inspect this workspace"],
  undefined,
  1,
);
if (
  !failure.some(
    (event) => event.type === "turn.finished" && event.stopReason === "error",
  )
)
  throw new Error("failed --once did not report turn.finished error");

console.log(
  JSON.stringify({
    onceEvents: once.length,
    secondOnceEvents: secondOnce.length,
    profiledEvents: profiled.length,
    stdioEvents: stdio.length,
    workspaceRoot,
    status: "passed",
  }),
);

function run(args: string[], stdin?: string, expectedExitCode = 0) {
  const child = Bun.spawnSync(
    [process.execPath, join(repoRoot, "apps/cli/src/main.ts"), ...args],
    {
      cwd: workspaceRoot,
      env,
      stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (child.exitCode !== expectedExitCode) {
    throw new Error(
      `CLI ${args.join(" ")} exited ${child.exitCode}, expected ${expectedExitCode}: ${new TextDecoder().decode(child.stderr)}`,
    );
  }
  return new TextDecoder()
    .decode(child.stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          text?: string;
          stopReason?: string;
          permissions?: string;
          episodeID?: string;
          sessionID?: string;
        },
    );
}

function assertHeadlessExecution(
  label: string,
  events: ReturnType<typeof run>,
) {
  const session = sessionCreated(events);
  if (!session.episodeID?.startsWith("epi_"))
    throw new Error(`${label} did not emit an episode ID`);
  if (!session.sessionID?.startsWith("ses_"))
    throw new Error(`${label} did not emit a session ID`);
  if (
    events.some(
      (event) =>
        event.episodeID !== undefined && event.episodeID !== session.episodeID,
    )
  )
    throw new Error(`${label} emitted events for multiple episodes`);
}

function sessionCreated(events: ReturnType<typeof run>) {
  const event = events.find((entry) => entry.type === "session.created");
  if (!event?.sessionID)
    throw new Error("headless execution did not create a session");
  return event;
}

function assertDoctor(label: string, events: ReturnType<typeof run>) {
  if (
    !events.some(
      (event) =>
        event.type === "content.delta" &&
        event.text?.includes("Natalia TS7 runtime doctor"),
    )
  ) {
    throw new Error(`${label} did not emit the runtime doctor response`);
  }
  if (
    !events.some(
      (event) => event.type === "turn.finished" && event.stopReason === "done",
    )
  ) {
    throw new Error(`${label} did not finish the turn`);
  }
}
