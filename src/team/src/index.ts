export { createTeamMember } from './factory';
export type { TeamMember, CreateTeamMemberOptions } from './factory';

export { TeamHandler } from './handler';
export type { TeamHandlerConfig, ThreadIdentity, ThreadResolver } from './handler';

export { startFlopsyBot } from './bootstrap';
export type { BootstrapOptions } from './bootstrap';

export { seedWorkspaceTemplates, teamTemplatesDir } from './seed-workspace';

// Storage primitives — surfaced so the CLI can talk to state.db without
// owning the schema. Concurrent writers are safe under SQLite WAL mode.
export {
    LearningStore,
    PairingStore,
    getSharedLearningStore,
    getSharedPairingStore,
    closeSharedLearningStore,
    closeSharedPairingStore,
    PAIRING_CODE_ALPHABET,
    PAIRING_CODE_LENGTH,
    PAIRING_PENDING_TTL_MS,
    PAIRING_MAX_PENDING_PER_CHANNEL,
} from './harness';
export type { PairingPending, PairingApproved } from './harness';
