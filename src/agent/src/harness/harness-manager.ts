/**
 * Harness Manager
 *
 * Coordinates the learning system:
 * 1. beforeInvoke: Load context (strategies, lessons, skills)
 * 2. afterInvoke: Detect signals and update learning
 * 3. enrichState: Message injection during execution
 *
 * This is the central coordinator that ties everything together.
 */

import { StrategyStore } from './stores/strategy-store';
import { LessonStore } from './stores/lesson-store';
import { SignalDetector, SkillRegistryManager } from './learning';
import type {
  Strategy,
  Lesson,
  HarnessContext,
  AgentResponse,
  UserFeedback,
  DetectedSignals,
  Signal,
} from '@shared/types';

export interface HarnessManagerConfig {
  userId: string;
  userName?: string;
}

export class HarnessManager {
  private config: HarnessManagerConfig;
  private strategyStore: StrategyStore;
  private lessonStore: LessonStore;
  private signalDetector: SignalDetector;
  private skillRegistry: SkillRegistryManager;

  constructor(config: HarnessManagerConfig) {
    this.config = config;
    this.strategyStore = new StrategyStore();
    this.lessonStore = new LessonStore();
    this.signalDetector = new SignalDetector();
    this.skillRegistry = new SkillRegistryManager();
  }

  // ========================================================================
  // BEFORE INVOKE: Load Context
  // ========================================================================

  /**
   * Load context before agent runs
   * Called in beforeInvoke hook
   *
   * Collects:
   * - Top 5 strategies by effectiveness
   * - Applicable lessons for this domain
   * - Relevant skills (matched by domain/pattern)
   */
  async loadContext(domain?: string): Promise<HarnessContext> {
    // Load strategies
    const allStrategies = this.strategyStore.getAll();
    const activeStrategies = this.strategyStore.getTopByEffectiveness(5);

    // Load lessons
    const applicableLessons = domain
      ? this.lessonStore.getByDomain(domain)
      : this.lessonStore.getAll();

    // Load skills by effectiveness from skill registry
    const topSkills = domain
      ? await this.skillRegistry.getByDomain(domain)
      : await this.skillRegistry.getAll();

    const relevantSkills = Object.entries(topSkills)
      .map(([skillName, entry]) => ({
        name: skillName,
        effectiveness: entry.effectiveness,
        successRate: entry.successRate,
        useCount: entry.useCount,
        tags: entry.tags || [],
      }))
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, 10);

    // TODO: Load learned interests from signal history (future)
    const learnedInterests: any[] = [];

    return {
      userId: this.config.userId,
      activeStrategies,
      applicableLessons,
      relevantSkills: relevantSkills as any,
      learnedInterests,
      metrics: undefined,
      customContext: undefined,
    };
  }

  // ========================================================================
  // AFTER INVOKE: Detect Signals & Update Learning
  // ========================================================================

  /**
   * Detect signals from agent response and user feedback
   * Delegates to SignalDetector for the actual detection logic.
   */
  async detectSignals(
    response: AgentResponse,
    feedback?: UserFeedback
  ): Promise<DetectedSignals> {
    return this.signalDetector.detect(response, feedback);
  }

  /**
   * Update strategies based on detected signals
   * This is the core real-time learning
   */
  async updateStrategies(
    signals: Signal[],
    strategies: Strategy[]
  ): Promise<void> {
    for (const strategy of strategies) {
      for (const signal of signals) {
        this.strategyStore.updateEffectiveness(strategy.id, signal.strength);
      }
    }

    this.strategyStore.flush();
  }

  /**
   * Record a lesson from user correction
   */
  async recordLesson(
    rule: string,
    reason: string,
    domain?: string,
    severity: 'minor' | 'important' | 'critical' = 'important'
  ): Promise<Lesson> {
    // Check if lesson already exists
    const existing = this.lessonStore.lessonExists(rule);
    if (existing) {
      return existing;
    }

    const lesson = this.lessonStore.recordCorrection(rule, reason, domain, severity);
    this.lessonStore.flush();

    return lesson;
  }

  // ========================================================================
  // ENRICH STATE: Message Injection
  // ========================================================================

  /**
   * Inject pending messages into agent state
   * Called via enrichState hook during execution
   *
   * Allows user to redirect agent mid-execution
   * (e.g., "actually use Fastify instead")
   */
  enrichState(pendingMessages: string[]): Record<string, any> {
    if (pendingMessages.length === 0) {
      return {};
    }

    // Return patch to be merged into AgentState
    return {
      messages: pendingMessages.map(content => ({
        role: 'user',
        content,
      })),
    };
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================

  /**
   * Get all strategies
   */
  getAllStrategies(): Strategy[] {
    return this.strategyStore.getAll();
  }

  /**
   * Get all lessons
   */
  getAllLessons(): Lesson[] {
    return this.lessonStore.getAll();
  }

  /**
   * Flush all changes to disk
   */
  async flush(): Promise<void> {
    this.strategyStore.flush();
    this.lessonStore.flush();
    await this.skillRegistry.flush();
  }

  /**
   * Reload from disk (discard in-memory changes)
   */
  reload(): void {
    this.strategyStore.reload();
    this.lessonStore.reload();
  }
}

// ★ Insight ─────────────────────────────────────────
// HarnessManager is the coordinator that ties together:
// 1. Storage (strategies, lessons, skills, metrics)
// 2. Signal detection (4 types: explicit, implicit, tool, metric)
// 3. Real-time updates (boost/decay effectiveness)
// 4. Message injection (mid-execution redirection)
//
// This is where "learning" happens - synchronously in afterInvoke,
// zero cost (no extra API calls), immediate feedback loop.
// ─────────────────────────────────────────────────
