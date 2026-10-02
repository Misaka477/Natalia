const version = process.env.NATALIA_TS_VERSION ?? "0.0.0-ts7";
const target =
  process.env.NATALIA_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
const entrypoint = "apps/cli/src/main.ts";

if (!Bun.file(entrypoint).size)
  throw new Error(`missing TS CLI entrypoint: ${entrypoint}`);
for (const artifact of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.txt",
]) {
  if (!(await Bun.file(artifact).exists()) || Bun.file(artifact).size === 0)
    throw new Error(`missing release license artifact: ${artifact}`);
}
const manifest = (await Bun.file("package.json").json()) as {
  license?: string;
};
if (manifest.license !== "Apache-2.0")
  throw new Error("workspace package.json must declare Apache-2.0");

console.log(
  JSON.stringify(
    {
      name: "natalia-ts",
      version,
      target,
      entrypoint,
      install: "bun apps/cli/src/main.ts",
      rollback:
        "TS-only release; restore the prior repository revision if rollback is required",
      releaseReady: true,
      license: manifest.license,
      licenseArtifacts: [
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
