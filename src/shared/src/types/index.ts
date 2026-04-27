export type {
    FlopsyConfig,
    HeartbeatDefinitionConfig,
    JobDefinitionConfig,
    AgentDefinition,
} from '../config/schema';

// Harness types (learning system)
export type {
    Signal,
    Strategy,
    Lesson,
    HarnessContext,
    AgentResponse,
    UserFeedback,
    DetectedSignals,
} from './harness';

// Proactive types (scheduling, triggers, execution)
export type {
    Peer,
    CronSchedule,
    DeliveryMode,
    DeliveryTarget,
    TriggerKind,
    HeartbeatDefinition,
    CronPayload,
    JobDefinition,
    ExecutionJob,
    ExecutionResult,
} from './proactive';
