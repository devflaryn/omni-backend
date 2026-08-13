/*
 * Running-state presence, derived from a heartbeat lease.
 *
 * The desktop app renews `running.heartbeatAt` while an instance is up. It is a
 * lease rather than a boolean because the interesting failures are exactly the
 * ones where no "stopped" ever arrives: the machine is unplugged, the app is
 * killed, the network drops. A stale lease reads as Stopped, so the worst case
 * is a short window of "still shows Running", not a permanently wedged row.
 */
export const RUNNING_LEASE_MS = 90_000;      // ~3 missed 30 s heartbeats

export function isLeaseFresh(running, now = Date.now()) {
    const beat = running?.heartbeatAt ? new Date(running.heartbeatAt).getTime() : 0;
    return beat > 0 && now - beat < RUNNING_LEASE_MS;
}

/**
 * What the UI should show for one account, from the point of view of the device
 * asking. `viewerDeviceId` is the asking machine's own id — an account running
 * HERE is plain "Running"; the same account running elsewhere has to say where,
 * because "Running" on a machine that isn't running it is the single most
 * confusing thing this screen could claim.
 */
export function presenceView(account, viewerDeviceId = null, now = Date.now()) {
    const running = account?.running;
    if (!isLeaseFresh(running, now)) {
        return { state: 'stopped', label: 'Stopped', device: null, isLocal: false };
    }
    const isLocal = !!viewerDeviceId && running.deviceId === viewerDeviceId;
    const where = running.deviceName || running.os || 'another device';
    return {
        state: 'running',
        label: isLocal ? 'Running' : `Running on ${where}`,
        device: {
            deviceId: running.deviceId ?? null,
            deviceName: running.deviceName ?? null,
            os: running.os ?? null,
        },
        isLocal,
        mode: running.mode ?? null,
        placeId: running.placeId ?? null,
        since: running.since ?? null,
    };
}
