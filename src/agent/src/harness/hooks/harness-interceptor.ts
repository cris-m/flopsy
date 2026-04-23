import { createLogger } from '@flopsy/shared';
import { BaseInterceptor } from 'flopsygraph';
import type { Interceptor, InterceptorContext, NodeResult } from 'flopsygraph';
import type { HarnessContext, AgentResponse, UserFeedback, Signal } from '@shared/types';
import { HarnessManager } from '../harness-manager';

const log = createLogger('harness-interceptor');

export interface HarnessInterceptorConfig {
  manager: HarnessManager;
  userId: string;
  domain?: string;
}

/**
 * HarnessInterceptor — Integrates learning system into agent execution.
 *
 * Lifecycle:
 * 1. onAgentStart: Load context (strategies, lessons, skills)
 * 2. enrichState: Inject pending messages mid-execution (mid-turn redirect)
 * 3. onNodeEnd: Detect signals, update strategies after tool execution
 * 4. onAgentEnd: Final consolidation (future: dreaming system)
 */
export class HarnessInterceptor extends BaseInterceptor {
  readonly name = 'harness';
  readonly description = 'Learning system integration: context loading, signal detection, strategy updates';
  readonly priority = 50;

  private config: HarnessInterceptorConfig;
  private context: HarnessContext | null = null;
  private toolsExecutedInTurn: string[] = [];
  private pendingMessages: string[] = [];

  constructor(config: HarnessInterceptorConfig) {
    super();
    this.config = config;
  }

  /**
   * Load context before agent starts.
   * Called once per invocation, before any node executes.
   *
   * Loads:
   * - Top strategies by effectiveness
   * - Applicable lessons (corrections to avoid)
   * - Relevant skills
   * - Learned interests
   */
  async onAgentStart(ctx: InterceptorContext): Promise<void> {
    log.info({ userId: this.config.userId, domain: this.config.domain }, 'Loading harness context');
    this.context = await this.config.manager.loadContext(this.config.domain);
    this.toolsExecutedInTurn = [];
    this.pendingMessages = [];
    log.debug(
      {
        strategies: this.context.activeStrategies.length,
        lessons: this.context.applicableLessons.length,
        skills: this.context.relevantSkills?.length ?? 0,
      },
      'Context loaded',
    );
  }

  /**
   * Inject pending messages mid-execution (Midjourney-like capability).
   *
   * Fires at START of every node, giving more time for user input to queue.
   * Injects messages between tool results and next LLM call.
   *
   * Returns partial state that merges into current state:
   * { messages: [{ role: 'user', content: '...' }] }
   */
  enrichState(state: Readonly<Record<string, unknown>>): Partial<Record<string, unknown>> {
    if (this.pendingMessages.length === 0) {
      return {};
    }

    const msgs = this.pendingMessages.splice(0);
    log.info({ count: msgs.length }, 'Injecting pending messages mid-turn');

    return {
      messages: msgs.map((content) => ({
        role: 'user',
        content,
      })),
    };
  }

  /**
   * After each node completes, detect signals and update learning.
   *
   * For tool nodes: record tool success/failure
   * For llm nodes: record latency, token usage
   * At turn boundary: consolidate signals, update strategies
   */
  async onNodeEnd(
    nodeName: string,
    result: NodeResult<Record<string, unknown>>,
    ctx: InterceptorContext,
  ): Promise<NodeResult<Record<string, unknown>> | void> {
    if (!this.context) return;

    // Track tools executed in this turn
    if (nodeName === 'execute_tools') {
      const messages = (result.state?.messages as any[]) ?? [];
      const toolMessages = messages.filter((m) => m.role === 'tool');
      for (const msg of toolMessages) {
        this.toolsExecutedInTurn.push(msg.name ?? 'unknown');
      }
      log.debug({ tools: this.toolsExecutedInTurn }, 'Tools executed');
    }

    // At end of LLM call, detect signals if this was the last turn
    if (nodeName === 'llm_call' && result.next?.length === 0) {
      log.info('Agent turn complete, detecting signals');

      // Build agent response for signal detection
      const state = result.state ?? {};
      const messages = (state.messages as any[]) ?? [];
      const lastMsg = messages.at(-1);

      const agentResponse: AgentResponse = {
        content: lastMsg?.role === 'assistant' ? String(lastMsg.content ?? '') : '',
        toolsCalled: this.toolsExecutedInTurn.map((name) => ({
          name,
          success: true,
        })),
        durationMs: 0,
      };

      // Detect signals (will be enhanced in signal-detector.ts)
      const detectedSignals = await this.config.manager.detectSignals(agentResponse);

      if (detectedSignals.signals.length > 0) {
        // Update strategies with detected signals
        await this.config.manager.updateStrategies(
          detectedSignals.signals,
          this.context.activeStrategies,
        );

        // Record lesson if user corrected
        if (detectedSignals.userCorrected && detectedSignals.correctionRule) {
          await this.config.manager.recordLesson(
            detectedSignals.correctionRule,
            'User correction during execution',
            this.config.domain,
            'important',
          );
        }

        log.info(
          {
            signalCount: detectedSignals.signals.length,
            totalStrength: detectedSignals.totalStrength,
            corrected: detectedSignals.userCorrected,
          },
          'Signals detected and strategies updated',
        );
      }

      // Reset for next turn
      this.toolsExecutedInTurn = [];
    }
  }

  /**
   * After agent completes, flush all changes to disk.
   */
  async onAgentEnd(state: Readonly<Record<string, unknown>>, ctx: InterceptorContext): Promise<void> {
    log.info('Flushing harness state to disk');
    await this.config.manager.flush();
  }

  /**
   * Queue a message for mid-turn injection.
   * User calls this while agent is running to redirect behavior.
   */
  queueMessage(message: string): void {
    this.pendingMessages.push(message);
    log.debug({ message }, 'Message queued for mid-turn injection');
  }

  /**
   * Get queued messages without consuming them.
   */
  getPendingMessages(): string[] {
    return [...this.pendingMessages];
  }

  /**
   * Clear all pending messages.
   */
  clearPending(): void {
    this.pendingMessages = [];
  }
}

/**
 * Create a HarnessInterceptor bound to a HarnessManager.
 */
export function createHarnessInterceptor(config: HarnessInterceptorConfig): Interceptor {
  return new HarnessInterceptor(config);
}
