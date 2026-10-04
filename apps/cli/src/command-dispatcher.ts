import { plainStatus } from "./index";
import { handleRuntimeCommand } from "./runtime-commands";
import { handleDaemonCommands } from "./daemon-commands";
import { handleLocalCommands } from "./local-commands";
import { ensureNataliaConfigPath, nataliaConfigPath } from "./config-home";

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
  // No subcommand: the default face. Its config home is created here, so the
  // first launch of a fresh install reports its (unconfigured) state instead of
  // dying on a file nobody was responsible for creating.
  const configPath = (await ensureNataliaConfigPath(nataliaConfigPath())).path;
  console.log(JSON.stringify(await plainStatus(configPath), null, 2));
}
