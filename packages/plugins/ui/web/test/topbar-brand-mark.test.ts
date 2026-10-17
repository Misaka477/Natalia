/**
 * The top bar carries the app's mark, not a letter.
 *
 * It drew a blue rounded square with a white "N" in it — a placeholder that
 * looked like a logo and was not one. The mark itself has a single source: the
 * vector master `assets/source/natalia-icon.svg`, which
 * `scripts/build-app-icons.ts` renders into the PNG set, the .ico, the shell's
 * favicon, AND now `apps/web/public/brand.png` — the size the top bar draws.
 *
 * The path is root-relative on purpose: this UI ships as a PLUGIN bundle served
 * by the runtime from a different origin than the shell, so a hashed asset name
 * or a bundle-relative URL would not resolve. `public/` is copied verbatim by
 * Vite into the build output, and the static server already serves `.png`.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..", "..", "..");

async function source(...segments: string[]): Promise<string> {
  return await Bun.file(join(repo, ...segments)).text();
}

test("the top bar renders the image, and no letter", async () => {
  const app = await source("plugins", "ui", "web", "src", "app-neu.tsx");
  expect(app).toContain('<img class="neu-topbar-logo" src="/brand.png"');
  expect(app).not.toContain('<span class="neu-topbar-logo">N</span>');
});

test("the logo frame keeps its shape and drops the placeholder styling", async () => {
  const styles = await source(
    "plugins",
    "ui",
    "web",
    "src",
    "styles",
    "base.ts",
  );
  const at = styles.indexOf(".neu-topbar-logo {");
  expect(at).toBeGreaterThan(0);
  const rule = styles.slice(at, styles.indexOf("}", at));
  expect(rule).toContain("object-fit: cover");
  // The blue square and the bold letter were the placeholder.
  expect(rule).not.toContain("background: var(--neu-accent)");
  expect(rule).not.toContain("font-weight");
});

test("the mark comes from the icon master, not a hand-drawn copy", async () => {
  // `repo` here is the `packages` directory (four levels up from this test);
  // the generator and the shell's public dir sit one level above it.
  const root = join(repo, "..");
  const script = await Bun.file(
    join(root, "scripts", "build-app-icons.ts"),
  ).text();
  // One source, one generator: the web copy is rendered from the same variant
  // as every other icon output, not duplicated by hand.
  expect(script).toContain(
    'const WEB_BRAND = join(ROOT, "apps", "web", "public", "brand.png")',
  );
  expect(script).toContain("const WEB_BRAND_SIZE = 64");
  expect(script).toContain("const brand = rendered.get(WEB_BRAND_SIZE)!");
  // And the generated file is in the tree the shell serves.
  const brand = Bun.file(join(root, "apps", "web", "public", "brand.png"));
  expect(await brand.exists()).toBe(true);
  expect(await brand.size).toBeGreaterThan(1000);
});
