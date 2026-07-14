#!/usr/bin/env node
// list-audio-devices.mjs — enumerate Windows audio input/output devices, so
// a real device name (e.g. the Wing's built-in USB-C audio interface) can be
// found and dropped into config/default.json's audio.inputDevice/outputDevice
// before src/audio/io.js's live capture path can be implemented against it.
//
// Windows only (the mini PC's OS) -- uses WinMM's waveIn/waveOutGetDevCaps via
// a PowerShell P/Invoke helper, the same device enumeration sox's `waveaudio`
// driver sees. On other platforms this just prints where to look instead.
//
// Usage:
//   node scripts/list-audio-devices.mjs

import { spawn } from 'node:child_process';

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WaveDevices {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct WAVEINCAPS {
    public short wMid; public short wPid; public int vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public int dwFormats; public short wChannels; public short wReserved1;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct WAVEOUTCAPS {
    public short wMid; public short wPid; public int vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public int dwFormats; public short wChannels; public short wReserved1;
    public int dwSupport;
  }
  [DllImport("winmm.dll")] public static extern int waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Ansi)] public static extern int waveInGetDevCaps(IntPtr uDeviceID, ref WAVEINCAPS pwic, int cbwic);
  [DllImport("winmm.dll")] public static extern int waveOutGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Ansi)] public static extern int waveOutGetDevCaps(IntPtr uDeviceID, ref WAVEOUTCAPS pwoc, int cbwoc);
}
"@
$inCount = [WaveDevices]::waveInGetNumDevs()
for ($i = 0; $i -lt $inCount; $i++) {
  $caps = New-Object WaveDevices+WAVEINCAPS
  [WaveDevices]::waveInGetDevCaps([IntPtr]$i, [ref]$caps, [Runtime.InteropServices.Marshal]::SizeOf($caps)) | Out-Null
  Write-Output "IN|$i|$($caps.szPname)"
}
$outCount = [WaveDevices]::waveOutGetNumDevs()
for ($i = 0; $i -lt $outCount; $i++) {
  $caps = New-Object WaveDevices+WAVEOUTCAPS
  [WaveDevices]::waveOutGetDevCaps([IntPtr]$i, [ref]$caps, [Runtime.InteropServices.Marshal]::SizeOf($caps)) | Out-Null
  Write-Output "OUT|$i|$($caps.szPname)"
}
`;

/** Parse the PowerShell helper's "IN|0|Name" / "OUT|0|Name" lines into
 *  { inputs: [{index, name}], outputs: [{index, name}] }. Exported (pure
 *  function, no process spawning) so the parsing logic is unit-testable. */
export function parseDeviceList(stdout) {
  const inputs = [], outputs = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(IN|OUT)\|(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const entry = { index: Number(m[2]), name: m[3].trim() };
    (m[1] === 'IN' ? inputs : outputs).push(entry);
  }
  return { inputs, outputs };
}

export function formatDeviceList({ inputs, outputs }) {
  const section = (label, devices) => {
    if (!devices.length) return `${label}: (none found)`;
    return [`${label}:`, ...devices.map((d) => `  [${d.index}] ${d.name}`)].join('\n');
  };
  return [
    section('INPUT devices', inputs),
    section('OUTPUT devices', outputs),
    '',
    'Names may be truncated to 31 characters -- a Windows WinMM API limit,',
    'not a bug here. If two names look identical, the index is what matters.',
    '',
    'Once you spot the Wing (its USB-C audio interface, or "SoundGrid" once',
    'that card is installed), put its exact name in config/default.json:',
    '  audio.inputDevice / audio.outputDevice',
    'sox on Windows (the waveaudio driver) usually wants the NAME string, not',
    'the index -- confirm with a short manual recording test before trusting it.'
  ].join('\n');
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `powershell exited ${code}`))));
  });
}

export async function listAudioDevices() {
  if (process.platform !== 'win32') {
    return {
      inputs: [], outputs: [],
      table: `Not Windows (${process.platform}) -- this helper is WinMM-specific.\n` +
        `Try: arecord -l / aplay -l (Linux/ALSA), or system_profiler SPAudioDataType (macOS).`
    };
  }
  const stdout = await runPowerShell(PS_SCRIPT);
  const parsed = parseDeviceList(stdout);
  return { ...parsed, table: formatDeviceList(parsed) };
}

const isMain = process.argv[1] && process.argv[1].endsWith('list-audio-devices.mjs');
if (isMain) {
  listAudioDevices()
    .then(({ table }) => console.log(table))
    .catch((err) => { console.error(err); process.exit(1); });
}
