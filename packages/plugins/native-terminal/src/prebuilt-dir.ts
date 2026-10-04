// prebuilt-dir.ts — where our own native bridges live, by platform.
//
// Extracted verbatim from the deleted native-terminal.ts when the WezTerm
// fork chain went away: the pty controller needs exactly these two
// helpers from that 2146-line file, and carrying the whole host to keep
// them alive was the opposite of the retirement.
import { join } from "node:path";

export function platformTriple(os: NodeJS.Platform = process.platform): string {
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const system = os === "win32" ? "windows" : os === "darwin" ? "darwin" : os;
  return `${system}-${arch}`;
}

/**
 * The one place a downloaded or unpacked Natalia drops our native bridges
 * into (the prebuilt/ drop the release archive makes).
 */
export function nativeTerminalPrebuiltDir(
  os: NodeJS.Platform = process.platform,
): string {
  return join(import.meta.dir, "..", "prebuilt", platformTriple(os));
}
