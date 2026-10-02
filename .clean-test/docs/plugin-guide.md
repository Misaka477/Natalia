# Natalia Plugin Guide - v2

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

> `PLUGIN_API_VERSION` is `2`. A plugin is one package containing its package
> metadata, `natalia.plugin.json`, entry module, and implementation. The plugin
> API is an in-process host extension surface, not an RPC surface.

Read this guide in two passes:

1. [From zero](#2-from-zero-a-new-plugin-and-a-new-ui) if you want to create,
   install, enable, disable, or uninstall a plugin or UI today.
2. The later sections for manifest, API, store semantics, and UI host details.

## 1. One plugin system

Natalia has one plugin type. Official plugins and packages installed by users
use the same registry, declared names, permissions, dependency resolution, and
load/unload lifecycle. An official plugin is only distribution configuration; it
does not receive a privileged API or a separate lifecycle. UI adapters are the
same plugin type: create, install, enable, disable, and uninstall them with the
plugin commands.

Plugins do not wrap Natalia's own framework. Agent turn/step execution,
providers and model selection, sessions and configuration, transport/SDK/daemon,
CLI/web UI hosts, permissions and approval, sandbox, checkpoint, engineering
intelligence, workspace, runtime status, and diagnostics are constructed and
owned directly by the runtime or host. They have no plugin manifest, unloadable
plugin ID, `plugins.enabled` gate, or plugin-catalog entry. A package is a plugin
only when removing it leaves the runtime's core semantics complete. Independent
model tools and UI adapters can therefore be plugins, but they do not own the
corresponding framework controller lifecycle.

Plugins are trusted code. They are imported into the runtime process without a
VM, filesystem sandbox, network sandbox, or execution timeout. Manifest
`integrationPoints` govern contribution ownership and validation, not process
isolation. Install only packages you wrote or audited.

The v2 integration points are `tools`, `commands`, `events`, `services`,
`resources`, `projections`, `workflows`, `settingsSchema`, `adapters`, and
`schedulerJobs`. Declaring an integration point authorizes its API. Tools and
commands keep the names they declare; Natalia does not add a plugin prefix.
Tool approval follows each tool's `requiresApproval` declaration and the normal
runtime policy path. There is no plugin-class-based forced approval.

## 2. From zero: a new plugin and a new UI

UI is not a second system. Both paths create one package, install it once into
the Natalia instance `plugin-store`, and enable it in the current workspace.
Replace `npm run ts:cli --` with `natalia-ts` in an installed release.

### New plugin (command or tool)

```bash
# 1. Scaffold. Use --template tool for a tool, --language ts for TypeScript.
npm run ts:cli -- plugin create ./demo-plugin \
  --id yourco.demo \
  --package @yourco/natalia-demo

# 2. Edit src/index.js (and src/index.ts if you used --language ts).
#    Keep natalia.plugin.json identical to the exported manifest.

# 3. Install into the instance store. This also enables the plugin here.
npm run ts:cli -- plugin install ./demo-plugin
npm run ts:cli -- plugin list
npm run ts:cli -- plugin doctor

# 4. Use it, then toggle or remove it without reinstalling in other workspaces.
npm run ts:cli -- plugin disable yourco.demo
npm run ts:cli -- plugin enable yourco.demo
npm run ts:cli -- plugin uninstall yourco.demo
```

A TypeScript scaffold still installs `src/index.js`. After editing
`src/index.ts`, copy or compile that change into `src/index.js` before
`plugin install`. Do not set the manifest `entry` to a `.ts` file.

### New UI

```bash
# 1. Scaffold a UI adapter plugin.
npm run ts:cli -- plugin create ./demo-ui \
  --id yourco.web \
  --package @yourco/natalia-ui-web \
  --template ui

# 2. Edit src/index.js. Registration is inert until a host mounts the kind.
#    The template kind is ui.yourco.web unless the plugin id already starts
#    with ui.

# 3. Install once, then launch by adapter kind.
npm run ts:cli -- plugin install ./demo-ui
npm run ts:cli -- ui
npm run ts:cli -- ui ui.yourco.web

# 4. The same enable/disable/uninstall commands apply.
npm run ts:cli -- plugin disable yourco.web
npm run ts:cli -- plugin enable yourco.web
npm run ts:cli -- plugin uninstall yourco.web
```

`natalia-ts ui` lists adapter kinds from enabled plugins.
`natalia-ts ui <kind>` mounts that UI in-process against a real runtime.

### After the first install

```bash
# Source changes: reinstall the same directory or a packed tarball.
npm run ts:cli -- plugin install ./demo-plugin
npm pack ./demo-plugin
npm run ts:cli -- plugin install ./yourco-natalia-demo-1.0.0.tgz

# Restart or reload a long-running Natalia process to pick up desired state.
npm run ts:cli -- plugin doctor
```

The web shell Plugin Manager can install, enable, disable, uninstall, audit, and
repair the same instance store. Doctor and reconcile do not replace
`plugin install`.

## 3. Package layout

A publishable plugin package has this shape:

```text
my-natalia-plugin/
  package.json
  natalia.plugin.json
  src/index.js
```

Create this package with the CLI. The installed release command is currently
`natalia-ts`; repository examples use `npm run ts:cli --`:

```bash
natalia-ts plugin create ./my-natalia-plugin \
  --id yourco.demo \
  --package @yourco/natalia-demo
natalia-ts plugin create ./my-tool --id yourco.echo --template tool
natalia-ts plugin create ./my-ui --id yourco.web --template ui
natalia-ts plugin create ./my-ts --id yourco.ts --language ts
```

`--package` is optional and defaults to the directory basename. `--template`
selects `command` (default), `tool`, or `ui`. `--language` selects `js`
(default) or `ts`. The directory is resolved from the process working
directory; `--workspace` does not relocate scaffold output. Creation fails if
the target directory already exists. Natalia installs `src/index.js`; a
TypeScript scaffold also writes `src/index.ts` for editing, but the published
entry remains JavaScript so the installed package does not depend on Bun or a
TypeScript source loader. A UI package is a normal plugin; it is installed,
uninstalled, enabled, and disabled with the same commands. The web shell Plugin
Manager can also audit and repair the instance plugin store.

The package declares every Natalia package it imports as a dependency:

```json
{
  "name": "@yourco/natalia-demo",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "natalia.plugin.json"],
  "exports": { ".": "./src/index.js" },
  "dependencies": {
    "@anthelia/plugin": "<compatible-version>"
  }
}
```

Use versions compatible with the Natalia distribution you target. The package
manager installs the complete package closure once in the Natalia instance's
`plugin-store`; every workspace uses that same installation. Do not ask users
to create SDK symlinks or copy an entry file separately.
Add `@anthelia/contracts`, `@anthelia/tools`, or another Natalia package only when
the implementation imports it. `@natalia/sdk` is the RPC client SDK and is not
the plugin authoring API.

## 4. Manifest v2

```json
{
  "apiVersion": 2,
  "id": "yourco.demo",
  "version": "1.0.0",
  "name": "Demo",
  "description": "A demonstration plugin.",
  "entry": "src/index.js",
  "scope": "workspace",
  "provides": [],
  "requires": [],
  "optionalRequires": [],
  "conflicts": [],
  "dependencies": [],
  "hooks": {},
  "integrationPoints": ["tools", "commands"]
}
```

- `id` matches `[a-z0-9][a-z0-9._-]*` and is the registry owner id.
- `version` is a semantic version and must match `package.json`; `entry` is a
  local `.js`, `.mjs`, or `.ts` file contained by the published package. Use a
  JavaScript entry for packages intended to run outside the Natalia source
  workspace.
- `scope` is `process`, `workspace`, or `session`. It is lifecycle attribution,
  not a security boundary.
- `provides`, `requires`, and `optionalRequires` describe service contracts.
- `conflicts` and `dependencies` participate in deterministic dependency
  resolution. A dependency can set `optional` or `peer`.
- `hooks` is reserved and must currently be `{}`. Natalia installs and removes
  packages with npm lifecycle scripts disabled, and does not execute plugin
  hook commands implicitly.
- `integrationPoints` must include every contribution API used by `setup`.

Manifest validation, dependency checks, and configuration validation complete
before activation. If `setup` fails, registrations made during that activation
are rolled back and the plugin is audited as `failed`.

## 5. Implement a plugin

```js
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest: {
    apiVersion: 2,
    id: "yourco.demo",
    version: "1.0.0",
    name: "Demo",
    description: "A demonstration plugin.",
    entry: "src/index.js",
    scope: "workspace",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["tools", "commands"],
  },
  setup(api) {
    api.tools.register({
      name: "echo",
      description: "Echo the input.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(input) {
        return (input as { text: string }).text;
      },
    });
    api.commands.register({
      name: "demo.hello",
      title: "Say hello",
      run() {
        console.log("hello from yourco.demo");
      },
    });
  },
});
```

`echo` and `demo.hello` are the registered names. Duplicate names are rejected;
choose globally meaningful names. Every registration returns a disposer, and
registry unload also disposes all owned contributions. `setup` and plugin
`dispose` may be asynchronous.

Plugins can declare a Standard Schema `configSchema`. The validated value is
available as `api.config`, sourced from `plugins.settings[pluginID]`. Invalid
configuration prevents activation rather than creating a partial plugin.

### Plugin API reference

Every contribution method checks the corresponding `integrationPoints` entry.
Using an undeclared API fails activation with `plugin capability denied`.
Registration methods return an idempotent disposer and the registry also calls
all remaining disposers in reverse registration order during unload.

| Manifest point   | API                                                    | Contract                                                                                                               |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `tools`          | `api.tools.register(tool)`                             | Registers a globally named `RuntimeTool`; duplicate names fail.                                                        |
| `tools`          | `api.tools.registerAlias(alias, target)`               | Registers a tool alias and returns its disposer.                                                                       |
| `commands`       | `api.commands.register(command)`                       | Registers a globally named command; duplicate names fail.                                                              |
| `events`         | `api.events.on(listener)`                              | Receives every event dispatched through the plugin registry.                                                           |
| `events`         | `api.events.on(type, listener)`                        | Receives events whose object `type` equals the supplied string.                                                        |
| `services`       | `api.services.provide(name, value)`                    | Provides a service listed in manifest `provides`; every declared service must be provided before setup completes.      |
| none             | `api.services.get<T>(name)`                            | Reads a currently available host service.                                                                              |
| none             | `api.services.on<T>(name, listener)`                   | Watches a service provider change; the listener is called on changes, not immediately at registration.                 |
| `resources`      | `api.resources.register({ name, ... })`                | Registers a host-defined named resource contribution; `workspace-file` is the stable read-only shape documented below. |
| `projections`    | `api.projections.register({ name, ... })`              | Registers a host-defined named projection contribution.                                                                |
| `workflows`      | `api.workflows.register({ name, ... })`                | Registers a host-defined named workflow contribution.                                                                  |
| `settingsSchema` | `api.settingsSchema.register({ name, ... })`           | Registers a host-defined named settings-schema contribution.                                                           |
| `adapters`       | `api.adapters.register({ name, adapterType, create })` | Registers a lazy adapter factory whose instance has `dispose()`.                                                       |
| `adapters`       | `api.adapters.registerUi({ kind, mount, dispose })`    | Convenience API for a UI adapter; the contribution name is `kind`.                                                     |
| `schedulerJobs`  | `api.scheduler.add({ name, ... })`                     | Registers a host-defined named scheduler job.                                                                          |
| `cache`          | `api.cache.registerKind(kind)`                         | Registers a deterministic cache kind; the disposer unregisters it and drops its entries.                               |
| `cache`          | `api.cache.compute(kindID, key, compute)`              | Looks up `key` in the kind, else runs `compute` once (single-flight). Unknown kinds fail loudly.                       |
| `cache`          | `api.cache.metrics(kindID?)`                           | Per-kind cost observability (hits, misses, invalidations, bytes).                                                      |

`resources`, `projections`, `workflows`, `settingsSchema`, and scheduler jobs
share only the stable `{ name: string }` ownership contract. Their additional
payload is defined by the host that consumes that contribution; do not assume a
universal payload shape that is not exported by that host.

### Plugin-owned workspace resources

`resources` has one stable host-defined shape today: a read-only workspace file.
Declare `resources` in `integrationPoints`, register the resource in `setup`,
and read it through the generic workspace surface. The framework does not learn
the plugin's business directory.

```js
// natalia.plugin.json
"integrationPoints": ["tools", "resources"]

// src/index.js
api.resources.register({
  name: "session-artifact-store",
  kind: "workspace-file",
  access: "read",
  scope: "session",
  path: ".natalia/artifacts/{sessionID}.json",
  description: "Durable artifacts for the current session",
});
```

Rules:

- `path` is workspace-relative, uses `/`, and supports the built-in
  `{sessionID}` / `{workspaceID}` placeholders. Each placeholder is resolved
  from trusted runtime context and must expand to a single safe path segment.
- `params` optionally declares additional single-segment placeholders owned by
  the plugin, for example:
  ```js
  params: ["artifactID"],
  path: ".natalia/artifacts/{artifactID}.json",
  ```
  The framework treats those names as opaque data. It validates syntax,
  uniqueness, and single-segment safety; it does not interpret the business
  meaning.
- Wildcards, `..`, absolute paths, and unknown placeholders are rejected.
- The first version allows plugin-owned resources only under `.natalia/`.
  Reserved paths such as `.natalia/config.json` and `.natalia/sessions/**` are
  refused even if a plugin declares them.
- The declaration is read-only and is removed when the owning plugin unloads.
- Read through `runtime.workspaceRead({ path })`. The runtime matches the exact
  declared path and asks the platform to allow only that exact ignored path;
  containment, symlink, and size policy still apply.
- Keep `natalia.plugin.json` and the exported manifest in sync. Run
  `ts:build`/plugin install so both carry the same `integrationPoints`.

Reader-scoped resources use the named read API. A resource may declare
`readers: ["yourco.web"]` and `audit: true`; the UI host then passes its plugin
id for you:

```js
const contents = await ctx.resources.read({
  resource: "session-artifact-store",
  params: { sessionID },
});
```

External consumers can call `runtime.resourceRead({ resource, params, reader })`.
The runtime resolves the declaration, verifies the `readers` allowlist, reads the
exact declared path, and publishes a live `resource.read` event when `audit` is
true. Resources with a `readers` list are intentionally not available through the
path-based `workspaceRead` route.

The APIs below do not require an `integrationPoints` declaration:

- `api.config` is the synchronously validated value from
  `plugins.settings[pluginID]`, or the raw value when no `configSchema` exists.
- `api.runtimeConfig?.()` returns the current host runtime configuration when
  that host exposes it. Treat it as optional and prefer plugin-specific config.
- `api.effects.signal` is aborted when the plugin unloads.
- `api.effects.run(effect)` tracks asynchronous work. Unload aborts its signal
  and waits for all tracked promises to settle. Pass the signal through to I/O.

`RuntimeTool` requires `name`, `description`, `requiresApproval`, an object JSON
schema in `parameters`, and an async `execute(input, context)` returning a
string. `context` includes `workspaceRoot`, optional `sessionID` and
`AbortSignal`, plus host services appropriate to the current runtime. A command
requires `name`, `title`, and `run(invocation?)`; invocation contains `raw`,
`args`, `workspaceRoot`, optional `sessionID`, and optional `signal`.

### Renderer-side UI manifests

The v2 manifest may declare a renderer-side UI entry that the web shell loads
through the same dynamic plugin catalog path used for every plugin:

```json
{
  "apiVersion": 2,
  "id": "yourco.feature",
  "version": "1.0.0",
  "entry": "index.js",
  "ui": {
    "entry": "ui/plugin.js",
    "panels": [
      {
        "id": "feature-settings",
        "title": "Feature",
        "region": "settings",
        "group": "扩展"
      }
    ]
  }
}
```

The UI entry is a browser module that exports `createUiPlugin()` returning a
`UiPlugin` from `@natalia/ui-host`. It is served from the plugin store as
`GET /plugins/<pluginId>/ui.js` and loaded by the shell's dynamic UI loader.
There is no separate official/third-party registration path: every plugin with
`ui.entry` is discovered from the same `pluginCatalog`.

### Configuration

Zod schemas implement Standard Schema and can be used directly. Validation must
be synchronous:

```js
import { z } from "zod";
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest,
  configSchema: z.object({
    endpoint: z.string().url(),
    retries: z.number().int().min(0).default(3),
  }),
  setup(api) {
    const config = api.config;
    // config is the parsed { endpoint, retries } value.
  },
});
```

Add `zod` to the plugin package dependencies when using it. Configure the
plugin in `<workspace>/.natalia/config.json`:

```json
{
  "version": 3,
  "plugins": {
    "settings": {
      "yourco.demo": {
        "endpoint": "https://example.test",
        "retries": 5
      }
    }
  }
}
```

An invalid value fails before `setup` and reports the failing property path.
Async Standard Schema validation is deliberately rejected.

### Services and plugin dependencies

`requires` contains mandatory service names. A plugin remains `pending` until
all are available; if a required provider disappears or changes, the registry
deactivates and then reactivates the consumer against the new provider.
`optionalRequires` documents optional service contracts but does not gate
activation. `provides` must exactly cover services supplied through
`api.services.provide`: undeclared services fail immediately and omitted
declared services fail when `setup` finishes.

Manifest `dependencies` describe relationships between plugins:

```json
{
  "dependencies": [
    { "id": "yourco.base", "spec": "^1.2.0", "optional": false, "peer": false }
  ]
}
```

Required dependencies control activation order. Missing or incompatible
dependencies leave a plugin pending; conflicts and duplicate IDs are denied;
cycles remain unresolved. Supported version specs are exact versions, `*`,
`latest`, `workspace:*`, `^`, `~`, `>`, `>=`, `<`, and `<=`. An optional
dependency participates in ordering only when a compatible plugin is present.
The `peer` flag is recorded in installation metadata but currently does not
change runtime resolution.

Manifest dependencies do not install another plugin. Put JavaScript package
dependencies in `package.json`; install each required Natalia plugin separately
and declare its plugin relationship in the manifest.

## 6. Lifecycle commands

The CLI is the authoritative maintenance entry point. The examples below use
the installed release command:

```bash
natalia-ts plugin install @yourco/natalia-demo
natalia-ts plugin list
natalia-ts plugin disable yourco.demo
natalia-ts plugin enable yourco.demo
natalia-ts plugin doctor
natalia-ts plugin reconcile
natalia-ts plugin uninstall yourco.demo
```

`--workspace /path/to/project` applies only to `install`, `enable`, `disable`,
and `list`. It selects the workspace configuration used for enablement; it does
not create a second plugin store. `plugin create` writes to its explicit
directory relative to the current process working directory and does not use
workspace state.

- `install <spec>` stages and validates one package, installs its dependency
  closure into the Natalia instance `plugin-store`, writes
  `<plugin-store>/natalia.lock`, and enables the plugin in the selected
  workspace. A failed operation restores the previous closure and does not
  write a lock entry.
- `list` returns one catalog for official and user-installed packages with
  `id`, `name`, `version`, `scope`, `enabled`, `installed`, `source`, and
  `packageName`.
- `disable <id>` and `enable <id>` only change desired activation state in the
  selected workspace.
- `uninstall <id>` removes an installed package's closure and lock entry from
  the instance plugin store. Official plugins can be restored with
  `plugin reinstall <id>`.
- `doctor` audits installed state; `reconcile` repairs the desired package
  closure. They are recovery commands, not extra installation steps.

`install` accepts npm package specs, including registry versions, local
directories, packed tarballs, Git specs, and remote tarballs:

```bash
natalia-ts plugin install @yourco/natalia-demo@1.0.0
natalia-ts plugin install ./my-natalia-plugin
npm pack ./my-natalia-plugin
natalia-ts plugin install ./yourco-natalia-demo-1.0.0.tgz
```

For local development, rerun `install` after changing the package. For
publication, run `npm pack --dry-run` to verify that `src/index.js` and exactly
one `natalia.plugin.json` are included before `npm publish`.

All maintenance commands, including `create`, print indented JSON. Important
result shapes are:

```json
{ "created": true, "directory": "/absolute/path/my-natalia-plugin", "pluginID": "yourco.demo", "packageName": "@yourco/natalia-demo" }
{ "installed": true, "pluginID": "yourco.demo", "packageName": "@yourco/natalia-demo", "metadata": {}, "enabled": true }
{ "pluginID": "yourco.demo", "enabled": false }
{ "uninstalled": true, "pluginID": "yourco.demo", "disposition": "removed for next reconcile" }
```

`plugin list` returns a sorted JSON array of packages in the instance plugin
store. Installed packages report their recorded registry, path, Git, or tarball
source. `enabled` is false only when the selected workspace configuration
explicitly disables that ID.

These CLI commands persist desired state; they do not directly mutate a plugin
registry already running in another process. A long-running client must reload
its configuration/reconcile its desired catalog, or be restarted. A newly
started CLI, web shell, UI host, or daemon reads the new state. Runtime RPC
`pluginUnload` and `pluginReload` are process-local operations and do not replace
the durable CLI commands.

Installing the same package name and plugin ID again is the upgrade/reinstall
path. The new package must pass staging validation before replacing the live
closure. Changing an installed package's plugin ID or moving an existing plugin
ID to a different package is rejected; uninstall the old identity first when
that change is intentional.

### What installation validates

Installation uses npm with `--ignore-scripts`, stages the package first, then
validates all of the following before committing state:

1. The requested package resolves to a package-lock record with a version.
2. Its package closure contains exactly one `natalia.plugin.json` outside nested
   dependencies.
3. The manifest and entry resolve inside the package directory.
4. `package.json.version`, lock resolution, and manifest `version` agree.
5. The entry imports successfully and default-exports an object with `manifest`
   and `setup()`.
6. The exported manifest equals the file manifest after schema defaults are
   applied.
7. The plugin ID is not reserved by an official plugin and ownership does not
   conflict with the existing lock.

The live closure and `natalia.lock` are owned by the Natalia instance's single
`plugin-store`. Installation and uninstallation never create a workspace-local
package closure. Workspace config only records runtime overrides such as
enablement and settings.

### Doctor and reconcile

An empty array from `plugin doctor` means the installed state is consistent.
Findings use these codes:

| Code                | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `package_missing`   | The locked package is absent from the instance plugin store. |
| `manifest_mismatch` | Installed manifest ID/version differs from the lock.         |

`plugin reconcile` reinstalls packages reported as `package_missing` using their
locked source. Its result contains `reconciled: true`, the original `findings`,
and a second `remaining` audit. It
does not invent a missing lock entry or silently accept a manifest mismatch;
repair those by reinstalling the intended package.

### Common failures

| Error                                                   | Action                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `plugin directory already exists`                       | Choose an empty path; creation never overwrites files.                                    |
| `must contain exactly one natalia.plugin.json`          | Fix the npm `files` list and remove manifests from bundled fixture/source directories.    |
| `plugin entry manifest does not match`                  | Keep the entry export and file manifest identical, including arrays and defaults.         |
| `manifest version ... does not match installed package` | Set the same version in `package.json` and both manifests.                                |
| `plugin capability denied`                              | Add every used contribution API to `integrationPoints`.                                   |
| `plugin config invalid`                                 | Correct `plugins.settings[pluginID]`; the error includes its property path.               |
| `plugin dependency unresolved`                          | Install/enable the required plugin, correct its version spec, or remove a conflict/cycle. |
| `did not provide declared services`                     | Call `api.services.provide` once for every name in `provides`.                            |
| `unknown plugin`                                        | Use the manifest ID shown by `plugin list`, not the npm package name.                     |

The runtime RPC methods `pluginUnload` and `pluginReload` operate on an already
running registry. They do not replace the CLI's durable install, uninstall,
enable, or disable operations.

## 7. UI adapters in depth

A UI is a normal v2 plugin using the existing `adapters` integration point.
The from-zero create/install/launch path is in [section 2](#2-from-zero-a-new-plugin-and-a-new-ui).
This section is the host contract: mount, dispose, checkpoints, and testing.

### Create an external UI package

Use the UI template. It writes `scope: "process"`,
`integrationPoints: ["adapters"]`, a unique adapter `kind`, and the
`@anthelia/contracts` dependency:

```bash
natalia-ts plugin create ./my-ui --id yourco.web --package @yourco/natalia-ui-web --template ui
```

The published package needs `@anthelia/plugin` to register the adapter
and `@anthelia/contracts` when it imports `RuntimeClient`, `RuntimeEvent`,
or other public types:

```json
{
  "name": "@yourco/natalia-ui-web",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "natalia.plugin.json"],
  "exports": { ".": "./src/index.js" },
  "dependencies": {
    "@anthelia/plugin": "<compatible-version>",
    "@anthelia/contracts": "<compatible-version>"
  }
}
```

Do not copy the `workspace:*` dependency versions or `.ts` entry from
`packages/examples/ui-plugin`; that package is a repository fixture. External
packages must publish an importable `.js` or `.mjs` entry and declare real
release-compatible dependency versions.

### Mount and dispose

The UI plugin itself is small. Registration is inert: `mount` runs only after a
UI host selects the adapter kind, and `dispose` must release every listener,
timer, renderer, socket, or other resource created by `mount`.

```js
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest: {
    apiVersion: 2,
    id: "yourco.ui.web",
    version: "1.0.0",
    name: "Web UI",
    description: "Example UI adapter.",
    entry: "src/index.js",
    scope: "process",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["adapters"],
  },
  setup(api) {
    let unsubscribe: (() => void) | undefined;
    api.adapters.registerUi({
      kind: "ui.web",
      async mount(input) {
        const commands = await input.commands.list();
        render({ runtime: input.runtime, commands });
        unsubscribe = input.events.subscribe((event) => update(event));
      },
      dispose() {
        unsubscribe?.();
        unmount();
      },
    });
  },
});
```

The host injects three public ports:

| Port                                  | Use                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.runtime`                       | The complete typed `RuntimeClient`: submit turns, query sessions and resources, call checkpoint methods, and invoke other documented runtime operations. Feature methods are optional, so show an unavailable state when a method is absent. |
| `input.events.subscribe(listener)`    | Subscribes to the shared `RuntimeEvent` stream and returns an unsubscribe function. Keep projected UI state in the adapter; do not create a second runtime or mutate framework state.                                                        |
| `input.commands.list()` / `execute()` | Lists and executes the host's authoritative command catalog. Resolve by command `name`, and pass the raw command plus parsed arguments to `execute`.                                                                                         |

The UI package does not import an internal UI host, checkpoint controller,
registry, or transport implementation. It only uses these public ports and
public `@anthelia/contracts` types. This lets a web or custom
renderer use the same runtime without sharing current UI state or components.

### Checkpoints and message-level restore

Build restore UI around preview, never around a direct workspace mutation:

```js
async function openRestore(input, checkpointID) {
  if (!input.runtime.checkpointPreview || !input.runtime.checkpointRollback)
    return showUnavailable("Checkpoint management is unavailable.");

  const preview = await input.runtime.checkpointPreview(checkpointID);
  renderRollbackPreview(
    preview.changes,
    preview.context,
    preview.resources,
    preview.warnings,
  );

  // An optional dry run returns the same preview without changing the workspace.
  await input.runtime.checkpointRollback({ id: checkpointID, dryRun: true });

  if (!(await confirmRestore(preview))) return;
  const result = await input.runtime.checkpointRollback({
    id: checkpointID,
    dryRun: false,
  });
  showRestored({ safetyCheckpointID: result.safetyCheckpointID });
}
```

`checkpointList()` returns `RuntimeCheckpoint` items with `turnID`. Transcript
message IDs follow `${turnID}:user`, `${turnID}:assistant`, and related segment
forms, so a UI can derive the turn ID and filter checkpoints with
`checkpoint.turnID === turnID`. This supports a `Restore...` action on either a
user message or an assistant reply without coupling to the web UI renderer.

Show every `CheckpointPreview.changes` item with its `add`, `modify`, `delete`,
`rename`, `mode`, or `symlink` kind, plus context truncation, resource policies,
warnings, and whether `complete` is true. Do not offer a restore for an
incomplete checkpoint. A confirmed rollback creates `safetyCheckpointID` before
workspace mutation; surface it explicitly as "Restore is reversible" and allow
the user to restore that safety checkpoint later.

For a light-weight action, a small preview may use one confirmation. For broad
or destructive previews, require the user to review the changed-file list and
warnings before enabling confirmation. The runtime remains authoritative: it
refuses incomplete targets and safety checkpoints even if a UI makes a mistake.

### Test the package

Keep renderer code behind an adapter-local function and test `mount` with a
fake `RuntimeClient`. Assert that registration performs no I/O before
materialization, events update only local UI state, command execution uses the
catalog, and `dispose` stops all event listeners and renderer resources. See
`packages/examples/ui-plugin` and
`packages/plugins/ui/web/test/plugin.test.ts` for an end-to-end materialization
test.

### Launch an installed UI

A UI package is installed like any other plugin and launched by its adapter
kind — one package, two commands:

```bash
natalia-ts plugin install @yourco/natalia-ui-web
natalia-ts ui ui.web
```

`natalia-ts ui <kind>` runs the UI in-process against a real runtime;
`natalia-ts ui` without a kind lists the available UI kinds from enabled
installed and path plugins. The web shell and every installed UI share one generic host,
`createUiAdapterHost` (`@natalia/client`): it resolves the workspace config,
discovers enabled plugins, loads only adapter-capable process plugins into one
process registry, and materializes the requested kind(s) against one shared
`UiAdapterMountInput`. Closing is idempotent and fail-closed (materializer,
then registry, then runtime).

## 8. Official plugin catalog

These IDs are reserved by the Natalia distribution and therefore cannot be
claimed by an installed package. They appear in `plugin list`; unless explicitly
disabled in configuration, catalog state reports them enabled. Some are only
materialized when the current host supplies their required construction input.

| ID                      | Name                       | API | Scope     | Integration points        |
| ----------------------- | -------------------------- | --- | --------- | ------------------------- |
| `natalia-local-tools`   | Local Tools                | v2  | workspace | tools, services           |
| `natalia-mcp`           | MCP Server                 | v2  | session   | tools, services           |
| `natalia-skills`        | Skills                     | v1  | workspace | tools, commands, services |
| `natalia-task-module`   | Task Module                | v2  | session   | tools                     |
| `natalia-task-workflow` | Task Workflow              | v2  | workspace | services, commands        |
| `natalia-team`          | Team                       | v2  | workspace | tools, services           |
| `natalia-tool-ask`      | Interactive Question Tools | v2  | session   | tools                     |
| `natalia-tool-browser`  | Browser Tools              | v2  | session   | tools                     |
| `natalia-tool-fs-read`  | Filesystem Read Tools      | v2  | workspace | tools                     |
| `natalia-tool-fs-write` | Filesystem Write Tools     | v2  | workspace | tools                     |
| `natalia-tool-process`  | Managed Process Tools      | v2  | session   | tools, services           |
| `natalia-tool-search`   | Search Tools               | v2  | workspace | tools                     |
| `natalia-tool-shell`    | Shell Tools                | v2  | session   | tools                     |
| `natalia-tool-terminal` | Terminal Tools             | v2  | session   | tools, services           |
| `natalia-tool-todo`     | Todo Tools                 | v2  | session   | tools                     |
| `natalia-tool-web`      | Web Tools                  | v2  | session   | tools                     |

Framework packages such as runtime, transport, session, sandbox, checkpoint,
provider/model, and SDK are deliberately absent: they are not plugins and do not
have a plugin lifecycle switch.

## 9. Publishing checklist

1. Use an ESM `.js` or `.mjs` entry for an external package; Natalia does not
   install a TypeScript source loader for third-party plugins.
2. Keep `package.json.version`, `natalia.plugin.json`, and the exported manifest
   version and content aligned.
3. Declare `@anthelia/plugin` and every directly imported Natalia package in
   `dependencies`. Do not use `@natalia/sdk` for authoring an in-process plugin.
4. Pin versions compatible with the target Natalia release. The generated
   scaffold uses the CLI distribution's current `@anthelia/plugin` version.
5. Include only runtime files and exactly one manifest. Bundling is allowed if
   the resulting ESM entry and all runtime dependencies remain importable.
6. Do not depend on `preinstall`, `postinstall`, uninstall scripts, or manifest
   hooks; npm scripts are disabled and manifest `hooks` must be `{}`.
7. Run `npm pack --dry-run`, inspect the file list, install the resulting
   tarball into the instance plugin store, then run `plugin doctor`.
8. Publish a scoped public package with `npm publish --access public` when the
   npm scope is not configured as public. A package lock is optional source
   metadata; npm constructs and Natalia records the installed closure itself.

## 10. Audit and testing

The registry records `loaded`, `unloaded`, `denied`, and `failed` audit entries.
Runtime diagnostics expose activation failures. Test at least these properties:

1. Registration creates no external resource before adapter materialization.
2. Declared tools and commands retain their names and approval declarations.
3. Setup failure leaves no contribution behind.
4. Disable, unload, and uninstall leave no tool, service, command, listener,
   resource, or UI surface owned by the plugin.
5. Disposal is idempotent and releases event subscriptions and processes.

Repository plugins run `npm run typecheck`, `npm run test`, and
`npm run guard:imports`. File length is a review signal; split code according to
cohesion, ownership, and dependency direction rather than a mechanical limit.

<a id="chinese"></a>

## 中文

> `PLUGIN_API_VERSION` 为 `2`。一个插件就是一个包，包内同时包含 package 元数据、
> `natalia.plugin.json`、入口模块和实现。插件 API 是进程内 host 扩展面，不是 RPC 面。

这份指南分两层读：

1. 先看 [从零开始](#2-从零开始新插件和新-ui)，用来今天就创建、安装、启用、禁用或卸载插件/UI。
2. 后面各节是 manifest、API、store 语义和 UI host 细节。

## 1. 单一插件体系

Natalia 只有一种插件。官方插件和用户安装插件使用同一 registry、声明名、权限、
依赖解析及装载/卸载生命周期。官方插件只是分发配置，不拥有特权 API，也不走第二套
生命周期。UI adapter 也是同一种插件：创建、安装、启用、禁用、卸载都走 plugin
命令。

插件不用于包装 Natalia 框架自身。Agent turn/step、Provider 与模型选择、会话与配置、
传输/SDK/daemon、CLI/web UI host、权限与审批、sandbox、checkpoint、工程智能、workspace、
runtime status 和 diagnostics 都由 runtime/host 直接构造并管理。这些能力没有插件
manifest、可卸载 plugin ID 或 `plugins.enabled` 开关，也不会出现在插件 catalog 中。
只有移除后仍能保持 runtime 核心语义完整的扩展包才是插件；例如独立模型工具和 UI
adapter 可以是插件，但它们不能拥有对应框架 controller 的生命周期。

插件是可信代码。它会被直接导入 runtime 进程，没有 VM、文件系统沙箱、网络沙箱或
执行超时。manifest 的 `integrationPoints` 用于贡献物归属和校验，不提供进程隔离。
只安装你编写过或审计过的包。

v2 integration point 包括 `tools`、`commands`、`events`、`services`、
`resources`、`projections`、`workflows`、`settingsSchema`、`adapters` 和
`schedulerJobs`。声明 integration point 就获得对应 API。工具和命令保留声明名，
Natalia 不添加插件前缀。工具审批尊重每个工具的 `requiresApproval` 声明，并继续经过
runtime 的常规策略路径；不存在按插件类别强制审批。

## 2. 从零开始：新插件和新 UI

UI 不是第二套系统。两条路径都是：创建一个包，装进 Natalia 实例唯一的
`plugin-store`，并在当前 workspace 启用。发行版中用 `natalia-ts` 替换
`npm run ts:cli --`。

### 新插件（command 或 tool）

```bash
# 1. 生成脚手架。工具用 --template tool，TypeScript 用 --language ts。
npm run ts:cli -- plugin create ./demo-plugin \
  --id yourco.demo \
  --package @yourco/natalia-demo

# 2. 编辑 src/index.js（若用了 --language ts，同时改 src/index.ts）。
#    保持 natalia.plugin.json 与导出的 manifest 完全一致。

# 3. 安装到实例 store。这一步也会在当前 workspace 启用该插件。
npm run ts:cli -- plugin install ./demo-plugin
npm run ts:cli -- plugin list
npm run ts:cli -- plugin doctor

# 4. 使用后可禁用/启用/卸载；其他 workspace 不必再装一遍。
npm run ts:cli -- plugin disable yourco.demo
npm run ts:cli -- plugin enable yourco.demo
npm run ts:cli -- plugin uninstall yourco.demo
```

TypeScript 脚手架安装的仍是 `src/index.js`。改完 `src/index.ts` 后，先把同样的
改动同步或编译进 `src/index.js`，再执行 `plugin install`。不要把 manifest
`entry` 设成 `.ts` 文件。

### 新 UI

```bash
# 1. 生成 UI adapter 插件。
npm run ts:cli -- plugin create ./demo-ui \
  --id yourco.web \
  --package @yourco/natalia-ui-web \
  --template ui

# 2. 编辑 src/index.js。注册是惰性的，只有 host 挂载对应 kind 才会 mount。
#    模板 kind 为 ui.yourco.web（除非 plugin id 已经以 ui 开头）。

# 3. 只安装一次，然后按 adapter kind 启动。
npm run ts:cli -- plugin install ./demo-ui
npm run ts:cli -- ui
npm run ts:cli -- ui ui.yourco.web

# 4. 启用、禁用、卸载与普通插件相同。
npm run ts:cli -- plugin disable yourco.web
npm run ts:cli -- plugin enable yourco.web
npm run ts:cli -- plugin uninstall yourco.web
```

`natalia-ts ui` 列出已启用插件贡献的 adapter kind。
`natalia-ts ui <kind>` 在进程内对真实 runtime 挂载该 UI。

### 首次安装之后

```bash
# 源码变更：重新安装同一目录或打包后的 tarball。
npm run ts:cli -- plugin install ./demo-plugin
npm pack ./demo-plugin
npm run ts:cli -- plugin install ./yourco-natalia-demo-1.0.0.tgz

# 长时间运行的 Natalia 进程需要重启或 reload 才会读到新状态。
npm run ts:cli -- plugin doctor
```

web shell Plugin Manager 也能对同一实例 store 执行安装、启用、禁用、卸载、审计和修复。
`doctor` / `reconcile` 不能替代 `plugin install`。

## 3. 单包布局

可发布插件包的最小结构：

```text
my-natalia-plugin/
  package.json
  natalia.plugin.json
  src/index.js
```

使用 CLI 创建该包。当前已安装发行版命令为 `natalia-ts`；仓库内示例使用
`npm run ts:cli --`：

```bash
natalia-ts plugin create ./my-natalia-plugin \
  --id yourco.demo \
  --package @yourco/natalia-demo
natalia-ts plugin create ./my-tool --id yourco.echo --template tool
natalia-ts plugin create ./my-ui --id yourco.web --template ui
natalia-ts plugin create ./my-ts --id yourco.ts --language ts
```

`--package` 可省略，默认使用目录 basename。`--template` 可选 `command`（默认）、
`tool` 或 `ui`。`--language` 可选 `js`（默认）或 `ts`。目录相对当前进程工作目录
解析；`--workspace` 不会改变脚手架输出位置。目标目录已存在时创建会失败。Natalia
安装的是 `src/index.js`；TypeScript 脚手架额外写入 `src/index.ts` 供编辑，但发布
入口仍是 JavaScript，因此安装后的包不依赖 Bun 或 TypeScript 源码 loader。UI 包是
普通插件，使用同一套安装、卸载、启用和禁用命令。web shell Plugin Manager 也可以审计和
修复实例 plugin-store。

包必须把实现直接导入的每个 Natalia 包声明为依赖：

```json
{
  "name": "@yourco/natalia-demo",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "natalia.plugin.json"],
  "exports": { ".": "./src/index.js" },
  "dependencies": {
    "@anthelia/plugin": "<compatible-version>"
  }
}
```

版本应与目标 Natalia 发行版兼容。包管理器只会把完整 package closure 安装一次，位置是
Natalia 实例唯一的 `plugin-store`；所有 workspace 共用这份安装。不要要求用户另建 SDK
软链接或单独复制入口文件。
只有实现确实导入时才添加 `@anthelia/contracts`、`@anthelia/tools` 或其他 Natalia 包。
`@natalia/sdk` 是 RPC client SDK，不是插件 authoring API。

## 4. Manifest v2

```json
{
  "apiVersion": 2,
  "id": "yourco.demo",
  "version": "1.0.0",
  "name": "Demo",
  "description": "A demonstration plugin.",
  "entry": "src/index.js",
  "scope": "workspace",
  "provides": [],
  "requires": [],
  "optionalRequires": [],
  "conflicts": [],
  "dependencies": [],
  "hooks": {},
  "integrationPoints": ["tools", "commands"]
}
```

- `id` 匹配 `[a-z0-9][a-z0-9._-]*`，同时是 registry owner id。
- `version` 是语义版本且必须与 `package.json` 一致；`entry` 必须是发布包内本地
  `.js`、`.mjs` 或 `.ts` 文件。面向 Natalia 源码 workspace 之外运行的包应使用
  JavaScript 入口。
- `scope` 为 `process`、`workspace` 或 `session`，表示生命周期归属，不是安全边界。
- `provides`、`requires`、`optionalRequires` 描述 service contract。
- `conflicts` 和 `dependencies` 进入确定性依赖解析；dependency 可标记
  `optional` 或 `peer`。
- `hooks` 是保留字段，当前必须为 `{}`。Natalia 安装和删除包时会禁用 npm lifecycle
  scripts，也不会隐式执行插件 hook 命令。
- `integrationPoints` 必须覆盖 `setup` 使用的每个贡献 API。

manifest、依赖和配置校验在激活前完成。`setup` 失败时，本次激活产生的注册项全部
回滚，插件 audit 状态为 `failed`。

## 5. 实现插件

```js
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest: {
    apiVersion: 2,
    id: "yourco.demo",
    version: "1.0.0",
    name: "Demo",
    description: "A demonstration plugin.",
    entry: "src/index.js",
    scope: "workspace",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["tools", "commands"],
  },
  setup(api) {
    api.tools.register({
      name: "echo",
      description: "Echo the input.",
      requiresApproval: false,
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(input) {
        return (input as { text: string }).text;
      },
    });
    api.commands.register({
      name: "demo.hello",
      title: "Say hello",
      run() {
        console.log("hello from yourco.demo");
      },
    });
  },
});
```

实际注册名就是 `echo` 和 `demo.hello`。重复名字会被拒绝，因此应选全局语义清晰的
名字。每次注册都返回 disposer，registry unload 也会清理 owner 的全部贡献物。
`setup` 和插件 `dispose` 都可以异步执行。

插件可通过 Standard Schema 声明 `configSchema`。校验结果从 `api.config` 读取，
原始值来自 `plugins.settings[pluginID]`。无效配置会阻止激活，不会留下半配置插件。

### Plugin API 参考

每个贡献方法都会检查对应的 `integrationPoints` 声明。使用未声明的 API 会导致激活
失败并报告 `plugin capability denied`。所有注册方法都返回幂等 disposer；卸载时，
registry 还会按注册顺序的逆序调用尚未执行的 disposer。

| Manifest point   | API                                                    | 契约                                                                                        |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `tools`          | `api.tools.register(tool)`                             | 注册全局命名的 `RuntimeTool`；重复名称会失败。                                              |
| `tools`          | `api.tools.registerAlias(alias, target)`               | 注册工具别名并返回 disposer。                                                               |
| `commands`       | `api.commands.register(command)`                       | 注册全局命名命令；重复名称会失败。                                                          |
| `events`         | `api.events.on(listener)`                              | 接收经插件 registry 分发的所有事件。                                                        |
| `events`         | `api.events.on(type, listener)`                        | 只接收对象 `type` 等于指定字符串的事件。                                                    |
| `services`       | `api.services.provide(name, value)`                    | 提供 manifest `provides` 中声明的服务；`setup` 结束前必须提供所有已声明服务。               |
| 无               | `api.services.get<T>(name)`                            | 读取当前可用的 host service。                                                               |
| 无               | `api.services.on<T>(name, listener)`                   | 监听 service provider 变化；注册时不会立即调用 listener。                                   |
| `resources`      | `api.resources.register({ name, ... })`                | 注册由 host 定义的具名 resource contribution；`workspace-file` 是下方文档化的稳定只读形态。 |
| `projections`    | `api.projections.register({ name, ... })`              | 注册由 host 定义的具名 projection contribution。                                            |
| `workflows`      | `api.workflows.register({ name, ... })`                | 注册由 host 定义的具名 workflow contribution。                                              |
| `settingsSchema` | `api.settingsSchema.register({ name, ... })`           | 注册由 host 定义的具名设置 schema contribution。                                            |
| `adapters`       | `api.adapters.register({ name, adapterType, create })` | 注册惰性 adapter factory，创建的实例必须有 `dispose()`。                                    |
| `adapters`       | `api.adapters.registerUi({ kind, mount, dispose })`    | UI adapter 便捷 API；贡献名就是 `kind`。                                                    |
| `schedulerJobs`  | `api.scheduler.add({ name, ... })`                     | 注册由 host 定义的具名 scheduler job。                                                      |

`resources`、`projections`、`workflows`、`settingsSchema` 和 scheduler job 的
稳定通用契约只有 `{ name: string }` 及生命周期归属。其他 payload 由消费该贡献的 host
定义；如果 host 没有导出通用格式，不应自行假定字段结构。

### 插件自有工作区资源

`resources` 目前有一个稳定的 host 定义形态：只读工作区文件。插件在
`integrationPoints` 声明 `resources`，在 `setup` 注册资源，再通过通用工作区读取
面读取。framework 不需要知道插件的业务目录。

```js
// natalia.plugin.json
"integrationPoints": ["tools", "resources"]

