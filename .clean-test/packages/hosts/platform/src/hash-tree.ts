import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Content inventory of a directory tree: every file with its SHA256 and
 * size, paths relative to a base (the manifest root).
 *
 * The one home for the checksum-manifest walk — the release build, the
 * store export and the debug bundle all write "these files, verified
 * this way", and three copies of the walk would be three chances to get
 * verification subtly different.
 */
export type HashedFile = { file: string; sha256: string; bytes: number };

export async function hashTreeFiles(
  root: string,
  relativeTo: string = root,
): Promise<{ files: HashedFile[]; bytes: number }> {
  const files: HashedFile[] = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const size = (await stat(full)).size;
        bytes += size;
        files.push({
          file: relative(relativeTo, full),
          sha256: createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
          bytes: size,
        });
      }
    }
  };
  await walk(root);
  files.sort((left, right) => left.file.localeCompare(right.file));
  return { files, bytes };
}
