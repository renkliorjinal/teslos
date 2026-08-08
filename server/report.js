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

  // GPS speed decides, not <video> pausing. Inferring motion from the lockout
  // is circular — the lockout is the thing being measured — and if it has been
  // removed the inference labels every sample Park and hides the result.
  const label = (r) => {
    const speed = r.live && r.live.speedKmh;
    if (typeof speed === 'number') return speed > 5 ? 'DRIVE' : 'PARK';
    const paused = r.live && r.live.videoPaused;
    if (paused === true) return 'DRIVE';
    if (paused === false) return 'PARK?';
    return '?';
  };

  // Automatic reporting produces a pile of samples, most of them from whichever
  // state lasted longest. Comparing the two newest would usually put two Park
  // samples side by side, so pick the newest of each state instead.
  const loaded = reports.map((r) => ({ ...r, data: JSON.parse(fs.readFileSync(r.full, 'utf8')) }));
  let left = loaded.find((r) => label(r.data) === 'PARK');
  let right = loaded.find((r) => label(r.data) === 'DRIVE');

  if (!left || !right) {
    // Only one state present: fall back to the two newest so the numbers are
    // still visible, and let the verdict say what is missing.
    left = loaded[1];
    right = loaded[0];
  }

  const a = left.data;
  const b = right.data;

  const rows = [
    ['speed km/h', (r) => r.live?.speedKmh],
    ['max speed km/h', (r) => r.live?.maxSpeedKmh],
    ['canvas fps', (r) => r.live?.canvasFps],
    ['canvas frames', (r) => r.live?.canvasFrames],
    ['WebCodecs fps', (r) => r.live?.webcodecsFps],
    ['WebCodecs frames', (r) => r.live?.webcodecsFrames],
    ['WebCodecs codec', (r) => r.live?.webcodecsCodec],
    ['<video> paused', (r) => r.live?.videoPaused],
    ['<video> drawable', (r) => r.live?.videoDrawable],
    ['AudioContext', (r) => r.live?.audioContextState],
    ['audio clock moving', (r) => r.live?.audioClockAdvancing],
    ['<audio> playing', (r) => r.live?.audioElementPlaying],
    ['<audio> advancing', (r) => r.live?.audioElementAdvancing],
    ['link Mbit/s', (r) => r.live?.linkMbps],
  ];

  const show = (v) => (v === undefined || v === null ? '—' : String(v));

  console.log(`\n${BOLD}${left.file}${OFF}  ${DIM}(${label(a)})${OFF}`);
  console.log(`${BOLD}${right.file}${OFF}  ${DIM}(${label(b)})${OFF}\n`);
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
    const anySpeed = [a, b].some((r) => typeof r.live?.speedKmh === 'number');
    if (anySpeed) {
      console.log(`  ${YELLOW}No sample was taken above 5 km/h — both were stationary.${OFF}`);
    } else {
      console.log(`  ${YELLOW}No speed in either sample, so motion cannot be confirmed.${OFF}`);
      console.log(`  ${DIM}Allow the location prompt on the probe page; without it the${OFF}`);
      console.log(`  ${DIM}only remaining hint is <video> pausing, which is what we are testing.${OFF}`);
    }
    return;
  }

  // The headline result. If the car was genuinely moving and <video> never
  // paused, the restriction this whole project routes around is not present on
  // this firmware — which would make the workaround unnecessary rather than
  // merely improvable.
  if (driveReport.live?.videoPaused === false) {
    console.log(`  ${GREEN}At ${driveReport.live.speedKmh} km/h <video> was still playing.${OFF}`);
    console.log(`  ${GREEN}The Drive lockout appears to be gone on this firmware.${OFF}`);
    console.log(`  ${DIM}Worth testing plain video playback before keeping any of the workaround.${OFF}`);
  }

  const fps = Number(driveReport.live?.canvasFps) || 0;
  if (fps >= 24) {
    console.log(`  ${GREEN}Canvas kept painting at ${fps} fps in Drive. The whole approach holds.${OFF}`);
  } else if (fps > 0) {
    console.log(`  ${YELLOW}Canvas only managed ${fps} fps in Drive — throttled but alive.${OFF}`);
  } else {
    console.log(`  ${RED}Canvas froze in Drive. This transport cannot work.${OFF}`);
  }

  const wcFps = Number(driveReport.live?.webcodecsFps) || 0;
  const wcFrames = Number(driveReport.live?.webcodecsFrames) || 0;
  if (wcFrames > 0 && wcFps > 0) {
    console.log(`  ${GREEN}WebCodecs also kept decoding in Drive (${wcFps} fps, ${driveReport.live.webcodecsCodec}).${OFF}`);
    console.log(`  ${DIM}The lockout does not reach it. Switch the transport to H.264.${OFF}`);
  } else if (driveReport.live?.webcodecsSupported) {
    console.log(`  ${YELLOW}WebCodecs stopped decoding in Drive — stay on the MPEG1 path.${OFF}`);
  }

  // "running" on its own is not proof: a context can report running while its
  // clock has stopped. The clock is the honest signal.
  const ac = driveReport.live?.audioContextState;
  const acMoving = driveReport.live?.audioClockAdvancing;
  if (ac === 'running' && acMoving !== false) {
    console.log(`  ${GREEN}WebAudio survived Drive — keep the muxed audio path.${OFF}`);
  } else if (ac === 'running' && acMoving === false) {
    console.log(`  ${YELLOW}AudioContext claims "running" but its clock froze in Drive — use the <audio> fallback.${OFF}`);
  } else if (ac) {
    console.log(`  ${YELLOW}AudioContext was "${ac}" in Drive — the player will use the <audio> fallback.${OFF}`);
  }

  if (driveReport.live?.audioElementAdvancing === false) {
    console.log(`  ${RED}The <audio> element also stopped in Drive — no audio path survives.${OFF}`);
  } else if (driveReport.live?.audioElementAdvancing) {
    console.log(`  ${GREEN}The <audio> fallback kept playing in Drive.${OFF}`);
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
line('Speed at report time', typeof live.speedKmh === 'number'
  ? `${live.speedKmh} km/h  ${DIM}(max ${live.maxSpeedKmh ?? '?'}, ${live.speedSource || '?'})${OFF}`
  : `${YELLOW}${live.geolocation || 'not measured'}${OFF}`);
line('Canvas frames / fps', `${live.canvasFrames ?? '?'} @ ${live.canvasFps ?? '?'} fps`);
line('<video> paused', live.videoPaused === undefined ? '?' : String(live.videoPaused));
line('<video> drawable', live.videoDrawable === undefined ? '?' : String(live.videoDrawable));
line('WebCodecs decode', live.webcodecsSupported === false
  ? 'no VideoDecoder'
  : live.webcodecsFrames
    ? `${live.webcodecsFrames} frames @ ${live.webcodecsFps ?? '?'} fps  ${DIM}${live.webcodecsCodec || ''}${OFF}`
    : live.webcodecsState || 'not tested');
const clock = (moving) => (moving === undefined || moving === null ? '' : moving ? ' · clock advancing' : ` ${RED}· clock frozen${OFF}`);
line('AudioContext', (live.audioContextState || 'not tested') + clock(live.audioClockAdvancing));
line('<audio> element', (live.audioElementPlaying === undefined ? 'not tested' : String(live.audioElementPlaying))
  + clock(live.audioElementAdvancing));
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
// An API that exists is not an API that works, so prefer the decode result
// over the feature-detection flag whenever the probe actually ran one.
if (live.webcodecsFrames > 0) {
  const codec = live.webcodecsCodec || 'unknown codec';
  console.log(`  ${GREEN}WebCodecs really decoded ${live.webcodecsFrames} frames of ${codec}.${OFF}`);
  if (/^avc1/.test(codec)) {
    console.log(`  ${GREEN}H.264 decoding works — worth rebuilding the transport around it.${OFF}`);
    console.log(`  ${DIM}It beats MPEG1 badly at the same bitrate and costs the server far less.${OFF}`);
  }
} else if (apis['WebCodecs VideoDecoder']) {
  console.log(`  ${YELLOW}VideoDecoder exists but decoded nothing${live.webcodecsError ? `: ${live.webcodecsError}` : ' in this report'}.${OFF}`);
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
