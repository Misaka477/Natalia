import { parentPort, workerData } from "node:worker_threads";

type Input = {
  executable: string;
  args: string[];
  stdin?: string;
  environment?: Record<string, string | undefined>;
};

const input = workerData as Input;
const child = Bun.spawn({
  cmd: [input.executable, ...input.args],
  env: { ...process.env, ...input.environment },
  stdin: input.stdin === undefined ? "ignore" : "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

if (input.stdin !== undefined) {
  if (!child.stdin) throw new Error("WezTerm stdin pipe was not created");
  child.stdin.write(input.stdin);
  child.stdin.end();
}

try {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  parentPort?.postMessage({ stdout, stderr, exitCode });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}
