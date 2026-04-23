/**
 * Public surface of the CLI's auth module. Downstream packages (team,
 * gateway) import from here to reuse the credential store and refresh
 * helper — avoids reimplementing the same disk layout and refresh
 * buffer policy in two places.
 */

export type { AuthProvider, AuthorizeOptions, StoredCredential } from './types';
export { loadCredential, saveCredential, deleteCredential, listCredentialProviders } from './credential-store';
export { getValidCredential, getValidAccessToken } from './refresh';
export { getProvider, providerNames, PROVIDERS } from './providers/registry';
// Device flow — exposed for in-chat connect_service tool. Provider-specific
// since RFC 8628 details vary per IdP; google is the only one wired today.
export { googleDeviceFlow } from './providers/google';
export type {
    DeviceFlowStart,
    DeviceFlowPoll,
    DeviceFlowPollResult,
    DeviceFlowPollPending,
    DeviceFlowPollExpired,
    DeviceFlowPollDenied,
} from './providers/google';
