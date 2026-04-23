/**
 * Internal re-export of the Peer type so command files don't cross-import
 * from `@gateway/types` (which would create a cycle: types → commands → types).
 */

export type { Peer } from '../types/channel';
