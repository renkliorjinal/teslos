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
line('Tesla browser', sys.teslaDetected ? `${GREEN}yes${OFF}` : `${YELLOW}no — measured elsewhere${OFF}`);
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