// src/index.js
api.resources.register({
  name: "session-artifact-store",
  kind: "workspace-file",
  access: "read",
  scope: "session",
  path: ".natalia/artifacts/{sessionID}.json",
  description: "Durable artifacts for the current session",
});
```

规则：

- `path` 必须是 workspace 相对路径并使用 `/`；支持内置的 `{sessionID}` /
  `{workspaceID}` 占位符。占位符由可信 runtime context 解析，展开后必须是单个安全
  路径段。
- `params` 可以声明额外的插件自有单段占位符，例如：
  ```js
  params: ["artifactID"],
  path: ".natalia/artifacts/{artifactID}.json",
  ```
  framework 只把这些名字当作不透明数据，校验语法、唯一性和单段安全；不会解释其业务
  含义。
- 通配符、`..`、绝对路径和未知占位符会被拒绝。
- 第一版只允许 `.natalia/` 下的插件自有资源；即使插件声明，
  `.natalia/config.json`、`.natalia/sessions/**` 等保留路径也会被拒绝。
- 资源声明是只读的；所属插件卸载后声明立即失效。
- 调用方仍通过 `runtime.workspaceRead({ path })` 读取。runtime 会匹配精确的声明路径，
  只让 platform 放行该精确 ignored path；containment、symlink 和大小限制仍全部生效。
- 保持 `natalia.plugin.json` 与导出的 manifest 一致；执行 `ts:build`/plugin install，
  确保两者携带相同的 `integrationPoints`。

带 reader 限制的资源使用具名读取 API。资源可以声明
`readers: ["yourco.web"]` 和 `audit: true`；UI host 会自动传入你的插件 id：

```js
const contents = await ctx.resources.read({
  resource: "session-artifact-store",
  params: { sessionID },
});
```

外部消费者可以调用 `runtime.resourceRead({ resource, params, reader })`。runtime 会解析
声明、校验 `readers` allowlist、读取精确声明路径；`audit` 为 true 时发布 live
`resource.read` 事件。带 `readers` 列表的资源故意不暴露给基于路径的
`workspaceRead`。

以下 API 不要求 `integrationPoints` 声明：

- `api.config` 是来自 `plugins.settings[pluginID]` 的同步校验结果；没有
  `configSchema` 时就是原始值。
- host 提供时，`api.runtimeConfig?.()` 返回当前 runtime 配置。它是可选 API，优先使用
  插件自己的配置。
- 插件卸载时会 abort `api.effects.signal`。
- `api.effects.run(effect)` 跟踪异步任务；卸载会 abort signal 并等待全部任务 settle。
  插件应把该 signal 继续传给 I/O 操作。

`RuntimeTool` 必须包含 `name`、`description`、`requiresApproval`、对象 JSON schema
`parameters`，以及返回字符串的异步 `execute(input, context)`。`context` 包含
`workspaceRoot`、可选 `sessionID`、`AbortSignal`，以及当前 runtime 可用的 host service。
命令必须包含 `name`、`title` 和 `run(invocation?)`；invocation 包含 `raw`、`args`、
`workspaceRoot`、可选 `sessionID` 和可选 `signal`。

### Renderer UI 清单

v2 manifest 可以声明供 web shell 使用的 renderer UI 入口，并通过统一的
动态插件 catalog 加载：

```json
{
  "apiVersion": 2,
  "id": "yourco.feature",
  "version": "1.0.0",
  "entry": "index.js",
  "ui": {
    "entry": "ui/plugin.js",
    "panels": [
      {
        "id": "feature-settings",
        "title": "Feature",
        "region": "settings",
        "group": "扩展"
      }
    ]
  }
}
```

UI 入口是一个浏览器模块，导出 `createUiPlugin()` 并返回 `@natalia/ui-host`
的 `UiPlugin`。运行时通过 `GET /plugins/<pluginId>/ui.js` 从 plugin store
提供该模块，shell 用统一动态加载器加载。官方包和第三方包没有不同注册路径；
只要 manifest 声明了 `ui.entry`，就会从同一份 `pluginCatalog` 被发现。

### 配置

Zod schema 实现了 Standard Schema，可直接使用。配置校验必须同步：

```js
import { z } from "zod";
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest,
  configSchema: z.object({
    endpoint: z.string().url(),
    retries: z.number().int().min(0).default(3),
  }),
  setup(api) {
    const config = api.config;
    // config 是校验后的 { endpoint, retries }。
  },
});
```

使用 Zod 时要把 `zod` 加入插件包依赖。在 `<workspace>/.natalia/config.json` 中配置：

```json
{
  "version": 3,
  "plugins": {
    "settings": {
      "yourco.demo": {
        "endpoint": "https://example.test",
        "retries": 5
      }
    }
  }
}
```

无效值会在 `setup` 之前失败，并报告具体属性路径。异步 Standard Schema 校验会被明确
拒绝。

### Service 与插件依赖

`requires` 包含必需 service 名。所有 service 可用之前，插件保持 `pending`；必需的
provider 消失或变更时，registry 会停用 consumer，再针对新 provider 重新激活。
`optionalRequires` 记录可选 service contract，但不阻止激活。`provides` 必须准确覆盖
通过 `api.services.provide` 提供的服务：提供未声明服务会立即失败，`setup` 结束时遗漏
已声明服务也会失败。

Manifest `dependencies` 描述插件之间的关系：

```json
{
  "dependencies": [
    { "id": "yourco.base", "spec": "^1.2.0", "optional": false, "peer": false }
  ]
}
```

必需 dependency 控制激活顺序。缺少或版本不兼容会使插件 pending；冲突和重复 ID 会被
拒绝；依赖环保持 unresolved。支持精确版本、`*`、`latest`、`workspace:*`、`^`、`~`、
`>`、`>=`、`<`、`<=`。可选 dependency 只有在兼容插件存在时才参与排序。`peer` 当前
会记录到安装元数据，但不会改变 runtime 解析行为。

Manifest dependency 不会自动安装另一个插件。JavaScript package dependency 应放在
`package.json`；每个必需 Natalia 插件需要单独安装，并在 manifest 中声明插件关系。

## 6. 生命周期命令

CLI 是权威维护入口。以下示例使用已安装发行版命令：

```bash
natalia-ts plugin install @yourco/natalia-demo
natalia-ts plugin list
natalia-ts plugin disable yourco.demo
natalia-ts plugin enable yourco.demo
natalia-ts plugin doctor
natalia-ts plugin reconcile
natalia-ts plugin uninstall yourco.demo
```

`--workspace /path/to/project` 只适用于 `install`、`enable`、`disable` 和 `list`，
用来选择启用状态写入的 workspace 配置，不会再创建一份插件 store。`plugin create`
相对当前进程工作目录写入显式目录，不使用 workspace 状态。

- `install <spec>` 在一个事务中完成 package staging 与校验，把依赖闭包装进 Natalia
  实例 `plugin-store`，写入 `<plugin-store>/natalia.lock`，并在所选 workspace 启用
  该插件。失败时恢复原 closure，不写入 lock。
- `list` 用一张 catalog 同时列出官方插件和用户安装包，字段包括 `id`、
  `name`、`version`、`scope`、`enabled`、`installed`、`source`、`packageName`。
- `disable <id>` 和 `enable <id>` 只改变所选 workspace 的 desired activation
  state。
- `uninstall <id>` 从实例 plugin-store 删除已安装包的 closure 和 lock entry。
  官方插件可用 `plugin reinstall <id>` 恢复。
- `doctor` 审计安装状态，`reconcile` 修复 desired package closure；二者是恢复命令，
  不是安装的额外步骤。

`install` 接受 npm package spec，包括 registry 版本、本地目录、打包 tarball、Git spec
和远程 tarball：

```bash
natalia-ts plugin install @yourco/natalia-demo@1.0.0
natalia-ts plugin install ./my-natalia-plugin
npm pack ./my-natalia-plugin
natalia-ts plugin install ./yourco-natalia-demo-1.0.0.tgz
```

本地开发修改包后需重新执行 `install`。发布前运行 `npm pack --dry-run`，确认包中包含
`src/index.js` 和恰好一个 `natalia.plugin.json`，再执行 `npm publish`。

包括 `create` 在内的所有维护命令都输出缩进 JSON。主要结果形状如下：

```json
{ "created": true, "directory": "/absolute/path/my-natalia-plugin", "pluginID": "yourco.demo", "packageName": "@yourco/natalia-demo" }
{ "installed": true, "pluginID": "yourco.demo", "packageName": "@yourco/natalia-demo", "metadata": {}, "enabled": true }
{ "pluginID": "yourco.demo", "enabled": false }
{ "uninstalled": true, "pluginID": "yourco.demo", "disposition": "removed for next reconcile" }
```

`plugin list` 返回实例 plugin-store 中按 ID 排序的 JSON 数组。安装包会返回已记录
的 registry、path、Git 或 tarball 来源。只有所选 workspace 配置显式禁用某个 ID
时，其 `enabled` 才为 false。

这些 CLI 命令持久化 desired state，不会直接修改另一个进程中已经运行的 plugin
registry。长时间运行的 client 必须重新加载配置/协调 desired catalog，或者重启进程。
新启动的 CLI、Web shell、UI host 或 daemon 会读取新状态。runtime RPC 的 `pluginUnload` 和
`pluginReload` 是进程局部操作，不能替代持久化 CLI 命令。

使用相同 package name 和 plugin ID 再次安装就是升级/重装路径。新包必须通过 staging
校验，才会替换 live closure。不能直接修改已安装 package 的 plugin ID，也不能把已有
plugin ID 转给另一个 package；确实需要改变身份时，应先卸载旧项。

### 安装校验内容

安装时 npm 使用 `--ignore-scripts`，并先暂存包，再在提交状态前校验：

1. 请求包可解析为带版本的 package-lock record。
2. package closure 在嵌套依赖之外恰好包含一个 `natalia.plugin.json`。
3. manifest 和 entry 都解析在 package 目录内部。
4. `package.json.version`、lock 解析版本和 manifest `version` 一致。
5. entry 可成功导入，default export 是包含 `manifest` 和 `setup()` 的对象。
6. 应用 schema 默认值后，导出 manifest 与文件 manifest 完全一致。
7. plugin ID 不被官方插件保留，并且与现有 lock 没有所有权冲突。

live closure 和 `natalia.lock` 归 Natalia 实例唯一的 `plugin-store` 所有。安装和卸载
不会创建 workspace 本地 package closure。workspace 配置只记录启用状态、settings 等
运行覆盖项。

### Doctor 与 reconcile

`plugin doctor` 返回空数组表示安装状态一致。Finding code 含义如下：

| Code                | 含义                                           |
| ------------------- | ---------------------------------------------- |
| `package_missing`   | 实例 plugin store 中缺少 lock 记录的 package。 |
| `manifest_mismatch` | 已安装 manifest 的 ID/版本与 lock 不同。       |

`plugin reconcile` 会根据 lock 来源重装报告为 `package_missing` 的 package。
返回值包含 `reconciled: true`、原始 `findings` 和再次审计后的 `remaining`。它不会凭空
补造缺失 lock entry，也不会静默接受 manifest mismatch；这两类问题应通过重装预期包
来修复。

### 常见失败

| 错误                                                    | 处理方式                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `plugin directory already exists`                       | 换一个空路径；create 永远不会覆盖文件。                           |
| `must contain exactly one natalia.plugin.json`          | 修正 npm `files`，并移除 fixture/source 子目录中的额外 manifest。 |
| `plugin entry manifest does not match`                  | 保持入口导出和文件 manifest 完全相同，包括数组和默认值。          |
| `manifest version ... does not match installed package` | 让 `package.json` 和两份 manifest 使用相同版本。                  |
| `plugin capability denied`                              | 把使用的每个 contribution API 加入 `integrationPoints`。          |
| `plugin config invalid`                                 | 修正 `plugins.settings[pluginID]`；错误会包含属性路径。           |
| `plugin dependency unresolved`                          | 安装/启用依赖插件、修正版本范围，或移除冲突/依赖环。              |
| `did not provide declared services`                     | 为 `provides` 中每个名称调用 `api.services.provide`。             |
| `unknown plugin`                                        | 使用 `plugin list` 显示的 manifest ID，而不是 npm package name。  |

框架能力不会出现在上述维护命令中。例如禁用名为 `natalia-transport`、
`natalia-sandbox` 或 `natalia-checkpoint` 的配置项不会关闭对应框架子系统；这些名称不再
是可维护的 plugin ID。

runtime RPC 的 `pluginUnload` 和 `pluginReload` 只操作已运行 registry，不能替代 CLI
持久化的 install、uninstall、enable、disable。

## 7. UI adapter 深入

UI 是使用现有 `adapters` integration point 的普通 v2 插件。
从零创建/安装/启动路径见 [第 2 节](#2-从零开始新插件和新-ui)。
本节是 host 契约：mount、dispose、checkpoint 和测试。

### 创建外部 UI package

直接使用 UI 模板。它会写入 `scope: "process"`、`integrationPoints: ["adapters"]`、
唯一 adapter `kind`，以及 `@anthelia/contracts` 依赖：

```bash
natalia-ts plugin create ./my-ui --id yourco.web --package @yourco/natalia-ui-web --template ui
```

发布包需要 `@anthelia/plugin` 注册 adapter；导入 `RuntimeClient`、`RuntimeEvent`
或其他公共类型时使用 `@anthelia/contracts`：

```json
{
  "name": "@yourco/natalia-ui-web",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "natalia.plugin.json"],
  "exports": { ".": "./src/index.js" },
  "dependencies": {
    "@anthelia/plugin": "<compatible-version>",
    "@anthelia/contracts": "<compatible-version>"
  }
}
```

不要把 `packages/examples/ui-plugin` 的 `workspace:*` 依赖版本或 `.ts` 入口照搬到
发行包；它是仓库 fixture。外部 package 必须发布可导入的 `.js` 或 `.mjs` entry，并声明
与发行版兼容的实际依赖版本。

### Mount 与 dispose

UI 插件本身很小。注册是惰性的：只有 UI host 选择对应 adapter kind 后才调用 `mount`；
`dispose` 必须释放 `mount` 创建的所有 listener、timer、renderer、socket 或其他资源。

```js
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest: {
    apiVersion: 2,
    id: "yourco.ui.web",
    version: "1.0.0",
    name: "Web UI",
    description: "Example UI adapter.",
    entry: "src/index.js",
    scope: "process",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["adapters"],
  },
  setup(api) {
    let unsubscribe: (() => void) | undefined;
    api.adapters.registerUi({
      kind: "ui.web",
      async mount(input) {
        const commands = await input.commands.list();
        render({ runtime: input.runtime, commands });
        unsubscribe = input.events.subscribe((event) => update(event));
      },
      dispose() {
        unsubscribe?.();
        unmount();
      },
    });
  },
});
```

host 注入三个公共端口：

| Port                                  | 用途                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.runtime`                       | 完整的类型化 `RuntimeClient`：提交 turn、查询 session/resource、调用 checkpoint 方法和其他已文档化的 runtime 操作。Feature 方法是可选的，方法不存在时应展示不可用状态。 |
| `input.events.subscribe(listener)`    | 订阅共享 `RuntimeEvent` 流，并返回 unsubscribe。UI projection state 保持在 adapter 内部；不要另建 runtime 或修改 framework state。                                      |
| `input.commands.list()` / `execute()` | 列出并执行 host 的权威 command catalog。通过 command `name` 定位，向 `execute` 传入原始命令与已解析参数。                                                               |

UI package 不应导入内部 UI host、checkpoint controller、registry 或 transport 实现，只能
使用这些公共 port 与公开的 `@anthelia/contracts` type。因此 web 或自定义
renderer 都可使用同一 runtime，而不依赖当前 UI 的 state 或组件。

### Checkpoint 与消息级 restore

restore UI 必须围绕 preview 构建，不能直接修改 workspace：

```js
async function openRestore(input, checkpointID) {
  if (!input.runtime.checkpointPreview || !input.runtime.checkpointRollback)
    return showUnavailable("Checkpoint management is unavailable.");

  const preview = await input.runtime.checkpointPreview(checkpointID);
  renderRollbackPreview(
    preview.changes,
    preview.context,
    preview.resources,
    preview.warnings,
  );

  // 可选 dry run 返回相同 preview，不会改变 workspace。
  await input.runtime.checkpointRollback({ id: checkpointID, dryRun: true });

  if (!(await confirmRestore(preview))) return;
  const result = await input.runtime.checkpointRollback({
    id: checkpointID,
    dryRun: false,
  });
  showRestored({ safetyCheckpointID: result.safetyCheckpointID });
}
```

`checkpointList()` 返回带 `turnID` 的 `RuntimeCheckpoint`。transcript message ID 采用
`${turnID}:user`、`${turnID}:assistant` 及相关 segment 形式，因此 UI 可以解析 turn ID，
再用 `checkpoint.turnID === turnID` 过滤 checkpoint。这样能在 user message 或 assistant
reply 上提供 `Restore...`，而不耦合 web UI renderer。

展示每个 `CheckpointPreview.changes` 的 `add`、`modify`、`delete`、`rename`、`mode` 或
`symlink` 类型，并展示 context truncation、resource policy、warning 和 `complete` 状态。
不完整 checkpoint 不能提供 restore。确认 rollback 会在修改 workspace 前创建
`safetyCheckpointID`；应明确显示“Restore is reversible”，并允许用户之后恢复到该 safety
checkpoint。

小型 preview 可以只用一次确认。范围大或包含 destructive change 的 preview，应要求用户
查看 changed-file list 和 warning 后才启用确认。runtime 始终是权威边界：即使 UI 出错，它也
会拒绝不完整 target 和 safety checkpoint。

### 测试 package

将 renderer 代码放在 adapter-local function 后，并使用 fake `RuntimeClient` 测试 `mount`。
验证 registration 在 materialize 前不产生 I/O，event 只更新 UI 本地 state，command 通过
catalog 执行，`dispose` 停止所有 event listener 和 renderer resource。端到端
materialization 测试可参考 `packages/examples/ui-plugin` 与
`packages/plugins/ui/web/test/plugin.test.ts`。

### 启动已安装的 UI

UI 包与普通插件一样安装，并按 adapter kind 启动——一个包、两条命令：

```bash
natalia-ts plugin install @yourco/natalia-ui-web
natalia-ts ui ui.web
```

`natalia-ts ui <kind>` 在进程内对真实 runtime 挂载该 UI；`natalia-ts ui`（不带 kind）
列出已启用已安装/path 插件贡献的可用 UI kind。Web shell 与所有已安装 UI 共用同一个通用 host
`createUiAdapterHost`（`@natalia/client`）：解析 workspace 配置、发现已启用插件、只把
adapter-capable 的 process 插件装入一个进程 registry，并对同一个共享
`UiAdapterMountInput` materialize 请求的 kind(s)。关闭幂等且 fail-closed（先
materializer，再 registry，最后 runtime）。

## 8. 官方插件目录

以下 ID 由 Natalia 发行版保留，安装包不能使用。它们会出现在 `plugin list`；只要配置
没有显式禁用，catalog 就报告为 enabled。部分插件只有在当前 host 提供构造输入时才会
真正 materialize。

| ID                      | 名称                       | API | Scope     | Integration points        |
| ----------------------- | -------------------------- | --- | --------- | ------------------------- |
| `natalia-local-tools`   | Local Tools                | v2  | workspace | tools, services           |
| `natalia-mcp`           | MCP Server                 | v2  | session   | tools, services           |
| `natalia-skills`        | Skills                     | v1  | workspace | tools, commands, services |
| `natalia-task-module`   | Task Module                | v2  | session   | tools                     |
| `natalia-task-workflow` | Task Workflow              | v2  | workspace | services, commands        |
| `natalia-team`          | Team                       | v2  | workspace | tools, services           |
| `natalia-tool-ask`      | Interactive Question Tools | v2  | session   | tools                     |
| `natalia-tool-browser`  | Browser Tools              | v2  | session   | tools                     |
| `natalia-tool-fs-read`  | Filesystem Read Tools      | v2  | workspace | tools                     |
| `natalia-tool-fs-write` | Filesystem Write Tools     | v2  | workspace | tools                     |
| `natalia-tool-process`  | Managed Process Tools      | v2  | session   | tools, services           |
| `natalia-tool-search`   | Search Tools               | v2  | workspace | tools                     |
| `natalia-tool-shell`    | Shell Tools                | v2  | session   | tools                     |
| `natalia-tool-terminal` | Terminal Tools             | v2  | session   | tools, services           |
| `natalia-tool-todo`     | Todo Tools                 | v2  | session   | tools                     |
| `natalia-tool-web`      | Web Tools                  | v2  | session   | tools                     |

runtime、transport、session、sandbox、checkpoint、provider/model、SDK 等框架 package
明确不在表中：它们不是插件，也没有 plugin lifecycle switch。

## 9. 发布检查清单

1. 外部 package 使用 ESM `.js` 或 `.mjs` 入口；Natalia 不会为第三方插件安装
   TypeScript source loader。
2. 保持 `package.json.version`、`natalia.plugin.json`、入口导出 manifest 的版本和
   内容一致。
3. 在 `dependencies` 中声明 `@anthelia/plugin` 和所有直接导入的 Natalia package。
   进程内插件开发不要使用 `@natalia/sdk`。
4. 固定与目标 Natalia 发行版兼容的版本。脚手架会使用当前 CLI 发行版的
   `@anthelia/plugin` 版本。
5. 只包含 runtime 文件和恰好一个 manifest。允许 bundle，但生成的 ESM 入口和所有
   runtime dependency 必须仍可导入。
6. 不依赖 `preinstall`、`postinstall`、uninstall script 或 manifest hook；npm script
   被禁用，manifest `hooks` 必须为 `{}`。
7. 运行 `npm pack --dry-run` 并检查文件列表，再把 tarball 安装到干净 workspace，最后
   运行 `plugin doctor`。
8. npm scope 未配置为 public 时，用 `npm publish --access public` 发布 scoped public
   package。package lock 可作为源码元数据选择性提交；npm 会自行构建 closure，Natalia
   也会记录实际安装结果。

## 10. 审计与测试

registry 记录 `loaded`、`unloaded`、`denied`、`failed` audit，runtime diagnostic
暴露激活错误。插件至少应验证：

1. adapter materialize 前，注册不会创建外部资源。
2. 工具和命令保留声明名与审批声明。
3. setup 失败后没有 contribution 残留。
4. disable、unload、uninstall 后没有该 owner 的 tool、service、command、listener、
   resource 或 UI surface。
5. dispose 幂等，并释放事件订阅和进程。

仓库内插件运行 `npm run typecheck`、`npm run test`、`npm run guard:imports`。文件行数
只作为评审提示；是否拆分以职责内聚、所有权边界和依赖方向为准，不为满足固定行数机械拆分。
