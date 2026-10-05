import { plainStatus } from "./index";
import { handleRuntimeCommand } from "./runtime-commands";
import { handleDaemonCommands } from "./daemon-commands";
import { handleLocalCommands } from "./local-commands";
import { startApp } from "./start-app";

const argv = process.argv.slice(2);
const handled =
  (await handleRuntimeCommand(argv)) ||
  (await handleDaemonCommands(argv)) ||
  (await handleLocalCommands(argv));

if (!handled) {
  const subcommand = argv[0];
  if (["--once", "--stdio", "--diagnostics"].includes(subcommand ?? "")) {
    console.error("use 'natalia <subcommand>' instead of 'natalia <flag>'");
    process.exit(1);
  }
  if (subcommand) throw new Error(`unknown command: ${subcommand}`);
  // No subcommand: START THE APP. This is what a double-click runs, and it used
  // to print a status blob and exit — so the most obvious executable in the
  // install folder was one that never opened anything. `natalia status` is the
  // status; bare `natalia` is the program.
  process.exitCode = await startApp();
}
