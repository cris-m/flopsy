/**
 * Harness Integration Example
 *
 * This example shows how to wire HarnessInterceptor into a ReactAgent,
 * enabling real-time learning from execution signals.
 *
 * The harness learns from:
 * 1. Tool execution success/failure
 * 2. User corrections and feedback
 * 3. Agent latency metrics
 * 4. Implicit signals (follow-ups, ignored results)
 *
 * Usage:
 *   npm run example harness-integration
 */

import { createReactAgent } from 'flopsygraph';
import { AnthropicChatModel } from '@flopsy/orchestrator';
import {
  HarnessManager,
  HarnessInterceptor,
} from '@flopsy/agent/harness';

// Example tools (typical agent setup)
const tools = [
  {
    name: 'web_search',
    description: 'Search the web for information',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

/**
 * Create an agent with harness learning integrated.
 *
 * The harness interceptor:
 * - Loads relevant strategies before execution (onAgentStart)
 * - Detects signals after each tool execution (onNodeEnd)
 * - Allows mid-turn message injection for user redirects (enrichState)
 * - Flushes learned strategies to disk after completion (onAgentEnd)
 */
async function createAgentWithHarness() {
  const userId = 'user_123';
  const domain = 'research'; // Domain hint for lesson/strategy filtering

  // 1. Create harness manager
  const harness = new HarnessManager({ userId, userName: 'Alice' });

  // 2. Create harness interceptor bound to manager
  const harnessInterceptor = new HarnessInterceptor({
    manager: harness,
    userId,
    domain,
  });

  // 3. Create agent with interceptor in pipeline
  const model = new AnthropicChatModel({
    modelId: 'claude-3-5-sonnet-20241022',
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const agent = createReactAgent({
    model,
    tools,
    interceptors: [harnessInterceptor], // ← Harness plugs in here
  });

  return { agent, harness, harnessInterceptor };
}

/**
 * Run agent and handle mid-turn message injection.
 */
async function runWithMidTurnCapability() {
  const { agent, harness, harnessInterceptor } = await createAgentWithHarness();

  // Simulate a long-running task
  const promise = agent.run({
    messages: [{ role: 'user', content: 'Research the latest AI trends' }],
  });

  // In a real scenario, user could inject messages mid-execution
  // For example, while the agent is thinking, user types:
  // "Actually, focus on open-source models only"
  setTimeout(() => {
    harnessInterceptor.queueMessage('Actually, focus on open-source models only');
  }, 500);

  const result = await promise;

  // After execution, strategies and lessons are automatically persisted
  // Next time harness.loadContext() is called, it will use updated effectiveness scores
  return result;
}

/**
 * Access learned knowledge after execution.
 */
async function inspectLearnedKnowledge() {
  const { harness } = await createAgentWithHarness();

  // Load and inspect learned strategies
  const strategies = harness.getAllStrategies();
  console.log('Learned strategies:', strategies);

  // Load and inspect lessons (corrections)
  const lessons = harness.getAllLessons();
  console.log('Recorded lessons:', lessons);

  // Manually update strategy effectiveness
  // (normally done automatically via signal detection)
  harness.flush();
}

// ★ Insight ─────────────────────────────────────
// The harness becomes part of the agent execution pipeline:
//
// 1. beforeInvoke → loads strategies from disk
// 2. during execution → allows user to queue messages (enrichState)
// 3. afterInvoke → detects signals from tool results, user feedback
// 4. afterExecution → flushes learned changes to disk
//
// This creates a tight feedback loop: agent action → signal detection →
// strategy update → next invocation uses updated strategies.
// Zero-latency learning with no extra API calls.
// ─────────────────────────────────────────────────
