/**
 * Harness Types - Core Learning System
 *
 * Defines: Signal, Strategy, Lesson, Skill, HarnessContext
 * These flow through: Signal → Strategy Update → Lesson Record → Skill Extraction
 */

// ============================================================================
// SIGNALS (What the agent learns from - 4 types)
// ============================================================================

export type SignalType = 'explicit' | 'implicit' | 'tool_outcome' | 'metric';
export type SignalCategory = 'positive' | 'negative' | 'neutral';

/**
 * A Signal is feedback from agent execution.
 *
 * 4 sources:
 * - explicit: User said "good", "wrong", "not that"
 * - implicit: User followed up, shared, engaged
 * - tool_outcome: Tools succeeded/failed
 * - metric: Latency, tokens, turns
 */
export interface Signal {
    // Core
    type: SignalType;
    strength: number; // [0.0 - 1.0]
    category: SignalCategory;
    timestamp: number;

    // Context
    topic?: string; // "AI", "coding", "research"
    reason?: string;

    // Tool outcome signals
    tool?: string;
    toolSuccess?: boolean;

    // Metric signals
    metric?: string;
    value?: number;

    // Explicit feedback signals
    userFeedback?: string;
}

// ============================================================================
// STRATEGIES (What works, scored in real-time)
// ============================================================================

/**
 * A Strategy is an approach that works.
 * Effectiveness changes based on signals (real-time learning).
 *
 * Example:
 * - name: "Break complex tasks into steps"
 * - effectiveness: 0.92 (high, used successfully)
 * - uses: 12 (used 12 times)
 * - lastUsed: 1713350400000
 */
export interface Strategy {
    id: string;
    name: string;
    description: string;
    domain?: string; // "research", "coding", "analysis"

    // Learning metrics
    effectiveness: number; // [0.2 - 1.0], clamped
    uses: number;
    lastUsed: number;
    createdAt: number;
    refinements: number;

    // Relations
    linkedSkillId?: string;

    // Organization
    tags: string[];
}

// ============================================================================
// LESSONS (What NOT to do - prevent known mistakes)
// ============================================================================

/**
 * A Lesson is a correction from failure.
 * Prevents the agent from repeating mistakes.
 *
 * Example:
 * - rule: "Don't use inline code on Discord"
 * - reason: "User correction: inline code breaks formatting"
 * - severity: "important"
 */
export interface Lesson {
    id: string;

    // The rule
    rule: string;
    reason: string;

    // Context
    domain?: string; // "discord", "coding", "formatting"
    severity: 'minor' | 'important' | 'critical';

    // Tracking
    recordedAt: number;
    preventionCount: number; // times this prevented a mistake
    appliesTo: string; // "user:all" or "user:specific_id"

    // Learning
    exampleMistake?: string;
    correction?: string;

    // Organization
    tags: string[];
}

// ============================================================================
// SKILLS (Reusable procedures that work well)
// ============================================================================

/**
 * A Skill is an extracted procedure.
 * Saved after successful complex tasks.
 * Reused in future similar tasks.
 *
 * Stored in: ~/.flopsy/skills/ (user skills) or state.db via LearningStore.
 */

export interface SkillStep {
    order: number;
    action: string;
    description: string;

    expectedInput?: string;
    expectedOutput?: string;
    tools: string[];

    decisionPoint?: {
        condition: string;
        branches: Array<{ if: string; then: string }>;
    };
}

export interface Skill {
    id: string;
    name: string;
    description: string;
    domain: string; // "research", "coding", etc.

    // Pattern matching
    taskPattern: string; // "When user asks for X, do Y"
    successIndicators: string[];

    // Procedure
    steps: SkillStep[];
    toolsUsed: string[];

    // Learning metrics
    successRate: number; // [0.0 - 1.0]
    usesCount: number;
    refinementsCount: number;

    // Timestamps
    createdAt: number;
    lastUsed: number;
    lastRefined: number;

    // Cost tracking
    avgTokensBefore?: number; // baseline
    avgTokensAfter?: number; // optimized
    costReduction?: number; // percentage

    // Metadata
    createdFrom: 'agent_reflection' | 'user_suggestion';
    tags: string[];
    filePath?: string; // where it's stored
}

// ============================================================================
// HARNESS CONTEXT (Everything loaded before agent runs)
// ============================================================================

/**
 * HarnessContext is loaded in beforeInvoke hook.
 * Contains all learning data relevant to current user.
 * Injected into system prompt to guide agent.
 */
export interface HarnessContext {
    userId: string;

    // Top strategies for this user (loaded by relevance)
    activeStrategies: Strategy[];

    // Lessons applicable to this domain
    applicableLessons: Lesson[];

    // Skills relevant to expected task
    relevantSkills: Skill[];

    // What user is interested in (from signal detection)
    learnedInterests: Array<{
        topic: string;
        confidence: number; // [0.0 - 1.0]
        mentions: number;
        lastMentioned: number;
    }>;

    // Patterns in user behavior
    metrics?: {
        preferredResponseLength: 'concise' | 'detailed' | 'balanced';
        averageResponseTime: number;
        successfulTasksCount: number;
        failedTasksCount: number;
        averageQualityScore: number;
    };

    // Custom user context
    customContext?: Record<string, unknown>;
}

// ============================================================================
// AGENT RESPONSE (What agent returned, with metrics)
// ============================================================================

export interface AgentResponse {
    text: string;
    didSendViaTool: boolean;

    tokens?: {
        input: number;
        output: number;
    };

    durationMs: number;

    toolsCalled: Array<{
        name: string;
        success: boolean;
        duration: number;
    }>;

    complexity: number; // 1-10
    success: boolean;

    backgroundTaskId?: string;
}

// ============================================================================
// USER FEEDBACK (How user responded to agent)
// ============================================================================

export interface UserFeedback {
    explicit?: {
        type: 'positive' | 'negative' | 'correction';
        text: string;
    };

    followUp?: boolean; // user asked follow-up
    shared?: boolean; // user shared response
    ignored?: boolean; // user ignored response
    rating?: number; // [1-5]
    message?: string;
}

// ============================================================================
// DETECTED SIGNALS OUTPUT
// ============================================================================

export interface DetectedSignals {
    signals: Signal[];
    totalStrength: number;
    userCorrected: boolean;
    correctionRule?: string;
}
