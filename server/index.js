'use strict';

const http = require('http');
const url = require('url');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const routes = require('./routes');
const youtube = require('./youtube');
const stream = require('./stream');

const app = express();

app.disable('x-powered-by');

// The player is the point of the site, and typing a path on a car touchscreen
// is a chore. The bare hostname opens it.
app.get('/', (req, res) => {
  res.sendFile(path.join(config.publicDir, 'player', 'index.html'));
});

app.use(express.static(config.publicDir, { extensions: ['html'] }));
app.use('/api', routes);

const server = http.createServer(app);

// The video socket carries binary MPEG-TS and nothing else. JSMpeg's WebSocket
// source hands every frame straight to its demuxer, so a stray JSON text frame
// would corrupt the stream. Control and error reporting therefore travel over
// HTTP beforehand, or as a close code afterwards.
const CLOSE_BAD_REQUEST = 4003;
const CLOSE_AT_CAPACITY = 4001;
const CLOSE_RESOLVE_FAILED = 4002;
// Resolved fine, started fine, produced nothing. Distinguished from a dropped
// link because the player's response to the two is opposite: retry the one,
// explain the other. Conflating them is how a driver ends up watching an
// attempt counter climb with no idea what is wrong.
const CLOSE_STREAM_FAILED = 4004;

// A close reason is capped at 123 bytes on the wire and Turkish spends two on
// every accented character, so this cuts by bytes rather than characters — over
// the cap, ws throws and the client learns nothing at all.
function closeReason(text) {
  const buf = Buffer.from(String(text || ''), 'utf8');
  if (buf.length <= 117) return buf.toString('utf8');
  return `${buf.subarray(0, 117).toString('utf8').replace(/�+$/, '')}…`;
}

const wss = new WebSocketServer({ noServer: true });
const speedWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url);
  const target = pathname === '/ws/video' ? wss : pathname === '/ws/speedtest' ? speedWss : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

// Saturates the link with incompressible data for a few seconds so the probe
// can report what the car's connection actually sustains. Choosing a quality
// preset is guesswork without this number.
speedWss.on('connection', (ws) => {
  const CHUNK = Buffer.allocUnsafe(64 * 1024);
  for (let i = 0; i < CHUNK.length; i += 4) CHUNK.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);

  const deadline = Date.now() + 6000;
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN || Date.now() > deadline) {
      clearInterval(timer);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'Test bitti');
      return;
    }
    // Keep a shallow queue so the measurement reflects the link, not our buffer.
    while (ws.bufferedAmount < 512 * 1024) ws.send(CHUNK);
  }, 20);

  ws.on('close', () => clearInterval(timer));
  ws.on('error', () => clearInterval(timer));
});

