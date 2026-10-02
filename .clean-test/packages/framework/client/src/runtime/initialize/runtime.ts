import type { RuntimeContext } from "@anthelia/substrate";

export function createInitializeRuntime(ctx: RuntimeContext) {
  const deps = ctx.state.initialize;
  return {
    ...deps,
    resolveService: ctx.ports.resolveService,
    get workspaceRoot() {
      return ctx.ports.getWorkspaceRoot();
    },
    get tsRuntimeConfig() {
      return ctx.ports.getTsRuntimeConfig();
    },
    set tsRuntimeConfig(value) {
      ctx.ports.setTsRuntimeConfig(value);
    },
    get interactive() {
      return ctx.ports.getInteractive();
    },
    get retryPolicy() {
      return ctx.ports.getRetryPolicy();
    },
    set retryPolicy(value) {
      ctx.ports.setRetryPolicy(value);
    },
    set maxSteps(value: number | undefined) {
      ctx.ports.setMaxSteps(value);
    },
    get maxSteps() {
      return ctx.ports.getMaxSteps();
    },
    get providerConcurrencyLimiter() {
      return ctx.ports.getProviderConcurrencyLimiter();
    },
    set providerConcurrencyLimiter(value) {
      ctx.ports.setProviderConcurrencyLimiter(value);
    },
    get agentRegistry() {
      return ctx.ports.getAgentRegistry();
    },
    set agentRegistry(
      value: import("@anthelia/agent").AgentRegistry | undefined,
    ) {
      if (value) ctx.ports.setAgentRegistry(value);
    },
    get selectedAgent() {
      return ctx.ports.getSelectedAgent();
    },
    set selectedAgent(value) {
      ctx.ports.setSelectedAgent(value);
    },
    get selectedModel() {
      return ctx.ports.getSelectedModel();
    },
    set selectedModel(value) {
      ctx.ports.setSelectedModel(value);
    },
    get provider() {
      return ctx.ports.getProvider();
    },
    set provider(value) {
      ctx.ports.setProvider(value);
    },
    set providerSource(
      value: "explicit" | "environment" | "ts_config" | "unconfigured",
    ) {
      ctx.ports.setProviderSource(value);
    },
    get providerSource() {
      return ctx.ports.getProviderSource();
    },
    get runtimeContextConfig() {
      return ctx.ports.getRuntimeContextConfig();
    },
    set runtimeContextConfig(value) {
      ctx.ports.setRuntimeContextConfig(value);
    },
    get runtimeContext() {
      return ctx.ports.getRuntimeContext();
    },
    set runtimeContext(value) {
      ctx.ports.setRuntimeContext(value);
    },
    get sessionID() {
      return ctx.ports.getSessionID();
    },
    set sessionID(value) {
      ctx.ports.setSessionID(value);
    },
    get sessionPersistence() {
      return ctx.ports.getSessionPersistence();
    },
    set sessionPersistence(value) {
      ctx.ports.setSessionPersistence(value);
    },
    get session() {
      return ctx.ports.getSession();
    },
    set session(value) {
      if (value) ctx.ports.setSession(value);
    },
    get activeExec() {
      return ctx.ports.getActiveExec();
    },
    set activeExec(value) {
      ctx.ports.setActiveExec(value);
    },
    get activeSkill() {
      return ctx.ports.getActiveSkill();
    },
    set activeSkill(value) {
      ctx.ports.setActiveSkill(value);
    },
    get permissionMode() {
      return ctx.ports.getPermissionMode();
    },
    get selectedPermissionProfile() {
      return ctx.ports.getSelectedPermissionProfile();
    },
    get attachmentReferences() {
      return ctx.ports.getAttachmentReferences();
    },
    get toolCalls() {
      return ctx.ports.getToolCalls();
    },
    get runtimeDiagnosticsBySession() {
      return ctx.ports.getRuntimeDiagnosticsBySession();
    },
    get executionBySession() {
      return ctx.state.executionBySession;
    },
    get turnSession() {
      return ctx.state.turnSession;
    },
    get turnAgent() {
      return ctx.ports.getTurnAgent();
    },
    get replayMode() {
      return ctx.ports.getReplayMode();
    },
    get sink() {
      return ctx.ports.getSink();
    },
    publish: ctx.ports.publish,
    publishForSession: ctx.ports.publishForSession,
    ensureExecution: ctx.ports.ensureExecution,
    executionForTurn: ctx.ports.executionForTurn,
    extensionEnabled: ctx.ports.extensionEnabled,
    extensionToolPermission: ctx.ports.extensionToolPermission,
    pluginsController: ctx.ports.getPluginsController(),
    applyAgentPolicy: ctx.ports.applyAgentPolicy,
    applyAgentProvider: ctx.ports.applyAgentProvider,
    resolveContextStatusConfig: ctx.ports.resolveContextStatusConfig,
    contextWindowResolver: ctx.ports.getContextWindowResolver(),
    modelRefKeyForSelection: ctx.ports.modelRefKeyForSelection,
    tryParseToolArguments: ctx.ports.tryParseToolArguments,
    parseToolArguments: ctx.ports.parseToolArguments,
    validateToolParameters: ctx.ports.validateToolParameters,
    authorizeWorkspaceRead: ctx.ports.authorizeWorkspaceRead,
    authorizeSandboxMerge: ctx.ports.authorizeSandboxMerge,
    toolSettings: ctx.ports.toolSettings,
    redactToolOutput: ctx.ports.redactToolOutput,
    redactToolOutputEnabled: ctx.ports.redactToolOutputEnabled,
    teamBehavior: ctx.ports.teamBehavior,
    tools: ctx.ports.getTools(),
    isToolAllowed: ctx.ports.isToolAllowed,
    createToolPolicyLayer: ctx.ports.createToolPolicyLayer,
    effectiveMaxSteps: ctx.ports.effectiveMaxSteps,
    skillService: ctx.ports.skillService,
    requestNaviWake: ctx.ports.requestNaviWake,
    createCollabChatTool: ctx.ports.createCollabChatTool,
    initializeCheckpointController: ctx.ports.initializeCheckpointController,
    runtimeStatusSnapshot: ctx.ports.runtimeStatusSnapshot,
    scheduleRuntimeStatusSnapshot: ctx.ports.scheduleRuntimeStatusSnapshot,
  };
}

export type InitializeScope = ReturnType<typeof createInitializeRuntime>;
