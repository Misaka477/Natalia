type FixtureMetadataProvider = {
  listModels?(): Promise<
    Array<{ id: string; contextWindow?: number; inputTokenLimit?: number }>
  >;
  modelDetail?(
    model: string,
  ): Promise<{ contextWindow?: number; inputTokenLimit?: number } | undefined>;
};

export const openAIChatCompatibleMetadata: FixtureMetadataProvider = {
  listModels: async () => [{ id: "gpt-5.5", contextWindow: 200000 }],
};

export const openAIResponsesCompatibleMetadata: FixtureMetadataProvider = {
  listModels: async () => [{ id: "gpt-4.1", inputTokenLimit: 1000000 }],
};

export const anthropicRequiredMaxTokens = {
  providerRequiresOutputLimit: true,
  providerDefaultOutputLimit: 4096,
};

export const geminiStyleMetadata: FixtureMetadataProvider = {
  modelDetail: async (model) =>
    model === "gemini-1.5-pro" ? { inputTokenLimit: 1000000 } : undefined,
};

export const incompleteOpenAICompatibleModels: FixtureMetadataProvider = {
  listModels: async () => [{ id: "opaque-openai-compatible" }],
};
