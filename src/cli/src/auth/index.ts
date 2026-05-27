export type { AuthProvider, AuthorizeOptions, StoredCredential } from './types';
export { loadCredential, saveCredential, deleteCredential, listCredentialProviders } from './credential-store';
export { getValidCredential, getValidAccessToken, refreshCredentialNow, isInvalidGrant } from './refresh';
export type { RefreshNowOptions } from './refresh';
export { getProvider, providerNames, PROVIDERS } from './providers/registry';
// Device-flow allowlist matches Google's policy: only youtube + calendar work via /device/code.
export { googleDeviceFlow, DEVICE_FLOW_SUPPORTED_SCOPES } from './providers/google';
export type {
    DeviceFlowStart,
    DeviceFlowPoll,
    DeviceFlowPollResult,
    DeviceFlowPollPending,
    DeviceFlowPollExpired,
    DeviceFlowPollDenied,
} from './providers/google';
