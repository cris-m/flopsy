export * from './types';
export * from './core';
export * from './channels';
export * from './config';
export { FlopsyGateway } from './gateway';
export {
    BLOCK_CAPABLE_EVENTS,
    discoverAndLoadHooks,
    HookRegistry,
    emitHook,
    emitHookAwait,
    getHookRegistry,
    setHookRegistry,
    type HookAggregate,
    type HookConfig,
    type HookContext,
    type HookHandler,
    type HookResult,
    type RegisteredHook,
} from './hooks';
export {
    setPairingFacade,
    getPairingFacade,
    type PairingFacade,
    type PairingPendingView,
    type PairingApprovedView,
    type RequestCodeOutcome,
} from './commands/pairing-facade';
export {
    setPersonalityFacade,
    getPersonalityFacade,
    type PersonalityFacade,
    type PersonalityEntry,
} from './commands/personality-facade';
export {
    setInsightsFacade,
    getInsightsFacade,
    type InsightsFacade,
    type InsightsSnapshot,
    type InsightsActivity,
    type InsightsTokenRow,
    type InsightsLongestSession,
    type InsightsRecentSession,
} from './commands/insights-facade';
export {
    setBranchFacade,
    getBranchFacade,
    type BranchFacade,
    type BranchSummary,
    type BranchOutcome,
} from './commands/branch-facade';

// Proactive decision schema — exposed so the team package can pass it
// to `createReactAgent` as `outputSchema` when constructing proactive
// agent instances (handler.ts when isProactive=true).
export {
    ProactiveDecisionSchema,
    DeliverCategory,
    SilenceReason,
    CitationSchema,
    ReportedIdsSchema,
} from './proactive';
export type {
    ProactiveDecision,
    DeliverCategoryT,
    SilenceReasonT,
    Citation,
    ReportedIds,
} from './proactive';
