// run-repeat-sweep.mjs — one-off diagnostic client for the certification-day
// repeatability test. Connects to the already-running wing-brain server and
// requests N back-to-back sweeps on one physical output at the fixed verify
// position (see session.js's repeatSweep()). Not part of the phone UI --
// this exists so a terminal-driven session can trigger/log it directly.
//
// Usage: node scripts/run-repeat-sweep.mjs [physicalOutputId] [count]
import WebSocket from 'ws';

const physicalOutputId = process.argv[2] || 'main_l_out';
const count = Number(process.argv[3] || 5);

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log(`Connected. Requesting ${count} sweeps on "${physicalOutputId}"...`);
  ws.send(JSON.stringify({ action: 'repeat_sweep', physicalOutputId, count }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.event === 'info') console.log('[info]', msg.payload.message);
  else if (msg.event === 'warning') console.log('[WARNING]', msg.payload.message);
  else if (msg.event === 'error') { console.log('[ERROR]', msg.payload.message); process.exit(1); }
  else if (msg.event === 'measuring') console.log('[measuring]', msg.payload.output, '@', msg.payload.position);
  else if (msg.event === 'repeatSweepResult') {
    console.log('\n=== RESULTS ===');
    msg.payload.runs.forEach((r, i) => {
      console.log(`Run ${i + 1}: delay=${r.delayMs.toFixed(2)}ms  confidence=${r.confidence}  level=${r.levelDbfs}dBFS  snr=${r.snrDb}dB  polarity=${r.polarity}  clipped=${r.clipped}`);
    });
    const delays = msg.payload.runs.map((r) => r.delayMs);
    const min = Math.min(...delays), max = Math.max(...delays);
    console.log(`\nSpread: ${(max - min).toFixed(2)}ms (min ${min.toFixed(2)}, max ${max.toFixed(2)})`);
    console.log(`PASS threshold: within ~2ms of each other -> ${(max - min) <= 2 ? 'PASS' : 'FAIL/MARGINAL'}`);
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => { console.error('WS error:', err.message); process.exit(1); });

setTimeout(() => { console.error('Timed out waiting for result (60s)'); process.exit(1); }, 60000);
