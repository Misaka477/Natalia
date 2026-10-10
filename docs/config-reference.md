# Natalia Config Reference — v1

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

> This document describes the shape of `.natalia/config.json`: the type,
> optionality and default of every field. The validator is `configV3Schema`
> (`packages/core/contracts/src/schemas.ts`); the table below is generated from
> that schema, so it cannot drift from the code.
>
> Config is written and applied through `updateConfig` (`config.update`) —
> the write/apply semantics (a running turn may answer `applied: false`) are
> in `docs/api-reference.md` §9. The keys of `z.record(X)` fields such as
> `providers`/`catalog.providers`/`modelOverrides`/`agents`/`permissionProfiles` are arbitrary; the
> element type's fields live on that schema's own rows.
>
> The tables under the "Machine-derived" heading below are generated from the
> source schemas (`npm run docs:api-reference`) and are byte-identical with
> the Chinese edition; the drift guard turns the gate red on any disagreement
> with the code.

## Notation

- `?` (the Optional column) = the field is optional.
- The Default column = the schema's declared default (`{}` means an empty
  object default).
- `Record<string, X>` = an object with arbitrary keys and values of type X;
  X's fields live on X's rows.

---

<!-- config-reference:generated -->
## Config shape (source scan of the zod schema graph rooted at `packages/core/contracts/src/schemas.ts`)

