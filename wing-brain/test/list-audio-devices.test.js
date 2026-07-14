// Tests for scripts/list-audio-devices.mjs's pure parsing/formatting logic.
// listAudioDevices() itself spawns a real powershell.exe process (WinMM
// P/Invoke) and is deliberately NOT exercised here -- same reasoning as
// scripts/smoke-settings.mjs being kept out of npm test: it talks to real
// OS state, not something a unit test should depend on.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseDeviceList, formatDeviceList } from '../scripts/list-audio-devices.mjs';

test('parseDeviceList splits IN/OUT lines into separate indexed lists', () => {
  const stdout = 'IN|0|Microphone (Realtek(R) Audio)\nOUT|0|Speakers\nOUT|1|Wing USB Audio\n';
  const { inputs, outputs } = parseDeviceList(stdout);
  assert.deepEqual(inputs, [{ index: 0, name: 'Microphone (Realtek(R) Audio)' }]);
  assert.deepEqual(outputs, [{ index: 0, name: 'Speakers' }, { index: 1, name: 'Wing USB Audio' }]);
});

test('parseDeviceList ignores blank lines and anything not matching the IN|/OUT| shape', () => {
  const stdout = '\n\nsome unrelated PowerShell noise\nIN|2|Line In\n';
  const { inputs, outputs } = parseDeviceList(stdout);
  assert.deepEqual(inputs, [{ index: 2, name: 'Line In' }]);
  assert.deepEqual(outputs, []);
});

test('parseDeviceList returns empty arrays for empty input (e.g. no devices found)', () => {
  assert.deepEqual(parseDeviceList(''), { inputs: [], outputs: [] });
});

test('formatDeviceList lists both sections with bracketed indices', () => {
  const table = formatDeviceList({
    inputs: [{ index: 0, name: 'Mic' }],
    outputs: [{ index: 0, name: 'Speakers' }]
  });
  assert.match(table, /\[0\] Mic/);
  assert.match(table, /\[0\] Speakers/);
});

test('formatDeviceList reports "(none found)" for an empty section instead of a blank list', () => {
  const table = formatDeviceList({ inputs: [], outputs: [] });
  assert.match(table, /INPUT devices: \(none found\)/);
  assert.match(table, /OUTPUT devices: \(none found\)/);
});