wss.on('connection', async (ws, req) => {
  const query = url.parse(req.url, true).query;

  const videoId = youtube.parseVideoId(query.v);
  if (!videoId) {
    ws.close(CLOSE_BAD_REQUEST, 'Gecersiz video kimligi');
    return;
  }
  if (stream.atCapacity()) {
    ws.close(CLOSE_AT_CAPACITY, 'Sunucu kapasitesi dolu');
    return;
  }

  const quality = config.resolveQuality(query.q);
  const startTime = Math.max(0, Number(query.t) || 0);
  // audio=0 means the client drives a separate <audio> element instead, so the
  // transcode should not waste cycles on an MP2 track nobody decodes.
  const withAudio = query.audio !== '0';

  let session = null;
  let closed = false;

  ws.on('close', () => {
    closed = true;
    if (session) session.stop();
  });
  ws.on('error', () => {
    closed = true;
    if (session) session.stop();
  });

  try {
    session = await stream.startVideoStream({ videoId, quality, startTime, withAudio });
  } catch (err) {
    if (!closed) ws.close(CLOSE_RESOLVE_FAILED, closeReason(err.message));
    return;
  }

  // The client may have given up while yt-dlp was resolving.
  if (closed) {
    session.stop();
    return;
  }

  // Backpressure by pausing the source, not by discarding from the middle of
  // it. A transport stream with a hole in it does not resynchronise cleanly —
  // the decoder carries the damage to the next intra frame — and on a jittery
  // link that is a permanent stutter rather than a brief glitch.
  //
  // Two things can ask for a pause, and both are necessary.
  //
  // The socket queue is the obvious one: the link cannot take it. The client's
  // own buffer is the one that is easy to miss. ffmpeg deliberately sends faster
  // than real time so a cushion exists to absorb hiccups, but the client only
  // consumes at 1x — its decoder is paced by the soundtrack. That surplus has to
  // stop somewhere, and left alone it accumulates until the decoder's ring
  // buffer overflows, at which point it evicts frames it has not shown yet. The
  // picture then silently jumps ahead of the sound, which looks like the audio
  // being late rather than like the buffer overrunning.
  //
  // So the client reports how many seconds it is holding, and the server stops
  // sending once that is comfortable. The over-rate then only applies while
  // there is room for it.
  const HIGH_WATER = 2 * 1024 * 1024;
  const LOW_WATER = 512 * 1024;
  const BUFFER_FULL_S = 12;
  const BUFFER_HUNGRY_S = 6;
  // The decoder's ring buffer as a fraction of capacity, which is the quantity
  // that actually decides whether frames get evicted. Preferred over the
  // seconds estimate whenever the client can produce it, since it needs no
  // agreement about what the bitrate is.
  const RING_FULL = 0.6;
  const RING_HUNGRY = 0.35;
  // A second, independent ceiling, measured from this end alone: how far the
  // bytes written have run ahead of the wall clock. The client's report is the
  // better signal when it arrives, but a page cached from before it existed
  // never sends one, and being wrong about that means overrunning its buffer.
  const LEAD_CAP_S = 18;
  const LEAD_RESUME_S = 12;

  const preset = config.QUALITY[quality] || config.QUALITY[config.DEFAULT_QUALITY];
  const byteRate = ((parseInt(preset.videoBitrate, 10) * 1000)
    + (withAudio ? 128000 : 0)) * 1.06 / 8;
  const startedAt = Date.now();
  let sentBytes = 0;

  const lead = () => (sentBytes / byteRate) - ((Date.now() - startedAt) / 1000);

  let clientBuffer = 0;
  let clientBufferAt = 0;
  let clientFill = -1;
  let clientFillAt = 0;
  let holdTimer = null;

  // A report that has stopped arriving cannot be acted on. A page from before
  // this existed never sends one at all, and a live one that has crashed or been
  // backgrounded is no better informed — either way, holding the stream shut on
  // a stale number would stall playback with no way out.
  const reportedBuffer = () =>
    (Date.now() - clientBufferAt < 4000 ? clientBuffer : 0);
  const reportedFill = () =>
    (Date.now() - clientFillAt < 4000 ? clientFill : -1);

  // The video socket is binary in one direction only; anything the client sends
  // is control, and anything unparseable is ignored rather than trusted.
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && typeof msg.buf === 'number' && isFinite(msg.buf)) {
      clientBuffer = Math.max(0, msg.buf);
      clientBufferAt = Date.now();
    }
    if (msg && typeof msg.fill === 'number' && isFinite(msg.fill)) {
      clientFill = Math.min(1, Math.max(0, msg.fill));
      clientFillAt = Date.now();
    }
  });

  const shouldHold = () => ws.bufferedAmount > HIGH_WATER
    || reportedFill() > RING_FULL
    || reportedBuffer() > BUFFER_FULL_S
    || lead() > LEAD_CAP_S;
  const mayResume = () => ws.bufferedAmount < LOW_WATER
    && reportedFill() < RING_HUNGRY
    && reportedBuffer() < BUFFER_HUNGRY_S
    && lead() < LEAD_RESUME_S;

  session.stdout.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk);
    sentBytes += chunk.length;

    if (shouldHold() && !holdTimer) {
      session.stdout.pause();
      holdTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          clearInterval(holdTimer);
          holdTimer = null;
          return;
        }
        if (mayResume()) {
          clearInterval(holdTimer);
          holdTimer = null;
          session.stdout.resume();
        }
      }, 100);
    }
  });

  ws.on('close', () => {
    if (holdTimer) clearInterval(holdTimer);
  });

  session.proc.on('close', () => {
    if (ws.readyState !== ws.OPEN) return;
    // spawnFfmpeg sets this only when not a single byte came out, which is never
    // a link problem and never worth retrying blind.
    if (session.failure) ws.close(CLOSE_STREAM_FAILED, closeReason(session.failure));
    else ws.close(1000, 'Akis bitti');
  });
});

server.listen(config.port, config.bind, () => {
  console.log(`teslos listening on http://${config.bind}:${config.port}`);
  console.log(`  running: ${config.revision}`);
  console.log(`  static: ${config.publicDir}`);
  console.log(`  ffmpeg: ${config.ffmpeg}   yt-dlp: ${config.ytDlp}`);
  console.log(`  max concurrent sessions: ${config.maxSessions}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    wss.clients.forEach((ws) => ws.close(1001, 'Sunucu kapaniyor'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
