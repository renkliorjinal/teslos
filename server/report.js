'use strict';

// Turns a probe report into the decisions it implies. The raw JSON is a wall
// of booleans; what actually matters is three questions — can the canvas path
// work, which audio path to use, and which quality preset the link sustains.
//
//   npm run report        newest report
//   npm run report -- 2   second newest
//   npm run report -- all list them

const fs = require('fs');
const path = require('path');
const config = require('./config');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function listReports() {
  if (!fs.existsSync(config.reportsDir)) return [];
  return fs
    .readdirSync(config.reportsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, full: path.join(config.reportsDir, f) }))
    .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
}

const reports = listReports();
if (reports.length === 0) {
  console.log(`\nNo reports in ${config.reportsDir}.`);
  console.log('Open /probe/ in the car and press the report button.\n');
  process.exit(1);
}

const arg = process.argv[2];
if (arg === 'all') {
  console.log('');
  reports.forEach((r, i) => console.log(`  ${i + 1}. ${r.file}`));
  console.log('');
  process.exit(0);
}

if (arg === 'diff') {
  compare();
  process.exit(0);
}

// Park versus Drive is the entire experiment, and the answer is a handful of
// values changing (or not) between two reports. Reading that off two separate
// dumps is needless work.
function compare() {
  if (reports.length < 2) {
    console.log('\nNeed two reports to compare. Take one parked and one moving.\n');
    return;
  }

  const b = JSON.parse(fs.readFileSync(reports[0].full, 'utf8'));
  const a = JSON.parse(fs.readFileSync(reports[1].full, 'utf8'));

  // Tesla only pauses <video> once the car is out of Park, which makes it a
  // reliable label for which report is which.
  const label = (r) => {
    const paused = r.live && r.live.videoPaused;
    if (paused === true) return 'DRIVE';
    if (paused === false) return 'PARK';
    return '?';
  };

  const rows = [
    ['canvas fps', (r) => r.live?.canvasFps],
    ['canvas frames', (r) => r.live?.canvasFrames],
    ['<video> paused', (r) => r.live?.videoPaused],
    ['<video> drawable', (r) => r.live?.videoDrawable],
    ['AudioContext', (r) => r.live?.audioContextState],
    ['<audio> playing', (r) => r.live?.audioElementPlaying],
    ['link Mbit/s', (r) => r.live?.linkMbps],
  ];

  const show = (v) => (v === undefined || v === null ? '—' : String(v));

  console.log(`\n${BOLD}${reports[1].file}${OFF}  ${DIM}(${label(a)})${OFF}`);
  console.log(`${BOLD}${reports[0].file}${OFF}  ${DIM}(${label(b)})${OFF}\n`);
  console.log(`  ${''.padEnd(22)}${label(a).padEnd(16)}${label(b)}`);
  console.log(`  ${'-'.repeat(52)}`);

  rows.forEach(([name, get]) => {
    const va = show(get(a));
    const vb = show(get(b));
    const changed = va !== vb;
    const colour = changed ? YELLOW : DIM;
    console.log(`  ${name.padEnd(22)}${colour}${va.padEnd(16)}${vb}${OFF}`);
  });

  console.log(`\n${BOLD}Verdict${OFF}`);

  const driveReport = label(b) === 'DRIVE' ? b : label(a) === 'DRIVE' ? a : null;
  if (!driveReport) {
    console.log(`  ${YELLOW}Neither report was taken in Drive — <video> was playing in both.${OFF}`);
    console.log(`  ${DIM}The lockout only engages once the car leaves Park.${OFF}`);
    return;
  }

  const fps = Number(driveReport.live?.canvasFps) || 0;
  if (fps >= 24) {
    console.log(`  ${GREEN}Canvas kept painting at ${fps} fps in Drive. The whole approach holds.${OFF}`);
  } else if (fps > 0) {
    console.log(`  ${YELLOW}Canvas only managed ${fps} fps in Drive — throttled but alive.${OFF}`);
  } else {
    console.log(`  ${RED}Canvas froze in Drive. This transport cannot work.${OFF}`);
  }

  const ac = driveReport.live?.audioContextState;
  if (ac === 'running') {
    console.log(`  ${GREEN}WebAudio survived Drive — keep the muxed audio path.${OFF}`);
  } else if (ac) {
    console.log(`  ${YELLOW}AudioContext was "${ac}" in Drive — the player will use the <audio> fallback.${OFF}`);
  }

  if (driveReport.live?.videoDrawable === false) {
    console.log(`  ${DIM}<video> stayed unreadable, as expected. Nothing here depends on it.${OFF}`);
  }
  console.log('');
}

const index = Math.max(1, Number(arg) || 1) - 1;
const chosen = reports[Math.min(index, reports.length - 1)];
const data = JSON.parse(fs.readFileSync(chosen.full, 'utf8'));

const sys = data.system || {};
const apis = data.apis || {};
const live = data.live || {};

function mark(value) {
  return value ? `${GREEN}yes${OFF}` : `${RED}no${OFF}`;
}

function line(label, value) {
  console.log(`  ${label.padEnd(30)}${value}`);
}

console.log(`\n${BOLD}${chosen.file}${OFF}  ${DIM}${data.generatedAt || ''}${OFF}\n`);

console.log(`${BOLD}Browser${OFF}`);
line('Tesla browser', sys.teslaDetected
  ? `${GREEN}yes${OFF} ${DIM}(via ${sys.teslaDetectedVia || 'user-agent'})${OFF}`
  : `${YELLOW}no — measured elsewhere${OFF}`);
