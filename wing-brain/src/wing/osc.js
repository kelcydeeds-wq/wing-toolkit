// osc.js — generic Behringer Wing OSC transport.
//
// This module knows nothing about tuning, channels, or the church layout —
// just connection, typed send, request/response "get", and address-pattern
// "subscribe". wing/client.js composes it for the System Tune feature; the
// audit scripts (dump-wing-state, apply-remap, the traffic recorder) use it
// directly for the same reason plain OSC clients exist: one transport, many
// callers.
//
// >>> Address scheme and reply format are best-guess from public Wing OSC
//     docs. Every read goes through get(), which times out instead of
//     hanging — an unconfirmed or wrong address degrades to `null`, it never
//     blocks the caller. TODO(church): confirm against the real console. <<<

import osc from 'osc';

export function makeOscTransport(config) {
  return config.mode === 'mock' ? new MockOscTransport(config) : new LiveOscTransport(config);
}

/* ------------------------------- LIVE ---------------------------------- */

class LiveOscTransport {
  constructor(config) {
    this.cfg = config.wing;
    this.subscribers = [];
    this.port = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      remoteAddress: this.cfg.host,
      remotePort: this.cfg.port
    });
    this.ready = new Promise((res) => this.port.on('ready', res));
    this.port.on('message', (msg) => this._dispatch(msg.address, unwrapArgs(msg.args)));
    this.port.open();
  }

  _dispatch(address, values) {
    for (const { pattern, handler } of this.subscribers) {
      if (pattern.test(address)) handler(values, address);
    }
  }

  /** Send a typed OSC message. `args` is a plain-value array (numbers/strings). */
  send(address, args = []) {
    this.port.send({ address, args: args.map(toOscArg) });
  }

  /**
   * Query the console's current value at `address`: send an empty message,
   * wait for the console to reply on the same address. Resolves `null` on
   * timeout instead of hanging or throwing — callers (state dumps, remap
   * tools) can treat every read as safe to await in a loop.
   */
  get(address, { timeoutMs = 800 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const unsub = this.subscribe(address, (values) => {
        if (done) return;
        done = true; clearTimeout(timer); unsub();
        resolve(values);
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true; unsub();
        resolve(null);
      }, timeoutMs);
      this.send(address, []);
    });
  }

  /**
   * Subscribe to incoming messages whose address matches `pattern` — an
   * exact string, or a RegExp for wildcard subscriptions (e.g. channel-strip
   * dumps). Returns an unsubscribe function.
   */
  subscribe(pattern, handler) {
    const entry = { pattern: toPattern(pattern), handler };
    this.subscribers.push(entry);
    return () => { this.subscribers = this.subscribers.filter((s) => s !== entry); };
  }

  close() { this.port.close(); }
}

function unwrapArgs(args) {
  return (args || []).map((a) => (a && typeof a === 'object' && 'value' in a) ? a.value : a);
}

function toOscArg(value) {
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'i' : 'f', value };
  return { type: 's', value: String(value) };
}

function toPattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/* ------------------------------- MOCK ---------------------------------- */

/**
 * In-memory address space for dev/testing. `get()` returns whatever was last
 * `send()` to that address (or `null` if nothing has ever been sent there —
 * same "never hangs, degrades gracefully" contract as the live transport).
 * `send()` also notifies subscribers, the way a real console echoes state
 * changes back out to OSC subscribers.
 */
class MockOscTransport {
  constructor() {
    this.ready = Promise.resolve();
    this.store = new Map();
    this.subscribers = [];
    this.log = []; // every send(), useful for tests/tools asserting on traffic
  }

  send(address, args = []) {
    this.store.set(address, args);
    this.log.push({ address, args });
    for (const { pattern, handler } of this.subscribers) {
      if (pattern.test(address)) handler(args, address);
    }
  }

  async get(address) {
    return this.store.has(address) ? this.store.get(address) : null;
  }

  subscribe(pattern, handler) {
    const entry = { pattern: toPattern(pattern), handler };
    this.subscribers.push(entry);
    return () => { this.subscribers = this.subscribers.filter((s) => s !== entry); };
  }

  /** Test/tool helper — seed a value as if the console already reported it,
   *  without going through send()'s subscriber notification. */
  seed(address, args) { this.store.set(address, args); }

  close() {}
}
