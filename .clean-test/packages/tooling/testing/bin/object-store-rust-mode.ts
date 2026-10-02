/**
 * The object-store-rust plan's Phase A acceptance runner: the EXISTING
 * object-store suite, executed with the Rust loose-path engaged. The
 * mode is an explicit demand — this script builds the cdylib, PROVES
 * the backend actually engaged (an unavailable backend in rust mode is
 * a failure, never a silent TypeScript pass: the acceptance must not
 * prove nothing), runs the suite, and propagates its exit code.
 */
import { spawnSync } from "node:child_process";
import {
  objectStoreBackendStatus,
  rustCas,
} from "../../../framework/object-store/src/rust-store";

process.env.NATALIA_OBJECT_STORE_BACKEND = "rust";
await rustCas.ensureBuilt();

const engaged = objectStoreBackendStatus();
if (engaged !== "rust") {
  console.error(
    `object-store-rust-mode: backend not engaged (status: ${engaged}) — refusing to run a "rust mode" acceptance that would actually test TypeScript`,
  );
  process.exit(2);
}

const child = spawnSync(
  process.execPath,
  ["test", "packages/framework/object-store/test", "--timeout", "120000"],
  { stdio: "inherit", env: process.env },
);
process.exit(child.status ?? 1);
