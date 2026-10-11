import { callRuntimeRPC } from "@natalia/transport";
import { skillGcReport } from "@natalia/engineering-intelligence";
import {
  createRuntimeDaemonStore,
  daemonToken,
  readRuntimeDaemonRegistration,
} from "@natalia/transport/host";
import { daemonDir } from "./command-helpers";
import type { RuntimeSkillCatalogEntry } from "@anthelia/contracts";

/**
 * The skills CLI: the catalog, the durable off-switch, and the remove.
 *
 * The settings panel offers the remove only for workspace-owned skills —
 * a plugin's skill ships with the plugin and a remote one is pulled into a
 * cache, so deleting either would be undone by the next reload (or would
 * corrupt the package). This surface is where an operator goes instead:
 * every catalog row is listable, every row can be switched off durably
 * (`skill.setEnabled` writes the workspace's disabled set, and `resolve`
 * refuses a disabled skill — the model can neither load nor run it), and
 * the remove is attempted for any name, with the boundary's refusal shown
 * verbatim rather than swallowed.
 *
 * The daemon owns the skills service, so every subcommand goes through it;
 * no daemon is a named answer, not a crash.
 */

const USAGE =
  "usage: natalia skills [list] [--json]\n" +
  "       natalia skills remove <name>\n" +
  "       natalia skills disable <name>\n" +
  "       natalia skills enable <name>\n" +
  "       natalia skills gc [--json]   (dry run: lists, never deletes)";

/** The daemon's URL and token, or undefined when none is running. */
async function daemonConnection() {
  const store = createRuntimeDaemonStore({ dir: daemonDir() });
  const registration = await readRuntimeDaemonRegistration(store);
  if (!registration) return undefined;
  return { url: registration.url, token: await daemonToken(store) };
}

export async function skillsCli(argv: string[]): Promise<void> {
  const action = argv[0] ?? "list";
  if (
    action !== "list" &&
    action !== "remove" &&
    action !== "disable" &&
    action !== "enable" &&
    // W6: the lifecycle dry run. It LISTS what a gc would take; the
    // eviction itself is a human act (G6), same as the landing path.
    action !== "gc"
  ) {
    console.error(USAGE);
    process.exit(1);
  }
  // W6: the lifecycle dry run. It reads the catalog (no name, no write)
  // and reports what a gc WOULD take — never taking it.
  // The argument shape is checked BEFORE the daemon is asked: a missing
  // name is a caller error, and answering it with "no daemon" sends the
  // operator to start a service for nothing.
  const name = argv[1];
  if (
    action !== "list" &&
    // W6: gc reads the catalog, not a name.
    action !== "gc" &&
    (!name || name.startsWith("-"))
  ) {
    console.error(`natalia skills ${action} requires a skill name`);
    console.error(USAGE);
    process.exit(1);
  }
  const connection = await daemonConnection();
  if (!connection) {
    console.error(
      "no daemon is running — start one with `natalia daemon` (the skills service lives there)",
    );
    process.exit(1);
  }

  if (action === "gc") {
    const rows = (await callRuntimeRPC<Array<{ name: string; source: string }>>(
      {
        url: connection.url,
        token: connection.token,
        method: "skills.list",
        params: {},
      },
    )) as Array<{ name: string; source: string }>;
    // The honest caveat, in the output: this system journals no skill-usage
    // fact (activation is runtime state, command executions are not
    // journaled), so uses/successes/lastUsedAt have no source yet. A gc
    // that cannot see usage refuses to guess rather than deleting on
    // zeros — an eviction policy running on invented numbers would delete
    // the skills nobody measured.
    const report = skillGcReport(
      rows.map((row) => ({
        name: row.name,
        uses: 0,
        successes: 0,
        bytes: 0,
        createdAt: Date.now(),
      })),
      Date.now(),
    );
    console.log(
      argv.includes("--json")
        ? JSON.stringify(report, null, 2)
        : [
            `skill gc (dry run): ${report.evict.length} evictable, ${report.keep.length} kept`,
            ...report.keep.map((row) => `  keep ${row.name} — ${row.reason}`),
            "no usage facts are journaled yet, so nothing is evictable — this is the guard working, not a bug",
          ].join("\n"),
    );
    return;
  }
  const { url, token } = connection;
  if (action === "list") {
    const rows = (await callRuntimeRPC<RuntimeSkillCatalogEntry[]>({
      url,
      token,
      method: "skills.list",
      params: {},
    })) as RuntimeSkillCatalogEntry[];
    if (argv.includes("--json")) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) {
      console.log("no skills discovered");
      return;
    }
    for (const row of rows)
      console.log(
        [
          row.qualifiedName,
          row.enabled ? "enabled" : "disabled",
          row.description || "—",
        ].join("\t"),
      );
    return;
  }
  if (action === "remove") {
    // Attempted for any name: the boundary refuses a source the workspace
    // does not own, and its reason is the answer (shown, not swallowed).
    const result = (await callRuntimeRPC<{ removed: string }>({
      url,
      token,
      method: "skill.remove",
      params: { name },
    })) as { removed: string };
    console.log(`removed ${result.removed}`);
    return;
  }
  const enabled = action === "enable";
  const result = (await callRuntimeRPC<{ name: string }>({
    url,
    token,
    method: "skill.setEnabled",
    params: { name, enabled },
  })) as { name: string };
  console.log(`${result.name} ${enabled ? "enabled" : "disabled"}`);
}
