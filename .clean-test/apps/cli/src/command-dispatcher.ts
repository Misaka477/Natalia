import { plainStatus } from "./index";
import { handleRuntimeCommand } from "./runtime-commands";
import { handleDaemonCommands } from "./daemon-commands";
import { handleLocalCommands } from "./local-commands";

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
  const configPath =
    process.env.NATALIA_CONFIG ?? `${process.cwd()}/.natalia/config.json`;
  console.log(JSON.stringify(await plainStatus(configPath), null, 2));
}
