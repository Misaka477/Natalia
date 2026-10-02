import { createCliCommandAdapterHost } from "./cli-command-adapter";
import { NATALIA_VERSION } from "./version";
import {
  isPluginMaintenanceCommand,
  parsePluginMaintenanceArgs,
  runPluginMaintenanceCommand,
} from "./plugin-maintenance";
import { initializeOfficialPluginsForHostCommand } from "./official-plugins";

const argv = process.argv.slice(2);

// `--version` answers before anything else loads: no plugin init, no
// asset scan (study D1 — a shipped binary must answer this from anywhere,
// including layouts whose assets are still being verified).
if (argv[0] === "--version") {
  console.log(NATALIA_VERSION);
  process.exit(0);
}

if (isPluginMaintenanceCommand(argv)) {
  const command = parsePluginMaintenanceArgs(argv);
  await runPluginMaintenanceCommand(argv, command);
} else {
  await initializeOfficialPluginsForHostCommand(argv);
  const host = await createCliCommandAdapterHost();
  try {
    await host.done;
  } finally {
    await host.close();
  }
}
