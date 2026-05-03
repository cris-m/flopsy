// Late-bound facade — gateway-side handle, team package binds the impl at startup.
// Same pattern as dnd-facade / session-facade. Keeps gateway free of better-sqlite3.

export interface PairingPendingView {
    readonly channel: string;
    readonly code: string;
    readonly senderId: string;
    readonly senderName: string | null;
    readonly createdAt: number;
}

export interface PairingApprovedView {
    readonly channel: string;
    readonly senderId: string;
    readonly senderName: string | null;
    readonly approvedAt: number;
}

export interface RequestCodeOutcome {
    readonly code: string;
    readonly isNew: boolean;
}

export interface PairingFacade {
    // Returns null when the channel is at its pending cap.
    requestCode(
        channel: string,
        senderId: string,
        senderName?: string,
    ): RequestCodeOutcome | null;

    approveByCode(
        channel: string,
        code: string,
    ): { senderId: string; senderName: string | null } | null;

    approveBySenderId(
        channel: string,
        senderId: string,
        senderName?: string,
    ): void;

    revoke(channel: string, senderId: string): boolean;
    isApproved(channel: string, senderId: string): boolean;

    listPending(channel?: string): readonly PairingPendingView[];
    listApproved(channel?: string): readonly PairingApprovedView[];

    clearExpired(channel?: string): number;
    clearAllPending(channel?: string): number;
}

let facade: PairingFacade | null = null;

export function setPairingFacade(f: PairingFacade | null): void {
    facade = f;
}

export function getPairingFacade(): PairingFacade | null {
    return facade;
}
