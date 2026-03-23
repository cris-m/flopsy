export type Provider =
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'groq'
    | 'cohere'
    | 'mistral'
    | 'bedrock'
    | 'ollama'
    | 'openrouter'
    | 'deepseek'
    | 'perplexity'
    | 'xai'
    | 'fireworks'
    | 'nvidia'
    | (string & {});

export type CheckpointerType = 'memory' | 'sqlite' | 'postgres' | 'cosmosdb' | 'custom';

export type CostTier = 'low' | 'medium' | 'high';

export interface ModelConfig {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    baseUrl?: string;
    recursionLimit?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    seed?: number;
    reasoningEffort?: string; // OpenAI o-series models
    topK?: number; // Google-specific
    numCtx?: number; // Ollama-specific
}

export interface FallbackModel {
    provider: string;
    model: string;
    config?: ModelConfig;
}

export interface ModelRef {
    provider: Provider;
    name: string;
    config?: ModelConfig;
}

export interface Routing {
    enabled: boolean;
    tiers: {
        fast: ModelRef;
        balanced: ModelRef;
        powerful: ModelRef;
    };
}

export type RoutingTierKey = keyof Routing['tiers'];

export interface ModelSource {
    name: string;
    model: ModelRef;
    fallback_models?: ModelRef[];
    routing?: Routing;
}

export interface SubAgent extends ModelSource {
    cost_tier: CostTier;
}

export interface CostOptimization {
    prefer_cheaper_fallbacks: boolean;
    max_retries_per_model: number;
    timeout_ms: number;
}

export interface Checkpointer {
    type: CheckpointerType;
}

export interface AgentConfig extends ModelSource {
    description: string;
    cost_tier?: CostTier;
    checkpointer: Checkpointer;
    subagents?: SubAgent[];
    cost_optimization?: CostOptimization;
    recursion_limit?: number;
    context_limit?: number;
}
