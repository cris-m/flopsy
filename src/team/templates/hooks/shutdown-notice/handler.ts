// shutdown-notice — message the last-active user that the gateway is going down.
//
// Hooks are normally metadata-only and can't send. For gateway.shutdown the
// gateway enriches the context with `lastPeer` ({ channel, peer }) and a bound
// `send(channel, peer, body)` bound to the live channels — so this runs BEFORE
// the drain interrupts the user's turn. Deterministic: no LLM, no agent.
//
// Edit the message string below to taste.

type SendFn = (
    channel: string,
    peer: { id: string; type: string },
    body: string,
) => Promise<void>;

interface LastPeer {
    channel: string;
    peer: { id: string; type: string };
}

const SHUTDOWN_MESSAGE = '⚠️ Gateway shutting down — your current task will be interrupted. Back shortly.';

export async function handle(eventType: string, context: Record<string, unknown>): Promise<void> {
    if (eventType !== 'gateway.shutdown') return;

    const lastPeer = context.lastPeer as LastPeer | undefined;
    const send = context.send as SendFn | undefined;
    if (!lastPeer || typeof send !== 'function') {
        console.log(`[shutdown-notice] skipped — lastPeer=${!!lastPeer} send=${typeof send}`);
        return;
    }

    try {
        await send(lastPeer.channel, lastPeer.peer, SHUTDOWN_MESSAGE);
        console.log(`[shutdown-notice] sent to ${lastPeer.channel}:${lastPeer.peer.id}`);
    } catch (err) {
        console.log(`[shutdown-notice] send FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
}
