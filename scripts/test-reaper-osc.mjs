#!/usr/bin/env node
// test-reaper-osc.mjs — Bench Test B0.2
// Proves external control of REAPER FX parameters over OSC, dependency-free.
//
// Setup in REAPER first:
//   Preferences → Control/OSC/web → Add → OSC (Open Sound Control)
//   Mode: "Configure device IP+local port", Local listen port: 8000
//   Allow binding messages to REAPER actions/FX learn: checked
//
// Usage:
//   node test-reaper-osc.mjs <reaper-ip> [track#] [fx#] [param#] [value 0..1]
//   node test-reaper-osc.mjs 192.168.1.60          # wiggles track1/fx1/param1
//
// PASS: you see the parameter move in REAPER's FX window AND the script prints
// the value it read back. Then find Tune Real-Time's key parameter number with
// list-fx-params.lua and re-run pointing at it.

import dgram from 'node:dgram';

const [ip, track = 1, fx = 1, param = 1, value] = process.argv.slice(2);
if (!ip) {
  console.error('usage: node test-reaper-osc.mjs <reaper-ip> [track] [fx] [param] [value0..1]');
  process.exit(1);
}
const PORT = 8000;        // REAPER's local listen port (set in prefs)
const REPLY_PORT = 9000;  // set as the "device port" in REAPER prefs to get feedback

/* ---- minimal OSC encode/decode ---- */
function oscMessage(address, ...args) {
  const bufs = [oscString(address), oscString(',' + args.map(a =>
    typeof a === 'number' ? 'f' : 's').join(''))];
  for (const a of args) {
    if (typeof a === 'number') {
      const b = Buffer.alloc(4); b.writeFloatBE(a); bufs.push(b);
    } else bufs.push(oscString(a));
  }
  return Buffer.concat(bufs);
}
function oscString(s) {
  const len = Math.ceil((s.length + 1) / 4) * 4;
  const b = Buffer.alloc(len); b.write(s); return b;
}
function oscParse(buf) {
  const end = buf.indexOf(0);
  const address = buf.toString('utf8', 0, end);
  const rest = buf.subarray(Math.ceil((end + 1) / 4) * 4);
  const tEnd = rest.indexOf(0);
  const tags = rest.toString('utf8', 1, tEnd);
  let off = Math.ceil((tEnd + 1) / 4) * 4;
  const args = [];
  for (const t of tags) {
    if (t === 'f') { args.push(rest.readFloatBE(off)); off += 4; }
    else if (t === 'i') { args.push(rest.readInt32BE(off)); off += 4; }
    else if (t === 's') {
      const e = rest.indexOf(0, off);
      args.push(rest.toString('utf8', off, e));
      off = Math.ceil((e + 1) / 4) * 4;
    }
  }
  return { address, args };
}

/* ---- test sequence ---- */
const sock = dgram.createSocket('udp4');
const addr = `/track/${track}/fx/${fx}/fxparam/${param}/value`;

sock.on('message', (msg) => {
  try {
    const { address, args } = oscParse(msg);
    if (address.includes('fxparam') || address.includes('fx')) {
      console.log(`  ← ${address} = ${args.map(a => typeof a === 'number' ? a.toFixed(3) : a).join(' ')}`);
    }
  } catch { /* ignore non-OSC */ }
});

sock.bind(REPLY_PORT, async () => {
  console.log(`Listening for REAPER feedback on :${REPLY_PORT}`);
  console.log(`Target: ${addr} @ ${ip}:${PORT}\n`);

  if (value !== undefined) {
    send(addr, parseFloat(value));
    console.log(`  → set ${value}`);
  } else {
    // Wiggle so it's visible on screen: 0 → 1 → 0.5
    for (const v of [0.0, 1.0, 0.5]) {
      send(addr, v);
      console.log(`  → set ${v.toFixed(1)}`);
      await sleep(800);
    }
  }
  // Ask for current state (REAPER replies to the device port if feedback enabled)
  send('/device/track/count', 1);
  await sleep(1500);
  console.log('\nIf the knob moved in REAPER: B0.2 core PASS.');
  console.log('Next: run list-fx-params.lua in REAPER to find Tune Real-Time\'s');
  console.log('key/scale parameter numbers, then re-run this script against them.');
  sock.close();
});

function send(address, v) {
  const b = oscMessage(address, v);
  sock.send(b, 0, b.length, PORT, ip);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
