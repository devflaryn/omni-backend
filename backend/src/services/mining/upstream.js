import net from 'net';
import { EventEmitter } from 'events';

/**
 * Minimal stratum-ish upstream contract the proxy talks to. Real pools speak
 * JSON-RPC over TCP; this wraps that. The upstream is DEFERRED (no wallet/pool
 * configured yet), so production plugs a real connector in here later.
 */
export class RealUpstream extends EventEmitter {
    constructor({ host, port, wallet, worker }) {
        super();
        Object.assign(this, { host, port, wallet, worker });
    }
    connect() {
        this.sock = net.connect(this.port, this.host);
        this.sock.on('data', (b) => this.emit('data', b));
        this.sock.on('error', (e) => this.emit('error', e));
        this.sock.on('close', () => this.emit('close'));
    }
    send(line) { this.sock?.write(line.endsWith('\n') ? line : line + '\n'); }
    destroy() { this.sock?.destroy(); }
}

/** Test upstream: accepts every submit at a fixed difficulty and reports it. */
export class FakeUpstream extends EventEmitter {
    constructor({ difficulty = 1000 } = {}) { super(); this.difficulty = difficulty; }
    connect() { setImmediate(() => this.emit('ready')); }
    send() {} // ignore login/subscribe
    submit() { setImmediate(() => this.emit('accepted', { difficulty: this.difficulty })); }
    destroy() {}
}
