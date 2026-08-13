import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { presenceView, isLeaseFresh, RUNNING_LEASE_MS } from '../src/utils/presence.js';

describe('presence lease', () => {
    const now = Date.now();
    const running = (over = {}) => ({
        running: {
            deviceId: 'mac-1', deviceName: 'Mac mini', os: 'darwin',
            heartbeatAt: new Date(now - 1000), since: new Date(now - 60_000),
            ...over,
        },
    });

    it('treats a recent heartbeat as running', () => {
        assert.ok(isLeaseFresh(running().running, now));
    });

    it('treats a lapsed heartbeat as stopped — a crashed machine never sends "stopped"', () => {
        const stale = running({ heartbeatAt: new Date(now - RUNNING_LEASE_MS - 1) });
        assert.ok(!isLeaseFresh(stale.running, now));
        assert.equal(presenceView(stale, 'mac-1', now).state, 'stopped');
    });

    it('says plain "Running" to the machine that holds it', () => {
        assert.equal(presenceView(running(), 'mac-1', now).label, 'Running');
    });

    it('names the machine when it is running somewhere else', () => {
        assert.equal(presenceView(running(), 'win-1', now).label, 'Running on Mac mini');
    });

    it('falls back to the OS when the device has no friendly name', () => {
        const anon = running({ deviceName: null });
        assert.equal(presenceView(anon, 'win-1', now).label, 'Running on darwin');
    });

    it('reports stopped for an account that was never launched', () => {
        assert.equal(presenceView({ running: {} }, 'win-1', now).state, 'stopped');
    });
});
