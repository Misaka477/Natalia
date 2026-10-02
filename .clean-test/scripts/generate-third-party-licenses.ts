import { readdir } from "node:fs/promises";
import { dirname } from "node:path";

const packages = new Map<
  string,
  { license: string; path: string; text: string }
>();
const packageRoot = "node_modules/.bun";
const lockedPackages = new Set(
  [
    ...(await Bun.file("bun.lock").text()).matchAll(
      /:\s*\["([^"]+@[^"\s]+)"/gu,
    ),
  ].map((match) => match[1]!),
);

for (const directory of await readdir(packageRoot)) {
  const modules = `${packageRoot}/${directory}/node_modules`;
  let entries;
  try {
    entries = await readdir(modules, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const name of await readdir(`${modules}/${entry.name}`))
        await record(`${modules}/${entry.name}/${name}/package.json`);
      continue;
    }
    await record(`${modules}/${entry.name}/package.json`);
  }
}

const output = `${[
  "THIRD-PARTY LICENSE TEXTS",
  "Generated from the installed dependency tree by scripts/license-check.ts.",
  "",
  ...[...packages]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([id, entry]) => [
      "=".repeat(80),
      id,
      `Declared license: ${entry.license}`,
      `Source file: ${entry.path}`,
      "=".repeat(80),
      entry.text.trim(),
      "",
    ]),
]
  .join("\n")
  .trimEnd()}\n`;

await Bun.write("THIRD_PARTY_LICENSES.txt", output);
console.log(`generated licenses for ${packages.size} package version(s)`);

async function record(path: string) {
  if (!(await Bun.file(path).exists())) return;
  const manifest = (await Bun.file(path).json()) as {
    name?: string;
    version?: string;
    license?: string;
  };
  const id = `${manifest.name ?? path}@${manifest.version ?? "unknown"}`;
  if (!lockedPackages.has(id)) return;
  if (packages.has(id)) return;
  const directory = dirname(path);
  const files = await readdir(directory);
  const licenseFile = files.find((name) =>
    /^(?:LICENSE|LICENCE|COPYING)(?:\.|$)/iu.test(name),
  );
  if (!licenseFile) {
    packages.set(id, {
      license: manifest.license ?? "UNKNOWN",
      path,
      text: "No standalone license text was included in the installed package. See the declared SPDX license and upstream package source.",
    });
    return;
  }
  const licensePath = `${directory}/${licenseFile}`;
  packages.set(id, {
    license: manifest.license ?? "UNKNOWN",
    path: licensePath,
    text: normalizeLicenseText(await Bun.file(licensePath).text()),
  });
}

function normalizeLicenseText(text: string) {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}
