'use strict';

const http = require('http');
const url = require('url');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const routes = require('./routes');
const youtube = require('./youtube');
const stream = require('./stream');

const app = express();

app.disable('x-powered-by');
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
    if (!closed) ws.close(CLOSE_RESOLVE_FAILED, err.message.slice(0, 100));
    return;
  }

  // The client may have given up while yt-dlp was resolving.
  if (closed) {
    session.stop();
    return;
  }

  session.stdout.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    // Drop rather than queue when the car's link falls behind. An unbounded
    // send buffer would show up as ever-growing latency instead of a brief
    // glitch, and MPEG1 recovers on the next intra frame a second later.
    if (ws.bufferedAmount > 4 * 1024 * 1024) return;
    ws.send(chunk);
  });

  session.proc.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close(1000, 'Akis bitti');
  });
});

server.listen(config.port, config.bind, () => {
  console.log(`teslos listening on http://${config.bind}:${config.port}`);
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
