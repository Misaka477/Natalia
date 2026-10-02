import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginPackageSource } from "@anthelia/contracts";
import {
  computePluginPackageHash,
  discoverPluginManifests,
  pluginManifestSchema,
  type PluginInstallationMetadata,
} from "@anthelia/plugin";
import {
  closureDependencies,
  packageDirectory,
  readPackageRecord,
} from "./closure";

export async function validateStagedPackage(
  prefix: string,
  spec: string,
  expectedPackageName?: string,
) {
  const dependencies = await closureDependencies(prefix);
  const packageNames = Object.keys(dependencies);
  if (!expectedPackageName && packageNames.length !== 1)
    throw new Error(
      `plugin install must produce exactly one package; found ${packageNames.length}`,
    );
  const packageName = expectedPackageName ?? packageNames[0]!;
  if (!dependencies[packageName])
    throw new Error(
      `installed package is missing from closure: ${packageName}`,
    );
  const packageDir = packageDirectory(prefix, packageName);
  const realNodeModules = await realpath(join(prefix, "node_modules"));
  const realPackageDir = await realpath(packageDir);
  if (containedRelative(realNodeModules, realPackageDir) === undefined)
    throw new Error(`plugin package escapes node_modules: ${packageDir}`);
  const manifests = await discoverPluginManifests(packageDir, {
    nodeModules: false,
  });
  if (manifests.length !== 1)
    throw new Error(
      `installed package ${packageName} must contain exactly one natalia.plugin.json; found ${manifests.length}`,
    );
  const { manifest, path: manifestPath } = manifests[0]!;
  const realManifestPath = await realpath(manifestPath);
  const relativeManifest = containedRelative(realPackageDir, realManifestPath);
  if (relativeManifest === undefined)
    throw new Error(
      `plugin manifest escapes package directory: ${manifestPath}`,
    );
  const entryPath = await realpath(
    new URL(manifest.entry, pathToFileURL(manifestPath).href),
  );
  if (containedRelative(realPackageDir, entryPath) === undefined)
    throw new Error(
      `plugin entry escapes package directory: ${manifest.entry}`,
    );
  const module = (await import(
    `${pathToFileURL(entryPath).href}?validation=${randomUUID()}`
  )) as {
    default?: unknown;
  };
  validatePluginModule(module.default, manifest);
  const record = await readPackageRecord(prefix, packageName);
  if (!record?.version)
    throw new Error(
      `package-lock is missing installed package record: ${packageName}`,
    );
  const resolvedVersion = record.version;
  if (resolvedVersion !== manifest.version)
    throw new Error(
      `plugin ${manifest.id} manifest version ${manifest.version} does not match installed package ${resolvedVersion}`,
    );
  const metadata: PluginInstallationMetadata = {
    id: manifest.id,
    source: packageSource(spec),
    resolvedVersion,
    ...(record?.integrity ? { integrity: record.integrity } : {}),
    // Our pin over what is on disk — the load-time verification's anchor.
    contentHash: await computePluginPackageHash(packageDir),
    scope: manifest.scope,
    dependencies:
      manifest.apiVersion === 2 || manifest.apiVersion === 3
        ? manifest.dependencies.map((dependency) => ({
            id: dependency.id,
            resolvedVersion: "unresolved",
            optional: dependency.optional,
            peer: dependency.peer,
          }))
        : [],
  };
  return { manifest, relativeManifest, packageName, metadata };
}

function validatePluginModule(value: unknown, manifest: unknown) {
  const plugin = typeof value === "function" ? value() : value;
  if (!plugin || typeof plugin !== "object")
    throw new Error(
      "plugin entry must have a default plugin or factory export",
    );
  const candidate = plugin as { manifest?: unknown; setup?: unknown };
  if (typeof candidate.setup !== "function")
    throw new Error("plugin entry default export must have a setup function");
  const exportedManifest = pluginManifestSchema.parse(candidate.manifest);
  if (JSON.stringify(exportedManifest) !== JSON.stringify(manifest))
    throw new Error("plugin entry manifest does not match natalia.plugin.json");
}

function containedRelative(parent: string, child: string) {
  const value = relative(parent, child);
  if (value === ".." || value.startsWith(`..${sep}`)) return undefined;
  return value;
}

export function packageSource(spec: string): PluginPackageSource {
  if (spec.startsWith("git+") || spec.endsWith(".git"))
    return { type: "git", url: spec };
  if (/^(?:https?:).*\.(?:tgz|tar\.gz)$/iu.test(spec))
    return { type: "tarball", url: spec };
  if (spec.startsWith("file:") || spec.startsWith(".") || spec.startsWith("/"))
    return { type: "path", path: spec.replace(/^file:/u, "") };
  return { type: "registry", spec };
}

export function sourceSpec(source: PluginPackageSource) {
  if (source.type === "registry") return source.spec;
  if (source.type === "path") return `file:${source.path}`;
  if (source.type === "tarball") return source.url;
  return source.ref ? `${source.url}#${source.ref}` : source.url;
}
