#!/usr/bin/env bun
/**
 * Remove the deterministic CEF smoke fixtures that were written by the
 * engineering-intelligence smoke harness.
 *
 * This is intentionally narrow: it requires an explicit session id and only
 * matches the exact fixture prose/ids used by the smoke, so a user's real
 * decision records are not touched. The script prints a dry-run count by
 * default; pass --apply to delete.
 *
 * Usage:
 *   bun scripts/cleanup-governance-fixtures.ts \
 *     --db /path/to/sessions.db \
 *     --session ses_ae4df1f46b584bac \
 *     --apply
 */
import { Database } from "bun:sqlite";

type Options = {
  db?: string;
  session?: string;
  apply: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--db") options.db = argv[++index];
    else if (arg === "--session") options.session = argv[++index];
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.db || !options.session) {
  console.error(
    "usage: bun scripts/cleanup-governance-fixtures.ts --db <sessions.db> --session <sessionID> [--apply]",
  );
  process.exit(2);
}

const fixturePatterns = [
  "%CEF real session choice%",
  "%plan:cef:s1%",
  "%CEF completion card%",
  "%CEF validation runner evidence%",
  "%editing a CEF smoke file%",
  "%cef-plan%",
] as const;

const db = new Database(options.db);
try {
  db.exec("PRAGMA busy_timeout=5000");
  const where = fixturePatterns.map(() => "(event LIKE ?)").join(" OR ");
  const params = [options.session, ...fixturePatterns];
  const count =
    db
      .query<{ count: number }, string[]>(
        `SELECT count(*) AS count FROM events
        WHERE session_id = ? AND (${where})`,
      )
      .get(...params)?.count ?? 0;

  console.log(
    JSON.stringify(
      {
        db: options.db,
        session: options.session,
        fixtures: count,
        apply: options.apply,
      },
      null,
      2,
    ),
  );
  if (options.apply && count > 0) {
    const result = db
      .query(
        `DELETE FROM events
          WHERE session_id = ? AND (${where})`,
      )
      .run(...params);
    console.log(JSON.stringify({ deleted: result.changes }, null, 2));
  }
} finally {
  db.close();
}
