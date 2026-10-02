/**
 * Permission profile derivation.
 *
 * This is the pure config→profile computation the runtime applies on config
 * load and reload. It returns the effective permission profile plus the
 * permission/default-mode bindings that follow from it, or `found: false` when
 * an explicitly requested profile does not exist (in which case nothing is
 * applied). Keeping it separate makes the load/reload path testable without the
 * runtime state it writes.
 */
import type { ConfigV3, PermissionProfile } from "@anthelia/contracts";

export type PermissionMode = PermissionProfile["approval"];

export type DerivedPermissionSettings =
  | { found: false }
  | {
      found: true;
      selectedProfile: PermissionProfile;
      mode: PermissionMode;
      defaultMode: PermissionMode;
      defaultProfile: PermissionProfile;
    };

function permissionsFromMode(
  mode: ConfigV3["agentModes"][string],
): PermissionProfile["permissions"] {
  const allow = mode?.permissions?.tools?.allow ?? mode?.allowedTools ?? [];
  const exclude =
    mode?.permissions?.tools?.exclude ?? mode?.excludedTools ?? [];
  const permissions = mode?.permissions
    ? {
        ...mode.permissions,
        tools: { allow, exclude },
      }
    : allow.length || exclude.length
      ? { tools: { allow, exclude } }
      : undefined;
  return permissions;
}

function extensionsFromMode(mode: ConfigV3["agentModes"][string]): {
  skills: boolean;
  mcp: boolean;
} {
  return {
    skills: mode?.skills !== false && mode?.extensions?.skills !== false,
    mcp: mode?.extensions?.mcp !== false,
  };
}

export function derivePermissionSettings(input: {
  config: ConfigV3;
  requestedProfile: string | undefined;
  optionMode: PermissionMode | undefined;
  permissionMode: PermissionMode;
}): DerivedPermissionSettings {
  const { config, requestedProfile, optionMode, permissionMode } = input;
  const agentMode =
    config.agentModes[config.defaultAgentMode] ?? config.agentModes["ask"];
  const defaultProfile: PermissionProfile = {
    approval: agentMode?.approval ?? "ask",
    description: agentMode?.description ?? "",
    ...(permissionsFromMode(agentMode)
      ? { permissions: permissionsFromMode(agentMode) }
      : {}),
    ...(agentMode?.commandRules
      ? { commandRules: agentMode.commandRules }
      : {}),
    ...(agentMode?.interactivePrograms
      ? { interactivePrograms: agentMode.interactivePrograms }
      : {}),
    extensions: extensionsFromMode(agentMode),
  };

  if (requestedProfile) {
    const found = config.agentModes[requestedProfile];
    if (!found) return { found: false };
    const foundProfile: PermissionProfile = {
      approval: found.approval,
      description: found.description ?? "",
      ...(permissionsFromMode(found)
        ? { permissions: permissionsFromMode(found) }
        : {}),
      ...(found.commandRules ? { commandRules: found.commandRules } : {}),
      ...(found.interactivePrograms
        ? { interactivePrograms: found.interactivePrograms }
        : {}),
      extensions: extensionsFromMode(found),
    };
    const nextMode =
      !optionMode && found ? foundProfile.approval : permissionMode;
    return {
      found: true,
      selectedProfile: foundProfile,
      mode: nextMode,
      defaultMode: nextMode,
      defaultProfile: foundProfile,
    };
  }

  const selectedProfile = defaultProfile;
  const nextMode =
    !optionMode && selectedProfile ? selectedProfile.approval : permissionMode;
  return {
    found: true,
    selectedProfile,
    mode: nextMode,
    defaultMode: nextMode,
    defaultProfile: selectedProfile,
  };
}
