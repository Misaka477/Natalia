import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const expectedLicense = "Apache-2.0";
const manifests = [
  "package.json",
  ...(await workspaceManifests("apps")),
  ...(await workspaceManifests("packages")),
];

for (const path of manifests) {
  const manifest = (await Bun.file(path).json()) as { license?: string };
  if (manifest.license !== expectedLicense)
    throw new Error(
      `${path} must declare ${expectedLicense}, found ${manifest.license ?? "missing"}`,
    );
}

for (const path of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.txt",
]) {
  if (!(await Bun.file(path).exists()) || Bun.file(path).size === 0)
    throw new Error(`missing release license artifact: ${path}`);
}

const licenses = new Map<string, string[]>();
const packageLicenses = new Map<
  string,
  { license: string; path: string; text: string }
>();
const packageRoot = "node_modules/.bun";
if (!(await Bun.file("bun.lock").exists())) throw new Error("missing bun.lock");
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
        await recordPackage(`${modules}/${entry.name}/${name}/package.json`);
      continue;
    }
    await recordPackage(`${modules}/${entry.name}/package.json`);
  }
}

const forbidden = [...licenses].filter(([license]) =>
  /(?:^|\W)(?:AGPL|GPL|LGPL)(?:\W|$)/iu.test(license),
);
if (forbidden.length)
  throw new Error(
    `copyleft npm dependency requires release review: ${forbidden.map(([license, packages]) => `${license}: ${packages.join(", ")}`).join("; ")}`,
  );
if (licenses.has("UNKNOWN"))
  throw new Error(
    `dependency license metadata missing: ${licenses.get("UNKNOWN")!.join(", ")}`,
  );

const generatedLicenses = `${[
  "THIRD-PARTY LICENSE TEXTS",
  "Generated from the installed dependency tree by scripts/license-check.ts.",
  "",
  ...[...packageLicenses]
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
const generatedPath = "THIRD_PARTY_LICENSES.txt";
const existingLicenses = await Bun.file(generatedPath).text();
if (existingLicenses !== generatedLicenses)
  throw new Error(
    `${generatedPath} is stale; run: bun scripts/generate-third-party-licenses.ts`,
  );

console.log(
  JSON.stringify(
    {
      workspaceLicense: expectedLicense,
      manifests: manifests.length,
      dependencyLicenses: Object.fromEntries(
        [...licenses]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([license, packages]) => [license, packages.sort()]),
      ),
      artifacts: [
        "LICENSE",
        "NOTICE",
        "THIRD_PARTY_NOTICES.md",
        "THIRD_PARTY_LICENSES.txt",
      ],
    },
    null,
    2,
  ),
);

async function workspaceManifests(root: string) {
  const paths: string[] = [];
  const skipped = new Set([
    ".git",
    ".turbo",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipped.has(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (await Bun.file(join(path, "package.json")).exists()) {
        paths.push(`${path}/package.json`);
        continue;
      }
      await visit(path);
    }
  };
  await visit(root);
  return paths;
}

async function recordPackage(path: string) {
  if (!(await Bun.file(path).exists())) return;
  const manifest = (await Bun.file(path).json()) as {
    name?: string;
    version?: string;
    license?: string;
  };
  const license = manifest.license ?? "UNKNOWN";
  const packages = licenses.get(license) ?? [];
  const id = `${manifest.name ?? path}@${manifest.version ?? "unknown"}`;
  if (!lockedPackages.has(id)) return;
  if (!packages.includes(id)) packages.push(id);
  licenses.set(license, packages);
  if (packageLicenses.has(id)) return;
  const directory = dirname(path);
  const files = await readdir(directory);
  const licenseFile = files.find((name) =>
    /^(?:LICENSE|LICENCE|COPYING)(?:\.|$)/iu.test(name),
  );
  if (!licenseFile) {
    packageLicenses.set(id, {
      license,
      path,
      text: "No standalone license text was included in the installed package. See the declared SPDX license and upstream package source.",
    });
    return;
  }
  const licensePath = `${directory}/${licenseFile}`;
  packageLicenses.set(id, {
    license,
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
