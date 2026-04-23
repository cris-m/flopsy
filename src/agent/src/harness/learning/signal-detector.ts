import { createLogger } from '@flopsy/shared';
import type { Signal, AgentResponse, UserFeedback, DetectedSignals } from '@shared/types';

const log = createLogger('signal-detector');

/**
 * Signal Detector
 *
 * Detects 4 types of signals from agent execution:
 * 1. Explicit: User feedback ("good", "wrong", "correction")
 * 2. Implicit: User behavior (follow-up, shared, ignored)
 * 3. Tool: Tool execution success/failure
 * 4. Metric: Performance (latency, tokens, turns)
 *
 * All signals feed into strategy effectiveness updates (real-time learning).
 */
export class SignalDetector {
  /**
   * Detect signals from agent response and optional user feedback.
   *
   * Returns:
   * - signals: Array of detected signals with strength and category
   * - totalStrength: Sum of all signal strengths (can be negative)
   * - userCorrected: Was there a user correction?
   * - correctionRule: The correction text, if any
   */
  detect(response: AgentResponse, feedback?: UserFeedback): DetectedSignals {
    const signals: Signal[] = [];
    let totalStrength = 0;
    let userCorrected = false;
    let correctionRule: string | undefined;

    // ── Explicit feedback ────────────────────────────────────────────────
    if (feedback?.explicit) {
      const strength = feedback.explicit.type === 'positive' ? 1.0 : -1.0;
      signals.push({
        type: 'explicit',
        strength: Math.abs(strength),
        category:
          feedback.explicit.type === 'positive'
            ? 'positive'
            : feedback.explicit.type === 'correction'
              ? 'negative'
              : 'neutral',
        userFeedback: feedback.explicit.text,
        timestamp: Date.now(),
      });

      if (feedback.explicit.type === 'correction') {
        userCorrected = true;
        correctionRule = feedback.explicit.text;
      }

      totalStrength += Math.abs(strength);
      log.debug(
        { type: feedback.explicit.type, strength },
        'Explicit feedback signal detected',
      );
    }

    // ── Implicit signals ────────────────────────────────────────────────
    if (feedback?.followUp) {
      signals.push({
        type: 'implicit',
        strength: 0.7,
        category: 'positive',
        reason: 'user_followed_up',
        timestamp: Date.now(),
      });
      totalStrength += 0.7;
      log.debug('Follow-up signal detected (user asked next question)');
    }

    if (feedback?.shared) {
      signals.push({
        type: 'implicit',
        strength: 1.0,
        category: 'positive',
        reason: 'user_shared',
        timestamp: Date.now(),
      });
      totalStrength += 1.0;
      log.debug('Share signal detected (user shared response)');
    }

    if (feedback?.ignored) {
      signals.push({
        type: 'implicit',
        strength: 0.5,
        category: 'negative',
        reason: 'user_ignored',
        timestamp: Date.now(),
      });
      totalStrength -= 0.5;
      log.debug('Ignore signal detected (user ignored response)');
    }

    // ── Tool outcome signals ────────────────────────────────────────────
    for (const tool of response.toolsCalled) {
      const strength = tool.success ? 0.8 : -0.6;
      signals.push({
        type: 'tool_outcome',
        strength: Math.abs(strength),
        category: tool.success ? 'positive' : 'negative',
        tool: tool.name,
        toolSuccess: tool.success,
        timestamp: Date.now(),
      });
      totalStrength += strength;
    }

    if (response.toolsCalled.length > 0) {
      const successful = response.toolsCalled.filter((t) => t.success).length;
      log.debug(
        { total: response.toolsCalled.length, successful },
        'Tool outcome signals detected',
      );
    }

    // ── Metric signals (latency) ────────────────────────────────────────
    const latencySignal = response.durationMs < 2000 ? 0.5 : -0.3;
    signals.push({
      type: 'metric',
      strength: Math.abs(latencySignal),
      category: latencySignal > 0 ? 'positive' : 'negative',
      metric: 'latency_ms',
      value: response.durationMs,
      timestamp: Date.now(),
    });
    totalStrength += latencySignal;

    log.info(
      {
        signalCount: signals.length,
        totalStrength: totalStrength.toFixed(2),
        categories: {
          positive: signals.filter((s) => s.category === 'positive').length,
          negative: signals.filter((s) => s.category === 'negative').length,
          neutral: signals.filter((s) => s.category === 'neutral').length,
        },
      },
      'Signal detection complete',
    );

    return {
      signals,
      totalStrength,
      userCorrected,
      correctionRule,
    };
  }
}