line('Chromium', sys.chromium || '?');
line('QtWebEngine', sys.qtWebEngine || 'not reported');
line('Viewport', `${sys.viewport || '?'}  (screen ${sys.screen || '?'})`);
line('Cores / RAM', `${sys.cores || '?'} / ${sys.deviceMemoryGB || '?'} GB`);
if (data.webgl) line('GPU', String(data.webgl.renderer || '?').slice(0, 60));

console.log(`\n${BOLD}What the transport needs${OFF}`);
// Only the first two are load-bearing. JSMpeg drops to a Canvas2D renderer
// without WebGL and to a JS decoder without WebAssembly — both slower, neither
// fatal — and WebAudio only decides which of the two audio paths is used.
const REQUIRED = ['WebSocket', 'Canvas 2D'];
const PREFERRED = ['WebGL', 'WebAssembly', 'AudioContext'];
REQUIRED.forEach((k) => line(k, `${mark(apis[k])} ${DIM}required${OFF}`));
PREFERRED.forEach((k) => line(k, `${mark(apis[k])} ${DIM}preferred${OFF}`));

console.log(`\n${BOLD}Worth knowing${OFF}`);
['WebCodecs VideoDecoder', 'RTCPeerConnection', 'getUserMedia', 'MediaSource'].forEach((k) => {
  if (k in apis) line(k, mark(apis[k]));
});

console.log(`\n${BOLD}Live measurements${OFF}`);
line('Canvas frames / fps', `${live.canvasFrames ?? '?'} @ ${live.canvasFps ?? '?'} fps`);
line('<video> paused', live.videoPaused === undefined ? '?' : String(live.videoPaused));
line('<video> drawable', live.videoDrawable === undefined ? '?' : String(live.videoDrawable));
line('AudioContext', live.audioContextState || 'not tested');
line('<audio> element', live.audioElementPlaying === undefined ? 'not tested' : String(live.audioElementPlaying));
line('Link speed', live.linkMbps ? `${live.linkMbps} Mbit/s — ${live.linkAdvice || ''}` : 'not tested');

// ---------------------------------------------------------------- verdict
console.log(`\n${BOLD}Verdict${OFF}`);

const missingRequired = REQUIRED.filter((k) => !apis[k]);
if (missingRequired.length) {
  console.log(`  ${RED}Canvas transport cannot work here — missing: ${missingRequired.join(', ')}${OFF}`);
} else {
  console.log(`  ${GREEN}Canvas transport is viable.${OFF}`);
  if (!apis.WebGL) {
    console.log(`  ${YELLOW}No WebGL — JSMpeg will use the Canvas2D renderer. Stay at 360p or 480p.${OFF}`);
  }
  if (!apis.WebAssembly) {
    console.log(`  ${YELLOW}No WebAssembly — the decoder runs as plain JS, which is markedly slower.${OFF}`);
  }
}

if (live.canvasFrames !== undefined) {
  const fps = Number(live.canvasFps) || 0;
  if (fps >= 24) console.log(`  ${GREEN}Canvas was still painting at ${fps} fps when the report was taken.${OFF}`);
  else if (fps > 0) console.log(`  ${YELLOW}Canvas only reached ${fps} fps — expect dropped frames.${OFF}`);
  else console.log(`  ${RED}Canvas was frozen when the report was taken.${OFF}`);
}

const acState = live.audioContextState;
if (!acState || acState === 'not tested') {
  console.log(`  ${YELLOW}WebAudio untested — run the tone test to confirm the muxed audio path.${OFF}`);
} else if (acState === 'running') {
  console.log(`  ${GREEN}WebAudio runs, so keep the muxed audio path (audio stays in sync).${OFF}`);
} else {
  console.log(`  ${YELLOW}AudioContext was "${acState}" — the player will fall back to a separate <audio> stream.${OFF}`);
}

// MPEG1 exists in this design only because it was the one codec decodable in
// plain JavaScript on the firmware the approach was built against. A browser
// new enough to expose WebCodecs can decode H.264 directly, which is worth
// far more than any tuning of the current pipeline.
if (apis['WebCodecs VideoDecoder']) {
  console.log(`  ${GREEN}WebCodecs is available — H.264 would beat MPEG1 badly at the same bitrate.${OFF}`);
  console.log(`  ${DIM}Worth rebuilding the transport around it.${OFF}`);
}
if (apis.RTCPeerConnection) {
  console.log(`  ${GREEN}WebRTC is available — a much simpler transport than MPEG1-over-WebSocket.${OFF}`);
}

const mbps = Number(live.linkMbps) || 0;
if (mbps > 0) {
  const preset = mbps >= 3.5 ? 1080 : mbps >= 2.2 ? 720 : mbps >= 1.4 ? 480 : 360;
  console.log(`  ${GREEN}Set DEFAULT_QUALITY=${preset} in .env for this link (${mbps} Mbit/s).${OFF}`);
  if (preset !== config.DEFAULT_QUALITY) {
    console.log(`  ${DIM}Currently ${config.DEFAULT_QUALITY}p.${OFF}`);
  }
} else {
  console.log(`  ${YELLOW}No speed measurement — run the link test to pick a quality preset.${OFF}`);
}

// The lockout only engages in Drive, so a report taken parked says nothing
// about it either way. Saying so beats implying the question was answered.
if (live.videoPaused === false) {
  console.log(`  ${DIM}<video> was playing, so this report was taken parked. The Drive-mode question is still open.${OFF}`);
} else if (live.videoPaused === true && live.videoDrawable === false) {
  console.log(`  ${GREEN}<video> was paused and unreadable — the lockout behaved as expected.${OFF}`);
}

console.log(`\n${DIM}${reports.length} report(s) stored. "npm run report -- all" to list.${OFF}\n`);
