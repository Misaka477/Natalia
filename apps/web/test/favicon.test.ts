// The favicon 404 in the user's console. `index.html` has no <link rel="icon">,
// so the browser asks /favicon.ico on its own and the web shell has no such
// file. Harmless, but it is a real 404 on every launch and it is trivially
// fixed by shipping an icon the shell can serve.
import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Three levels up from apps/web/test is the repository root. Four is one too
// many and lands outside the repo entirely (measured: it resolved to
// E:\Development), which is why the first version of this test read a file that
// was not there.
const repoRoot = join(import.meta.dir, "..", "..", "..");
const webDir = join(repoRoot, "apps", "web");

test("the web shell declares an icon, so the browser stops asking for /favicon.ico", async () => {
  // Measured: the user's console showed
  //   Failed to load resource: the server responded with a status of 404 (Not Found)
  //   :8791/favicon.ico:1
  // The shell's index.html names no icon at all, so the browser falls back to
  // requesting /favicon.ico, which nothing serves.
  // `statSync`, not `Bun.file().size`: on this bun the file handle's size reads
  // 0 for a file that plainly has bytes (measured: 2583-byte index.html
  // reported size 0), which failed this assertion while the file was fine.
  expect(statSync(join(webDir, "index.html")).size).toBeGreaterThan(0);
  const text = await Bun.file(join(webDir, "index.html")).text();
  expect(text).toContain('rel="icon"');
});

test("the icon file it declares actually exists", async () => {
  const text = await Bun.file(join(webDir, "index.html")).text();
  const href = /rel="icon"[^>]*href="([^"]+)"/u.exec(text)?.[1];
  expect(href, "index.html must declare an icon href").toBeDefined();
  // The shell serves its own directory, so a root-relative href must resolve
  // inside it.
  const target = join(webDir, href!.replace(/^\//u, ""));
  expect(
    existsSync(target),
    `declared icon ${href} does not exist at ${target}`,
  ).toBe(true);
});
