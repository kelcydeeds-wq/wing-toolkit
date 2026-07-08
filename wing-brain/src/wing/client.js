// client.js — Wing console interface (live OSC + mock).
//
// The tune module needs very little from the console: route the measurement
// signal to one output at a time, read back current output EQ/delay, and —
// only after an explicit Apply tap — write recommended EQ/delay to outputs.
//
// >>> LIVE OSC ADDRESSES ARE STUBBED. The Wing's output-section addresses will
//     be confirmed from the state dump at the audit session; the mock console
//     implements the same interface so everything upstream is testable now. <<<

import osc from 'osc';

export function makeWing(config) {
  return config.mode === 'mock' ? new MockWing(config) : new LiveWing(config);
}

/* ------------------------------- LIVE ---------------------------------- */

class LiveWing {
  constructor(config) {
    this.cfg = config.wing;
    this.port = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      remoteAddress: this.cfg.host,
      remotePort: this.cfg.port
    });
    this.ready = new Promise((res) => this.port.on('ready', res));
    this.port.open();
  }

  /** Route measurement source to exactly one output, others muted. */
  async soloOutput(outputId, outputs) {
    await this.ready;
    for (const out of outputs) {
      const mute = out.id === outputId ? 0 : 1;
      // TODO(church): confirm address — likely /out/<n>/mute or matrix routing
      this.send(`/out/${out.wingOutput}/mute`, mute);
    }
  }

  async unmuteAll(outputs) {
    await this.ready;
    for (const out of outputs) this.send(`/out/${out.wingOutput}/mute`, 0);
  }

  /** Apply recommended filters + delay to an output. Only called from Apply tap. */
  async applyTuning(output, filters, addDelayMs) {
    await this.ready;
    // TODO(church): confirm output EQ + delay OSC address scheme and value scaling
    this.send(`/out/${output.wingOutput}/delay`, addDelayMs);
    filters.forEach((f, i) => {
      const base = `/out/${output.wingOutput}/eq/${i + 1}`;
      this.send(`${base}/type`, f.type === 'hshelf' ? 'shv' : 'peq');
      this.send(`${base}/f`, f.freq);
      this.send(`${base}/g`, f.gainDb);
      this.send(`${base}/q`, f.q);
      this.send(`${base}/on`, 1);
    });
  }

  send(address, value) {
    this.port.send({ address, args: [{ type: typeof value === 'number' ? 'f' : 's', value }] });
  }

  close() { this.port.close(); }
}

/* ------------------------------- MOCK ---------------------------------- */

class MockWing {
  constructor() {
    this.state = { solo: null, applied: [] };
  }
  async soloOutput(outputId) {
    this.state.solo = outputId;
    log(`[mockWing] solo output → ${outputId}`);
  }
  async unmuteAll() {
    this.state.solo = null;
    log('[mockWing] all outputs unmuted');
  }
  async applyTuning(output, filters, addDelayMs) {
    this.state.applied.push({ output: output.id, filters, addDelayMs, at: Date.now() });
    log(`[mockWing] APPLY ${output.id}: +${addDelayMs} ms, ${filters.length} filters`);
  }
  close() {}
}

const log = (...a) => console.log(...a);