| Schema                                 | Field                             | Type                                                                             | Optional | Default                                                                          |
| -------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `configV3Schema`                       | `version`                         | 3                                                                                |          |                                                                                  |
| `configV3Schema`                       | `runtime`                         | runtimeConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                       | `sandbox`                         | sandboxConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                       | `confinement`                     | confinementConfigSchema                                                          |          | {}                                                                               |
| `configV3Schema`                       | `goal`                            | goalConfigSchema                                                                 |          | {}                                                                               |
| `configV3Schema`                       | `team`                            | teamConfigSchema                                                                 |          | {}                                                                               |
| `configV3Schema`                       | `context`                         | contextConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                       | `backgroundReview`                | backgroundReviewConfigSchema                                                     |          |                                                                                  |
| `configV3Schema`                       | `checkpoint`                      | checkpointConfigSchema                                                           |          |                                                                                  |
| `configV3Schema`                       | `providers`                       | Record<string, providerConfigSchema>                                             |          | {}                                                                               |
| `configV3Schema`                       | `catalog`                         | modelCatalogSchema                                                               |          |                                                                                  |
| `configV3Schema`                       | `modelOverrides`                  | Record<string, modelOverrideSchema>                                              |          | {}                                                                               |
| `configV3Schema`                       | `defaultModel`                    | modelRefSchema                                                                   |          | null                                                                             |
| `configV3Schema`                       | `agentModes`                      | Record<string, agentModeSchema>                                                  |          | { ask: { approval: "ask", description: "Ask before write, process, or shell acti |
| `configV3Schema`                       | `agentModes.ask`                  | { approval: "ask", description: "Ask before write, process, or shell actions", } |          |                                                                                  |
| `configV3Schema`                       | `agentModes.ask.approval`         | "ask"                                                                            |          |                                                                                  |
| `configV3Schema`                       | `agentModes.ask.description`      | "Ask before write                                                                |          |                                                                                  |
| `configV3Schema`                       | `agentModes.auto`                 | { approval: "auto", description: "Automatically approve actions", }              |          |                                                                                  |
| `configV3Schema`                       | `agentModes.auto.approval`        | "auto"                                                                           |          |                                                                                  |
| `configV3Schema`                       | `agentModes.auto.description`     | "Automatically approve actions"                                                  |          |                                                                                  |
| `configV3Schema`                       | `defaultAgentMode`                | string                                                                           |          | "ask"                                                                            |
| `configV3Schema`                       | `agents`                          | Record<string, agentConfigSchema>                                                |          | {}                                                                               |
| `configV3Schema`                       | `defaultAgent`                    | string                                                                           |          | ""                                                                               |
| `configV3Schema`                       | `mcpServers`                      | Record<string, mcpServerConfigSchema>                                            |          | {}                                                                               |
| `configV3Schema`                       | `skills`                          | skillsConfigSchema                                                               |          | {}                                                                               |
| `configV3Schema`                       | `plugins`                         | pluginConfigSchema                                                               |          | {}                                                                               |
| `configV3Schema`                       | `tools`                           | toolsConfigSchema                                                                |          | {}                                                                               |
| `configV3Schema`                       | `workspace`                       | workspaceConfigSchema                                                            |          | {}                                                                               |
| `configV3Schema`                       | `instructions`                    | instructionConfigSchema                                                          |          | {}                                                                               |
| `configV3Schema`                       | `webSearch`                       | webSearchConfigSchema                                                            |          | {}                                                                               |
| `configV3Schema`                       | `browser`                         | browserConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                       | `network`                         | networkConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                       | `security`                        | securityConfigSchema                                                             |          | {}                                                                               |
| `configV3Schema`                       | `issueTargets`                    | Record<string, issueTargetConfigSchema>                                          |          | {}                                                                               |
| `configV3Schema`                       | `dataSources`                     | Record<string, dataSourceConfigSchema>                                           |          | {}                                                                               |
| `configV3Schema`                       | `alertChannels`                   | Record<string, alertChannelConfigSchema>                                         |          | {}                                                                               |
| `configV3Schema`                       | `experimental`                    | experimentalConfigSchema                                                         |          | {}                                                                               |
| `runtimeConfigSchema`                  | `maxStepsPerTurn`                 | number                                                                           | yes      |                                                                                  |
| `runtimeConfigSchema`                  | `subagentDepth`                   | number                                                                           |          | 1                                                                                |
| `runtimeConfigSchema`                  | `subagentWallClockMs`             | subagentWallClockMs                                                              |          |                                                                                  |
| `runtimeConfigSchema`                  | `subagentMinResultChars`          | number                                                                           |          | 200                                                                              |
| `runtimeConfigSchema`                  | `subagentSettledNotices`          | number                                                                           |          | 20                                                                               |
| `runtimeConfigSchema`                  | `subagentSettledNotices.message`  | "must be a non-negative integer"                                                 |          |                                                                                  |
| `runtimeConfigSchema`                  | `collaboration`                   | object                                                                           |          | {}                                                                               |
| `runtimeConfigSchema`                  | `collaboration.maxAutoRounds`     | number                                                                           |          | 3                                                                                |
| `runtimeConfigSchema`                  | `collaboration.advisorModel`      | string                                                                           | yes      |                                                                                  |
| `runtimeConfigSchema`                  | `timeouts`                        | timeoutSchema                                                                    |          | {}                                                                               |
| `runtimeConfigSchema`                  | `maxAttemptsPerStep`              | number                                                                           | yes      |                                                                                  |
| `runtimeConfigSchema`                  | `providerConcurrency`             | Record<string, number>                                                           |          | {}                                                                               |
| `runtimeConfigSchema`                  | `retry`                           | object                                                                           |          | {}                                                                               |
| `runtimeConfigSchema`                  | `retry.maxAttemptsPerStep`        | number                                                                           |          | null                                                                             |
| `runtimeConfigSchema`                  | `retry.initialBackoffMs`          | number                                                                           |          | 300                                                                              |
| `runtimeConfigSchema`                  | `retry.maxBackoffMs`              | number                                                                           |          | 5000                                                                             |
| `runtimeConfigSchema`                  | `retry.jitterMs`                  | number                                                                           |          | 500                                                                              |
| `runtimeConfigSchema`                  | `terminal`                        | terminalWindowConfigSchema                                                       |          | {}                                                                               |
| `runtimeConfigSchema`                  | `shell`                           | shellConfigSchema                                                                |          | {}                                                                               |
| `timeoutSchema`                        | `requestSec`                      | number                                                                           |          | 0                                                                                |
| `timeoutSchema`                        | `streamIdleSec`                   | number                                                                           |          | 0                                                                                |
| `timeoutSchema`                        | `toolSec`                         | number                                                                           | yes      |                                                                                  |
| `timeoutSchema`                        | `turnSec`                         | number                                                                           |          | null                                                                             |
| `terminalWindowConfigSchema`           | `windowMode`                      | ["auto", "windowless", "window"]                                                 |          | "auto"                                                                           |
| `terminalWindowConfigSchema`           | `backend`                         | "pty"                                                                            |          | "pty"                                                                            |
| `terminalWindowConfigSchema`           | `maxIdleMinutes`                  | number                                                                           |          | 60                                                                               |
| `shellConfigSchema`                    | `bashPath`                        | string                                                                           | yes      |                                                                                  |
| `sandboxConfigSchema`                  | `backend`                         | ["snapshot", "worktree"]                                                         |          | "snapshot"                                                                       |
| `sandboxConfigSchema`                  | `promoteCommand`                  | string                                                                           | yes      |                                                                                  |
| `sandboxConfigSchema`                  | `dependencyRoots`                 | string[]                                                                         |          | ["node_modules"]                                                                 |
| `sandboxConfigSchema`                  | `maxIdleHours`                    | number                                                                           |          | 168                                                                              |
| `sandboxConfigSchema`                  | `maxSandboxes`                    | number                                                                           |          | 0                                                                                |
| `confinementConfigSchema`              | `mode`                            | CONFINEMENT_MODES                                                                |          | "workspace-write"                                                                |
| `goalConfigSchema`                     | `completionCommand`               | string                                                                           | yes      |                                                                                  |
| `teamConfigSchema`                     | `maxConcurrent`                   | number                                                                           |          | 4                                                                                |
| `contextConfigSchema`                  | `autoDetectWindow`                | boolean                                                                          |          | true                                                                             |
| `contextConfigSchema`                  | `compactionEnabled`               | boolean                                                                          |          | true                                                                             |
| `contextConfigSchema`                  | `customInstruction`               | string                                                                           | yes      |                                                                                  |
| `contextConfigSchema`                  | `compactionThresholdPercent`      | number                                                                           |          | 85                                                                               |
| `contextConfigSchema`                  | `reservedOutputTokens`            | [z.literal("auto"), z.number().int().positive()]                                 |          | "auto"                                                                           |
| `contextConfigSchema`                  | `preservedRecentMessages`         | number                                                                           |          | 10                                                                               |
| `contextConfigSchema`                  | `preservedRecentTokens`           | number                                                                           |          | 20_000                                                                           |
| `contextConfigSchema`                  | `maxOverflowRetries`              | number                                                                           |          | 1                                                                                |
| `backgroundReviewConfigSchema`         | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `checkpointConfigSchema`               | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `checkpointConfigSchema`               | `maxFiles`                        | number                                                                           | yes      |                                                                                  |
| `checkpointConfigSchema`               | `maxBytes`                        | number                                                                           | yes      |                                                                                  |
| `checkpointConfigSchema`               | `ignore`                          | string[]                                                                         |          | []                                                                               |
| `checkpointConfigSchema`               | `additionalDirs`                  | string[]                                                                         |          | []                                                                               |
| `providerConfigSchema`                 | `name`                            | string                                                                           |          |                                                                                  |
| `providerConfigSchema`                 | `driver`                          | string                                                                           |          |                                                                                  |
| `providerConfigSchema`                 | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `providerConfigSchema`                 | `connection`                      | providerConnectionSchema                                                         |          |                                                                                  |
| `providerConfigSchema`                 | `requestDefaults`                 | providerRequestDefaultsSchema                                                    |          |                                                                                  |
| `providerConfigSchema`                 | `protocol`                        | endpointProtocolSchema                                                           | yes      |                                                                                  |
| `providerConnectionSchema`             | `baseURL`                         | string                                                                           | yes      |                                                                                  |
| `providerConnectionSchema`             | `apiKey`                          | string                                                                           | yes      |                                                                                  |
| `providerConnectionSchema`             | `authHeader`                      | string                                                                           | yes      |                                                                                  |
| `providerRequestDefaultsSchema`        | `stream`                          | boolean                                                                          |          | true                                                                             |
| `providerRequestDefaultsSchema`        | `headers`                         | Record<string, string>                                                           |          | {}                                                                               |
| `providerRequestDefaultsSchema`        | `options`                         | Record<string, unknown>                                                          |          | {}                                                                               |
| `endpointProtocolSchema`               | `format`                          | string                                                                           | yes      |                                                                                  |
| `endpointProtocolSchema`               | `module`                          | string                                                                           | yes      |                                                                                  |
| `endpointProtocolSchema`               | `capabilities`                    | endpointCapabilitiesSchema                                                       | yes      |                                                                                  |
| `endpointProtocolSchema`               | `cacheRetention`                  | ["none", "short", "long"]                                                        | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `supportsLongCacheRetention`      | boolean                                                                          | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `supportsCacheControlOnTools`     | boolean                                                                          | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `sendSessionAffinityHeaders`      | boolean                                                                          | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `sessionAffinityFormat`           | ["openrouter"]                                                                   | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `supportsPromptCacheKey`          | boolean                                                                          | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `promptCacheKeyField`             | ["promptCacheKey", "prompt_cache_key"]                                           | yes      |                                                                                  |
| `endpointCapabilitiesSchema`           | `supportsExplicitPromptCacheMode` | boolean                                                                          | yes      |                                                                                  |
| `modelCatalogSchema`                   | `providers`                       | Record<string, object>                                                           |          | {}                                                                               |
| `modelCatalogSchema`                   | `providers.models`                | Record<string, catalogModelSchema>                                               |          | {}                                                                               |
| `catalogModelSchema`                   | `name`                            | string                                                                           |          |                                                                                  |
| `catalogModelSchema`                   | `capabilities`                    | modelCapabilitiesSchema                                                          |          | {}                                                                               |
| `catalogModelSchema`                   | `limits`                          | modelLimitsSchema                                                                |          |                                                                                  |
| `catalogModelSchema`                   | `status`                          | ["stable", "experimental", "deprecated"]                                         |          | "stable"                                                                         |
| `catalogModelSchema`                   | `source`                          | ["discovery", "manual"]                                                          |          | "discovery"                                                                      |
| `modelCapabilitiesSchema`              | `toolCall`                        | boolean                                                                          |          | true                                                                             |
| `modelCapabilitiesSchema`              | `reasoning`                       | boolean                                                                          |          | true                                                                             |
| `modelCapabilitiesSchema`              | `thinking`                        | boolean                                                                          |          | true                                                                             |
| `modelCapabilitiesSchema`              | `imageInput`                      | boolean                                                                          |          | false                                                                            |
| `modelCapabilitiesSchema`              | `videoInput`                      | boolean                                                                          |          | false                                                                            |
| `modelCapabilitiesSchema`              | `interleaved`                     | interleavedReasoningCapabilitySchema                                             | yes      |                                                                                  |
| `interleavedReasoningCapabilitySchema` | `field`                           | ["reasoning", "reasoning_content", "reasoning_details"]                          |          |                                                                                  |
| `modelLimitsSchema`                    | `contextWindow`                   | [z.literal("auto"), z.number().int().positive()]                                 |          | "auto"                                                                           |
| `modelLimitsSchema`                    | `maxOutputTokens`                 | outputTokenLimitSchema                                                           |          |                                                                                  |
| `modelLimitsSchema`                    | `inputLimit`                      | number                                                                           | yes      |                                                                                  |
| `modelLimitsSchema`                    | `reservedOutputTokens`            | number                                                                           | yes      |                                                                                  |
| `modelLimitsSchema`                    | `compactionThresholdPercent`      | number                                                                           | yes      |                                                                                  |
| `modelOverrideSchema`                  | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `modelOverrideSchema`                  | `name`                            | string                                                                           | yes      |                                                                                  |
| `modelOverrideSchema`                  | `requestDefaults`                 | modelOverrideRequestDefaultsSchema                                               |          |                                                                                  |
| `modelOverrideSchema`                  | `requestOptions`                  | Record<string, unknown>                                                          |          | {}                                                                               |
| `modelOverrideSchema`                  | `headers`                         | Record<string, string>                                                           |          | {}                                                                               |
| `modelOverrideSchema`                  | `limits`                          | modelLimitsSchema                                                                | yes      |                                                                                  |
| `modelOverrideRequestDefaultsSchema`   | `temperature`                     | number                                                                           |          | null                                                                             |
| `modelOverrideRequestDefaultsSchema`   | `topP`                            | number                                                                           |          | null                                                                             |
| `modelOverrideRequestDefaultsSchema`   | `stream`                          | boolean                                                                          | yes      |                                                                                  |
| `modelOverrideRequestDefaultsSchema`   | `thinkingEnabled`                 | boolean                                                                          | yes      |                                                                                  |
| `modelRefSchema`                       | `provider`                        | string                                                                           |          |                                                                                  |
| `modelRefSchema`                       | `model`                           | string                                                                           |          |                                                                                  |
| `agentModeSchema`                      | `description`                     | string                                                                           |          | ""                                                                               |
| `agentModeSchema`                      | `approval`                        | ["ask", "auto", "read_only"]                                                     |          |                                                                                  |
| `agentModeSchema`                      | `systemPrompt`                    | string                                                                           |          | ""                                                                               |
| `agentModeSchema`                      | `model`                           | string                                                                           | yes      |                                                                                  |
| `agentModeSchema`                      | `allowedTools`                    | string[]                                                                         |          | []                                                                               |
| `agentModeSchema`                      | `excludedTools`                   | string[]                                                                         |          | []                                                                               |
| `agentModeSchema`                      | `permissions`                     | agentPermissionRulesSchema                                                       | yes      |                                                                                  |
| `agentModeSchema`                      | `commandRules`                    | permissionProfileCommandRulesSchema                                              | yes      |                                                                                  |
| `agentModeSchema`                      | `interactivePrograms`             | interactiveProgramRulesSchema                                                    | yes      |                                                                                  |
| `agentModeSchema`                      | `extensions`                      | extensionRulesSchema                                                             | yes      |                                                                                  |
| `agentModeSchema`                      | `skills`                          | boolean                                                                          |          | true                                                                             |
| `agentModeSchema`                      | `mcpServers`                      | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `tools`                           | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `tools.allow`                     | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `tools.exclude`                   | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `files`                           | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `files[].writePaths`              | object[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `files[].writePaths[].pattern`    | string                                                                           |          |                                                                                  |
| `agentPermissionRulesSchema`           | `files[].writePaths[].allow`      | boolean                                                                          | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `files[].writePaths[].reason`     | string                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `commands`                        | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `commands.allowPatterns`          | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `commands.denyPatterns`           | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `network`                         | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `network.allowedHosts`            | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `network.denyHosts`               | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `network.allowLocalhost`          | boolean                                                                          | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `network.allowPrivate`            | boolean                                                                          | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `env`                             | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`           | `env.allowlist`                   | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`           | `redactOutput`                    | boolean                                                                          | yes      |                                                                                  |
| `permissionProfileCommandRulesSchema`  | `mode`                            | ["blacklist", "whitelist", "none"]                                               |          |                                                                                  |
| `permissionProfileCommandRulesSchema`  | `rules`                           | bashCommandRuleSchema[]                                                          |          | []                                                                               |
| `bashCommandRuleSchema`                | `command`                         | string                                                                           |          |                                                                                  |
| `bashCommandRuleSchema`                | `reason`                          | string                                                                           | yes      |                                                                                  |
| `interactiveProgramRulesSchema`        | `allowAny`                        | boolean                                                                          |          | false                                                                            |
| `interactiveProgramRulesSchema`        | `allow`                           | bashCommandRuleSchema[]                                                          |          | []                                                                               |
| `extensionRulesSchema`                 | `skills`                          | boolean                                                                          | yes      |                                                                                  |
| `extensionRulesSchema`                 | `mcp`                             | boolean                                                                          | yes      |                                                                                  |
| `mcpServerConfigSchema`                | `type`                            | ["stdio", "http"]                                                                |          |                                                                                  |
| `mcpServerConfigSchema`                | `command`                         | string                                                                           | yes      |                                                                                  |
| `mcpServerConfigSchema`                | `args`                            | string[]                                                                         |          | []                                                                               |
| `mcpServerConfigSchema`                | `url`                             | string                                                                           | yes      |                                                                                  |
| `mcpServerConfigSchema`                | `headers`                         | Record<string, string>                                                           |          | {}                                                                               |
| `mcpServerConfigSchema`                | `environment`                     | Record<string, string>                                                           |          | {}                                                                               |
| `mcpServerConfigSchema`                | `cwd`                             | string                                                                           | yes      |                                                                                  |
| `mcpServerConfigSchema`                | `timeoutSec`                      | number                                                                           |          | 30                                                                               |
| `mcpServerConfigSchema`                | `allowedTools`                    | string[]                                                                         |          | []                                                                               |
| `mcpServerConfigSchema`                | `excludedTools`                   | string[]                                                                         |          | []                                                                               |
| `mcpServerConfigSchema`                | `readOnly`                        | boolean                                                                          |          | false                                                                            |
| `mcpServerConfigSchema`                | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `mcpServerConfigSchema`                | `auth`                            | [z.literal(false), z.object({}).passthrough()]                                   | yes      |                                                                                  |
| `skillsConfigSchema`                   | `urls`                            | string[]                                                                         |          | []                                                                               |
| `pluginConfigSchema`                   | `enabled`                         | Record<string, boolean>                                                          |          | {}                                                                               |
| `pluginConfigSchema`                   | `paths`                           | string[]                                                                         |          | []                                                                               |
| `pluginConfigSchema`                   | `capabilities`                    | Record<string, pluginIntegrationPointSchema[]>                                   |          | {}                                                                               |
| `pluginConfigSchema`                   | `readOnly`                        | Record<string, boolean>                                                          |          | {}                                                                               |
| `pluginConfigSchema`                   | `settings`                        | Record<string, unknown>                                                          |          | {}                                                                               |
| `pluginConfigSchema`                   | `packages`                        | Record<string, pluginPackageConfigSchema>                                        |          | {}                                                                               |
| `pluginPackageConfigSchema`            | `source`                          | pluginPackageSourceSchema                                                        |          |                                                                                  |
| `pluginPackageConfigSchema`            | `version`                         | string                                                                           |          |                                                                                  |
| `pluginPackageConfigSchema`            | `integrity`                       | string                                                                           | yes      |                                                                                  |
| `pluginPackageConfigSchema`            | `signature`                       | string                                                                           | yes      |                                                                                  |
| `pluginPackageConfigSchema`            | `scope`                           | ["process", "workspace", "session"]                                              |          |                                                                                  |
| `pluginPackageSourceSchema`            | `type`                            | "registry"                                                                       |          |                                                                                  |
| `pluginPackageSourceSchema`            | `spec`                            | string                                                                           |          |                                                                                  |
| `toolsConfigSchema`                    | `paths`                           | string[]                                                                         |          | []                                                                               |
| `workspaceConfigSchema`                | `root`                            | string                                                                           |          | ""                                                                               |
| `workspaceConfigSchema`                | `additionalDirs`                  | string[]                                                                         |          | []                                                                               |
| `instructionConfigSchema`              | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `instructionConfigSchema`              | `includeReadme`                   | boolean                                                                          |          | true                                                                             |
| `instructionConfigSchema`              | `includeDocs`                     | boolean                                                                          |          | false                                                                            |
| `instructionConfigSchema`              | `extraFiles`                      | string[]                                                                         |          | []                                                                               |
| `webSearchConfigSchema`                | `endpoint`                        | string                                                                           |          | null                                                                             |
| `webSearchConfigSchema`                | `providerPriority`                | string[]                                                                         |          | ["configured", "duckduckgo"]                                                     |
| `browserConfigSchema`                  | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `browserConfigSchema`                  | `binary`                          | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                  | `persistentProfile`               | boolean                                                                          |          | false                                                                            |
| `browserConfigSchema`                  | `profileDir`                      | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                  | `userAgent`                       | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                  | `locale`                          | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                  | `timezone`                        | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                  | `headers`                         | Record<string, string>                                                           |          | {}                                                                               |
| `networkConfigSchema`                  | `allowedHosts`                    | string[]                                                                         |          | []                                                                               |
| `networkConfigSchema`                  | `allowedSchemes`                  | string[]                                                                         |          | ["https", "http"]                                                                |
| `networkConfigSchema`                  | `allowLocalhost`                  | boolean                                                                          |          | false                                                                            |
| `networkConfigSchema`                  | `allowPrivate`                    | boolean                                                                          |          | false                                                                            |
| `securityConfigSchema`                 | `envAllowlist`                    | string[]                                                                         |          | []                                                                               |
| `securityConfigSchema`                 | `redactToolOutput`                | boolean                                                                          |          | true                                                                             |
| `issueTargetConfigSchema`              | `kind`                            | ["gitea", "github"]                                                              |          |                                                                                  |
| `issueTargetConfigSchema`              | `baseURL`                         | string                                                                           |          |                                                                                  |
| `issueTargetConfigSchema`              | `owner`                           | string                                                                           |          |                                                                                  |
| `issueTargetConfigSchema`              | `repo`                            | string                                                                           |          |                                                                                  |
| `issueTargetConfigSchema`              | `token`                           | string                                                                           |          | ""                                                                               |
| `issueTargetConfigSchema`              | `label`                           | string                                                                           |          | ""                                                                               |
| `issueTargetConfigSchema`              | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `dataSourceConfigSchema`               | `path`                            | string                                                                           |          |                                                                                  |
| `dataSourceConfigSchema`               | `kind`                            | ["offset", "timestamp"]                                                          |          | "offset"                                                                         |
| `dataSourceConfigSchema`               | `timestampField`                  | string                                                                           |          | ""                                                                               |
| `dataSourceConfigSchema`               | `maxBytes`                        | number                                                                           |          | 65536                                                                            |
| `dataSourceConfigSchema`               | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `alertChannelConfigSchema`             | `kind`                            | ["journal", "webhook"]                                                           |          |                                                                                  |
| `alertChannelConfigSchema`             | `url`                             | string                                                                           |          | ""                                                                               |
| `alertChannelConfigSchema`             | `token`                           | string                                                                           |          | ""                                                                               |
| `alertChannelConfigSchema`             | `timeoutMs`                       | number                                                                           |          | 10_000                                                                           |
| `alertChannelConfigSchema`             | `enabled`                         | boolean                                                                          |          | true                                                                             |
| `experimentalConfigSchema`             | `policies`                        | policyStatementSchema[]                                                          |          | []                                                                               |
| `policyStatementSchema`                | `effect`                          | ["allow", "deny"]                                                                |          |                                                                                  |
| `policyStatementSchema`                | `action`                          | string                                                                           |          |                                                                                  |
| `policyStatementSchema`                | `resource`                        | string                                                                           |          |                                                                                  |
<!-- /config-reference:generated -->

<!-- config-reference:tui-settings -->

## Interface-preference settings (`tui.json`)

The theme, keybindings and other interface preferences live in `tui.json`,
written atomically with mode 0600:

- **Project scope**: `.natalia/tui.json`
- **Global scope**: `$HOME/.config/natalia/tui.json` (POSIX) /
  > The directory was renamed from `natalia-cli` to `natalia`. The legacy location (`$HOME/.config/natalia-cli/`) is still READ — an existing install needs no migration — while writes always land on the new name. The doctor's source list names the directory a config actually came from.
  `%APPDATA%\natalia\tui.json` (Windows)

Resolution is defaults → global → project (project wins). The full schema is
`tuiConfigSchema` in `@anthelia/config`; the fields are:

| Field                     | Type                                | Default        |
| ------------------------- | ----------------------------------- | -------------- |
| `theme`                   | string                              | `natalia-dark` |
| `themeMode`               | `"dark" \| "light" \| "system"`     | `dark`         |
| `keybinds`                | record of string / string[] / false | `{}`           |
| `leaderKey`               | string                              | `ctrl+x`       |
| `leaderTimeoutMs`         | number                              | `2000`         |
| `toolDetails`             | `"collapsed" \| "expanded"`         | `collapsed`    |
| `reasoning`               | `"step" \| "hidden"`                | `step`         |
| `density`                 | `"comfortable" \| "compact"`        | `comfortable`  |
| `followBottom`            | boolean                             | `true`         |
| `scrollSpeed`             | number                              | `1`            |
| `scrollAcceleration`      | boolean                             | `true`         |
| `mouse`                   | boolean                             | `true`         |
| `prompt.maxHeight`        | number                              | `8`            |
| `diffStyle`               | `"auto" \| "stacked"`               | `auto`         |
| `attention.enabled`       | boolean                             | `false`        |
| `attention.notifications` | boolean                             | `true`         |
| `attention.sound`         | boolean                             | `false`        |
| `attention.volume`        | number                              | `0.4`          |

The file is a partial: absent keys keep the lower-precedence value. Writes
accept any subset of the schema (`deepPartial`), so a consumer never needs to
read before writing.

### Reading and writing over RPC

`settingsGet()` returns the fully resolved effective config plus the source
list (`defaults` / `global` / `project` with their paths and applied state).
`settingsSet(patch, scope)` validates against the shared schema (an invalid
patch is an argument error, never a partial write), writes the scope's file
atomically, and announces the change with a `settings.updated` event
(carrying the scope), so subscribers re-read rather than cache blindly.

<!-- /config-reference:tui-settings -->

<a id="chinese"></a>

## 中文

> 本文档描述 `.natalia/config.json` 的形状：每个字段的类型、可选性与默认值。
> 校验器是 `configV3Schema`（`packages/core/contracts/src/schemas.ts`）；本表由该
> schema 生成，因此不会与代码漂移。
>
> 配置经 `updateConfig`（`config.update`）写入并应用——写入与应用的语义（回合
> 进行中可能答 `applied: false`）见 `docs/api-reference.md` §9。`providers`/
> `catalog.providers`/`modelOverrides`/`agents`/`permissionProfiles` 等 `z.record(X)` 的键任意，元素字段
> 见对应 schema 自己的行。
>
> 文末"机器派生"标题下的表格由源码生成（`npm run docs:api-reference`），与
> 英文版逐字节一致；防漂移守卫在二者不一致或与代码不一致时使门禁变红。

## 记号

- `?`（Optional 列）= 可选字段。
- Default 列 = schema 声明的默认值（`{}` 表示空对象默认）。
- `Record<string, X>` = 任意键对象，值为 X；X 的字段见 X 的行。

---

<!-- config-reference:generated -->
## Config shape (source scan of the zod schema graph rooted at `packages/core/contracts/src/schemas.ts`)

| Schema                                | Field                          | Type                                                                             | Optional | Default                                                                          |
| ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `configV3Schema`                      | `version`                      | 3                                                                                |          |                                                                                  |
| `configV3Schema`                      | `runtime`                      | runtimeConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                      | `sandbox`                      | sandboxConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                      | `team`                         | teamConfigSchema                                                                 |          | {}                                                                               |
| `configV3Schema`                      | `context`                      | contextConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                      | `checkpoint`                   | checkpointConfigSchema                                                           |          |                                                                                  |
| `configV3Schema`                      | `providers`                    | Record<string, providerConfigSchema>                                             |          | {}                                                                               |
| `configV3Schema`                      | `catalog`                      | modelCatalogSchema                                                               |          |                                                                                  |
| `configV3Schema`                      | `modelOverrides`               | Record<string, modelOverrideSchema>                                              |          | {}                                                                               |
| `configV3Schema`                      | `defaultModel`                 | modelRefSchema                                                                   |          | null                                                                             |
| `configV3Schema`                      | `agentModes`                   | Record<string, agentModeSchema>                                                  |          | { ask: { approval: "ask", description: "Ask before write, process, or shell acti |
| `configV3Schema`                      | `agentModes.ask`               | { approval: "ask", description: "Ask before write, process, or shell actions", } |          |                                                                                  |
| `configV3Schema`                      | `agentModes.ask.approval`      | "ask"                                                                            |          |                                                                                  |
| `configV3Schema`                      | `agentModes.ask.description`   | "Ask before write                                                                |          |                                                                                  |
| `configV3Schema`                      | `agentModes.auto`              | { approval: "auto", description: "Automatically approve actions", }              |          |                                                                                  |
| `configV3Schema`                      | `agentModes.auto.approval`     | "auto"                                                                           |          |                                                                                  |
| `configV3Schema`                      | `agentModes.auto.description`  | "Automatically approve actions"                                                  |          |                                                                                  |
| `configV3Schema`                      | `defaultAgentMode`             | string                                                                           |          | "ask"                                                                            |
| `configV3Schema`                      | `agents`                       | Record<string, agentConfigSchema>                                                |          | {}                                                                               |
| `configV3Schema`                      | `defaultAgent`                 | string                                                                           |          | ""                                                                               |
| `configV3Schema`                      | `mcpServers`                   | Record<string, mcpServerConfigSchema>                                            |          | {}                                                                               |
| `configV3Schema`                      | `skills`                       | skillsConfigSchema                                                               |          | {}                                                                               |
| `configV3Schema`                      | `plugins`                      | pluginConfigSchema                                                               |          | {}                                                                               |
| `configV3Schema`                      | `tools`                        | toolsConfigSchema                                                                |          | {}                                                                               |
| `configV3Schema`                      | `workspace`                    | workspaceConfigSchema                                                            |          | {}                                                                               |
| `configV3Schema`                      | `instructions`                 | instructionConfigSchema                                                          |          | {}                                                                               |
| `configV3Schema`                      | `webSearch`                    | webSearchConfigSchema                                                            |          | {}                                                                               |
| `configV3Schema`                      | `browser`                      | browserConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                      | `network`                      | networkConfigSchema                                                              |          | {}                                                                               |
| `configV3Schema`                      | `security`                     | securityConfigSchema                                                             |          | {}                                                                               |
| `configV3Schema`                      | `issueTargets`                 | Record<string, issueTargetConfigSchema>                                          |          | {}                                                                               |
| `configV3Schema`                      | `dataSources`                  | Record<string, dataSourceConfigSchema>                                           |          | {}                                                                               |
| `configV3Schema`                      | `alertChannels`                | Record<string, alertChannelConfigSchema>                                         |          | {}                                                                               |
| `configV3Schema`                      | `experimental`                 | experimentalConfigSchema                                                         |          | {}                                                                               |
| `runtimeConfigSchema`                 | `maxStepsPerTurn`              | number                                                                           | yes      |                                                                                  |
| `runtimeConfigSchema`                 | `subagentDepth`                | number                                                                           |          | 1                                                                                |
| `runtimeConfigSchema`                 | `collaboration`                | object                                                                           |          | {}                                                                               |
| `runtimeConfigSchema`                 | `collaboration.maxAutoRounds`  | number                                                                           |          | 3                                                                                |
| `runtimeConfigSchema`                 | `timeouts`                     | timeoutSchema                                                                    |          | {}                                                                               |
| `runtimeConfigSchema`                 | `maxAttemptsPerStep`           | number                                                                           |          | 3                                                                                |
| `runtimeConfigSchema`                 | `providerConcurrency`          | Record<string, number>                                                           |          | {}                                                                               |
| `runtimeConfigSchema`                 | `retry`                        | object                                                                           |          | {}                                                                               |
| `runtimeConfigSchema`                 | `retry.maxAttemptsPerStep`     | number                                                                           |          | null                                                                             |
| `runtimeConfigSchema`                 | `retry.initialBackoffMs`       | number                                                                           |          | 300                                                                              |
| `runtimeConfigSchema`                 | `retry.maxBackoffMs`           | number                                                                           |          | 5000                                                                             |
| `runtimeConfigSchema`                 | `retry.jitterMs`               | number                                                                           |          | 500                                                                              |
| `runtimeConfigSchema`                 | `terminal`                     | terminalWindowConfigSchema                                                       |          | {}                                                                               |
| `timeoutSchema`                       | `requestSec`                   | number                                                                           |          | 120                                                                              |
| `timeoutSchema`                       | `streamIdleSec`                | number                                                                           |          | 120                                                                              |
| `timeoutSchema`                       | `toolSec`                      | number                                                                           | yes      |                                                                                  |
| `timeoutSchema`                       | `turnSec`                      | number                                                                           |          | null                                                                             |
| `terminalWindowConfigSchema`          | `windowMode`                   | ["auto", "windowless", "window"]                                                 |          | "auto"                                                                           |
| `terminalWindowConfigSchema`          | `backend`                      | ["wezterm", "pty"]                                                               |          | "pty"                                                                            |
| `sandboxConfigSchema`                 | `backend`                      | ["snapshot", "worktree"]                                                         |          | "snapshot"                                                                       |
| `sandboxConfigSchema`                 | `promoteCommand`               | string                                                                           |          | "npm run typecheck"                                                              |
| `teamConfigSchema`                    | `maxConcurrent`                | number                                                                           |          | 4                                                                                |
| `contextConfigSchema`                 | `autoDetectWindow`             | boolean                                                                          |          | true                                                                             |
| `contextConfigSchema`                 | `compactionEnabled`            | boolean                                                                          |          | true                                                                             |
| `contextConfigSchema`                 | `compactionThresholdPercent`   | number                                                                           |          | 85                                                                               |
| `contextConfigSchema`                 | `reservedOutputTokens`         | [z.literal("auto"), z.number().int().positive()]                                 |          | "auto"                                                                           |
| `contextConfigSchema`                 | `preservedRecentMessages`      | number                                                                           |          | 10                                                                               |
| `checkpointConfigSchema`              | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `checkpointConfigSchema`              | `maxFiles`                     | number                                                                           |          | 20000                                                                            |
| `checkpointConfigSchema`              | `maxBytes`                     | number                                                                           |          | 512 * 1024 * 1024                                                                |
| `checkpointConfigSchema`              | `ignore`                       | string[]                                                                         |          | []                                                                               |
| `checkpointConfigSchema`              | `additionalDirs`               | string[]                                                                         |          | []                                                                               |
| `providerConfigSchema`                | `name`                         | string                                                                           |          |                                                                                  |
| `providerConfigSchema`                | `driver`                       | string                                                                           |          |                                                                                  |
| `providerConfigSchema`                | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `providerConfigSchema`                | `connection`                   | providerConnectionSchema                                                         |          |                                                                                  |
| `providerConfigSchema`                | `requestDefaults`              | providerRequestDefaultsSchema                                                    |          |                                                                                  |
| `providerConnectionSchema`            | `baseURL`                      | string                                                                           | yes      |                                                                                  |
| `providerConnectionSchema`            | `apiKey`                       | string                                                                           | yes      |                                                                                  |
| `providerConnectionSchema`            | `authHeader`                   | string                                                                           | yes      |                                                                                  |
| `providerRequestDefaultsSchema`       | `stream`                       | boolean                                                                          |          | true                                                                             |
| `providerRequestDefaultsSchema`       | `headers`                      | Record<string, string>                                                           |          | {}                                                                               |
| `providerRequestDefaultsSchema`       | `options`                      | Record<string, unknown>                                                          |          | {}                                                                               |
| `modelCatalogSchema`                  | `providers`                    | Record<string, object>                                                           |          | {}                                                                               |
| `modelCatalogSchema`                  | `providers.models`             | Record<string, catalogModelSchema>                                               |          | {}                                                                               |
| `catalogModelSchema`                  | `name`                         | string                                                                           |          |                                                                                  |
| `catalogModelSchema`                  | `capabilities`                 | modelCapabilitiesSchema                                                          |          | {}                                                                               |
| `catalogModelSchema`                  | `limits`                       | modelLimitsSchema                                                                |          |                                                                                  |
| `catalogModelSchema`                  | `status`                       | ["stable", "experimental", "deprecated"]                                         |          | "stable"                                                                         |
| `catalogModelSchema`                  | `source`                       | ["discovery", "manual"]                                                          |          | "discovery"                                                                      |
| `modelCapabilitiesSchema`             | `toolCall`                     | boolean                                                                          |          | true                                                                             |
| `modelCapabilitiesSchema`             | `reasoning`                    | boolean                                                                          |          | true                                                                             |
| `modelCapabilitiesSchema`             | `thinking`                     | boolean                                                                          |          | true                                                                             |
| `modelCapabilitiesSchema`             | `imageInput`                   | boolean                                                                          |          | false                                                                            |
| `modelCapabilitiesSchema`             | `videoInput`                   | boolean                                                                          |          | false                                                                            |
| `modelLimitsSchema`                   | `contextWindow`                | [z.literal("auto"), z.number().int().positive()]                                 |          | "auto"                                                                           |
| `modelLimitsSchema`                   | `maxOutputTokens`              | outputTokenLimitSchema                                                           |          |                                                                                  |
| `modelOverrideSchema`                 | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `modelOverrideSchema`                 | `name`                         | string                                                                           | yes      |                                                                                  |
| `modelOverrideSchema`                 | `requestDefaults`              | modelOverrideRequestDefaultsSchema                                               |          |                                                                                  |
| `modelOverrideSchema`                 | `requestOptions`               | Record<string, unknown>                                                          |          | {}                                                                               |
| `modelOverrideSchema`                 | `headers`                      | Record<string, string>                                                           |          | {}                                                                               |
| `modelOverrideRequestDefaultsSchema`  | `temperature`                  | number                                                                           |          | null                                                                             |
| `modelOverrideRequestDefaultsSchema`  | `topP`                         | number                                                                           |          | null                                                                             |
| `modelOverrideRequestDefaultsSchema`  | `stream`                       | boolean                                                                          | yes      |                                                                                  |
| `modelOverrideRequestDefaultsSchema`  | `thinkingEnabled`              | boolean                                                                          | yes      |                                                                                  |
| `modelRefSchema`                      | `provider`                     | string                                                                           |          |                                                                                  |
| `modelRefSchema`                      | `model`                        | string                                                                           |          |                                                                                  |
| `agentModeSchema`                     | `description`                  | string                                                                           |          | ""                                                                               |
| `agentModeSchema`                     | `approval`                     | ["ask", "auto", "read_only"]                                                     |          |                                                                                  |
| `agentModeSchema`                     | `systemPrompt`                 | string                                                                           |          | ""                                                                               |
| `agentModeSchema`                     | `model`                        | string                                                                           | yes      |                                                                                  |
| `agentModeSchema`                     | `allowedTools`                 | string[]                                                                         |          | []                                                                               |
| `agentModeSchema`                     | `excludedTools`                | string[]                                                                         |          | []                                                                               |
| `agentModeSchema`                     | `permissions`                  | agentPermissionRulesSchema                                                       | yes      |                                                                                  |
| `agentModeSchema`                     | `commandRules`                 | permissionProfileCommandRulesSchema                                              | yes      |                                                                                  |
| `agentModeSchema`                     | `interactivePrograms`          | interactiveProgramRulesSchema                                                    | yes      |                                                                                  |
| `agentModeSchema`                     | `extensions`                   | extensionRulesSchema                                                             | yes      |                                                                                  |
| `agentModeSchema`                     | `skills`                       | boolean                                                                          |          | true                                                                             |
| `agentModeSchema`                     | `mcpServers`                   | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `tools`                        | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `tools.allow`                  | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `tools.exclude`                | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `files`                        | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `files[].writePaths`           | object[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `files[].writePaths[].pattern` | string                                                                           |          |                                                                                  |
| `agentPermissionRulesSchema`          | `files[].writePaths[].allow`   | boolean                                                                          | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `files[].writePaths[].reason`  | string                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `commands`                     | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `commands.allowPatterns`       | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `commands.denyPatterns`        | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `network`                      | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `network.allowedHosts`         | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `network.denyHosts`            | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `network.allowLocalhost`       | boolean                                                                          | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `network.allowPrivate`         | boolean                                                                          | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `env`                          | object                                                                           | yes      |                                                                                  |
| `agentPermissionRulesSchema`          | `env.allowlist`                | string[]                                                                         |          | []                                                                               |
| `agentPermissionRulesSchema`          | `redactOutput`                 | boolean                                                                          | yes      |                                                                                  |
| `permissionProfileCommandRulesSchema` | `mode`                         | ["blacklist", "whitelist", "none"]                                               |          |                                                                                  |
| `permissionProfileCommandRulesSchema` | `rules`                        | bashCommandRuleSchema[]                                                          |          | []                                                                               |
| `bashCommandRuleSchema`               | `command`                      | string                                                                           |          |                                                                                  |
| `bashCommandRuleSchema`               | `reason`                       | string                                                                           | yes      |                                                                                  |
| `interactiveProgramRulesSchema`       | `allowAny`                     | boolean                                                                          |          | false                                                                            |
| `interactiveProgramRulesSchema`       | `allow`                        | bashCommandRuleSchema[]                                                          |          | []                                                                               |
| `extensionRulesSchema`                | `skills`                       | boolean                                                                          | yes      |                                                                                  |
| `extensionRulesSchema`                | `mcp`                          | boolean                                                                          | yes      |                                                                                  |
| `mcpServerConfigSchema`               | `type`                         | ["stdio", "http"]                                                                |          |                                                                                  |
| `mcpServerConfigSchema`               | `command`                      | string                                                                           | yes      |                                                                                  |
| `mcpServerConfigSchema`               | `args`                         | string[]                                                                         |          | []                                                                               |
| `mcpServerConfigSchema`               | `url`                          | string                                                                           | yes      |                                                                                  |
| `mcpServerConfigSchema`               | `headers`                      | Record<string, string>                                                           |          | {}                                                                               |
| `mcpServerConfigSchema`               | `environment`                  | Record<string, string>                                                           |          | {}                                                                               |
| `mcpServerConfigSchema`               | `cwd`                          | string                                                                           | yes      |                                                                                  |
| `mcpServerConfigSchema`               | `timeoutSec`                   | number                                                                           |          | 30                                                                               |
| `mcpServerConfigSchema`               | `allowedTools`                 | string[]                                                                         |          | []                                                                               |
| `mcpServerConfigSchema`               | `excludedTools`                | string[]                                                                         |          | []                                                                               |
| `mcpServerConfigSchema`               | `readOnly`                     | boolean                                                                          |          | false                                                                            |
| `mcpServerConfigSchema`               | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `mcpServerConfigSchema`               | `auth`                         | [z.literal(false), z.object({}).passthrough()]                                   | yes      |                                                                                  |
| `skillsConfigSchema`                  | `urls`                         | string[]                                                                         |          | []                                                                               |
| `pluginConfigSchema`                  | `enabled`                      | Record<string, boolean>                                                          |          | {}                                                                               |
| `pluginConfigSchema`                  | `paths`                        | string[]                                                                         |          | []                                                                               |
| `pluginConfigSchema`                  | `capabilities`                 | Record<string, pluginIntegrationPointSchema[]>                                   |          | {}                                                                               |
| `pluginConfigSchema`                  | `readOnly`                     | Record<string, boolean>                                                          |          | {}                                                                               |
| `pluginConfigSchema`                  | `settings`                     | Record<string, unknown>                                                          |          | {}                                                                               |
| `pluginConfigSchema`                  | `packages`                     | Record<string, pluginPackageConfigSchema>                                        |          | {}                                                                               |
| `pluginPackageConfigSchema`           | `source`                       | pluginPackageSourceSchema                                                        |          |                                                                                  |
| `pluginPackageConfigSchema`           | `version`                      | string                                                                           |          |                                                                                  |
| `pluginPackageConfigSchema`           | `integrity`                    | string                                                                           | yes      |                                                                                  |
| `pluginPackageConfigSchema`           | `signature`                    | string                                                                           | yes      |                                                                                  |
| `pluginPackageConfigSchema`           | `scope`                        | ["process", "workspace", "session"]                                              |          |                                                                                  |
| `pluginPackageSourceSchema`           | `type`                         | "registry"                                                                       |          |                                                                                  |
| `pluginPackageSourceSchema`           | `spec`                         | string                                                                           |          |                                                                                  |
| `toolsConfigSchema`                   | `paths`                        | string[]                                                                         |          | []                                                                               |
| `workspaceConfigSchema`               | `root`                         | string                                                                           |          | ""                                                                               |
| `workspaceConfigSchema`               | `additionalDirs`               | string[]                                                                         |          | []                                                                               |
| `instructionConfigSchema`             | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `instructionConfigSchema`             | `includeReadme`                | boolean                                                                          |          | true                                                                             |
| `instructionConfigSchema`             | `includeDocs`                  | boolean                                                                          |          | false                                                                            |
| `instructionConfigSchema`             | `extraFiles`                   | string[]                                                                         |          | []                                                                               |
| `webSearchConfigSchema`               | `endpoint`                     | string                                                                           |          | null                                                                             |
| `webSearchConfigSchema`               | `providerPriority`             | string[]                                                                         |          | ["configured", "duckduckgo"]                                                     |
| `browserConfigSchema`                 | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `browserConfigSchema`                 | `binary`                       | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                 | `persistentProfile`            | boolean                                                                          |          | false                                                                            |
| `browserConfigSchema`                 | `profileDir`                   | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                 | `userAgent`                    | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                 | `locale`                       | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                 | `timezone`                     | string                                                                           |          | ""                                                                               |
| `browserConfigSchema`                 | `headers`                      | Record<string, string>                                                           |          | {}                                                                               |
| `networkConfigSchema`                 | `allowedHosts`                 | string[]                                                                         |          | []                                                                               |
| `networkConfigSchema`                 | `allowedSchemes`               | string[]                                                                         |          | ["https", "http"]                                                                |
| `networkConfigSchema`                 | `allowLocalhost`               | boolean                                                                          |          | false                                                                            |
| `networkConfigSchema`                 | `allowPrivate`                 | boolean                                                                          |          | false                                                                            |
| `securityConfigSchema`                | `envAllowlist`                 | string[]                                                                         |          | []                                                                               |
| `securityConfigSchema`                | `redactToolOutput`             | boolean                                                                          |          | true                                                                             |
| `issueTargetConfigSchema`             | `kind`                         | ["gitea", "github"]                                                              |          |                                                                                  |
| `issueTargetConfigSchema`             | `baseURL`                      | string                                                                           |          |                                                                                  |
| `issueTargetConfigSchema`             | `owner`                        | string                                                                           |          |                                                                                  |
| `issueTargetConfigSchema`             | `repo`                         | string                                                                           |          |                                                                                  |
| `issueTargetConfigSchema`             | `token`                        | string                                                                           |          | ""                                                                               |
| `issueTargetConfigSchema`             | `label`                        | string                                                                           |          | ""                                                                               |
| `issueTargetConfigSchema`             | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `dataSourceConfigSchema`              | `path`                         | string                                                                           |          |                                                                                  |
| `dataSourceConfigSchema`              | `kind`                         | ["offset", "timestamp"]                                                          |          | "offset"                                                                         |
| `dataSourceConfigSchema`              | `timestampField`               | string                                                                           |          | ""                                                                               |
| `dataSourceConfigSchema`              | `maxBytes`                     | number                                                                           |          | 65536                                                                            |
| `dataSourceConfigSchema`              | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `alertChannelConfigSchema`            | `kind`                         | ["journal", "webhook"]                                                           |          |                                                                                  |
| `alertChannelConfigSchema`            | `url`                          | string                                                                           |          | ""                                                                               |
| `alertChannelConfigSchema`            | `token`                        | string                                                                           |          | ""                                                                               |
| `alertChannelConfigSchema`            | `timeoutMs`                    | number                                                                           |          | 10_000                                                                           |
| `alertChannelConfigSchema`            | `enabled`                      | boolean                                                                          |          | true                                                                             |
| `experimentalConfigSchema`            | `policies`                     | policyStatementSchema[]                                                          |          | []                                                                               |
| `policyStatementSchema`               | `effect`                       | ["allow", "deny"]                                                                |          |                                                                                  |
| `policyStatementSchema`               | `action`                       | string                                                                           |          |                                                                                  |
| `policyStatementSchema`               | `resource`                     | string                                                                           |          |                                                                                  |
<!-- /config-reference:generated -->

<!-- config-reference:tui-settings -->

## 界面偏好设置（`tui.json`）

主题、键位等界面偏好存放在 `tui.json`，以 0600 权限原子写入：

- **项目作用域**：`.natalia/tui.json`
- **全局作用域**：`$HOME/.config/natalia/tui.json`（POSIX）/
  `%APPDATA%\natalia\tui.json`（Windows）

解析顺序为 defaults → global → project（project 优先）。完整 schema 见
`@anthelia/config` 的 `tuiConfigSchema`；字段如下：

| 字段                      | 类型                                | 默认           |
| ------------------------- | ----------------------------------- | -------------- |
| `theme`                   | string                              | `natalia-dark` |
| `themeMode`               | `"dark" \| "light" \| "system"`     | `dark`         |
| `keybinds`                | string / string[] / false 的 record | `{}`           |
| `leaderKey`               | string                              | `ctrl+x`       |
| `leaderTimeoutMs`         | number                              | `2000`         |
| `toolDetails`             | `"collapsed" \| "expanded"`         | `collapsed`    |
| `reasoning`               | `"step" \| "hidden"`                | `step`         |
| `density`                 | `"comfortable" \| "compact"`        | `comfortable`  |
| `followBottom`            | boolean                             | `true`         |
| `scrollSpeed`             | number                              | `1`            |
| `scrollAcceleration`      | boolean                             | `true`         |
| `mouse`                   | boolean                             | `true`         |
| `prompt.maxHeight`        | number                              | `8`            |
| `diffStyle`               | `"auto" \| "stacked"`               | `auto`         |
| `attention.enabled`       | boolean                             | `false`        |
| `attention.notifications` | boolean                             | `true`         |
| `attention.sound`         | boolean                             | `false`        |
| `attention.volume`        | number                              | `0.4`          |

文件是部分配置：缺省键沿用低优先级的值。写入接受 schema 的任意子集
（`deepPartial`），消费者无需先读再写。

### 经 RPC 读写

`settingsGet()` 返回完全解析后的生效配置与来源列表（`defaults` /
`global` / `project`，含路径与 applied 状态）。`settingsSet(patch, scope)`
按共享 schema 校验（非法 patch 是参数错误，绝不会产生部分写入），原子写
入对应作用域文件，并发布 `settings.updated` 事件（携带 scope），订阅者
据此重新读取而非盲目缓存。

<!-- /config-reference:tui-settings -->

## `.nataliaignore`

Workspace roots may contain a `.nataliaignore` file. It is generated with
build/runtime defaults, is user-editable, and controls only checkpoint and
sandbox snapshot membership. It never hides files from the file explorer,
read/write APIs, searches, or model tools. The older `checkpoint.ignore`
configuration is migrated into this file once and is no longer read at runtime.
