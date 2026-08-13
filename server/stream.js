'use strict';

const { spawn } = require('child_process');
const config = require('./config');
const youtube = require('./youtube');

// One ffmpeg process per viewer, so this is the backpressure valve.
//
// Slots are reserved before yt-dlp is asked to resolve, not when ffmpeg finally
// starts. Resolving takes seconds, and counting only at spawn let every request
// that arrived during that window pass the capacity check and then all start at
// once — which on a one-core box is precisely the stutter the limit exists to
// prevent.
const live = new Set();
let reserved = 0;

function sessionCount() {
  return live.size + reserved;
}

function atCapacity() {
  return sessionCount() >= config.maxSessions;
}

function reserveSlot() {
  reserved += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    reserved = Math.max(0, reserved - 1);
  };
}

// A stream that has produced nothing for this long is not coming back: the CDN
// dropped it, or the client vanished without the socket closing. Left alone it
// holds a slot and, worse, a share of the CPU.
const IDLE_LIMIT_MS = 30000;

setInterval(() => {
  const now = Date.now();
  for (const session of live) {
    if (now - session.lastOutput < IDLE_LIMIT_MS) continue;
    console.warn(`[ffmpeg] ${session.label} produced nothing for 30s, killing it`);
    session.stop();
  }
}, 5000).unref();

// HTTP inputs from YouTube's CDN drop often enough that reconnects are not
// optional. These flags are per-input and must precede the -i they apply to.
// They belong to ffmpeg's http protocol, so a non-HTTP input would be rejected
// outright with "Option reconnect not found".
function inputArgs(url, startTime) {
  const args = [];
  if (/^https?:/i.test(url)) {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '10',
    );
    // YouTube binds a media URL to the address that resolved it, so the fetch
    // has to leave by the same door or the CDN answers 403.
    if (config.proxyMedia && config.proxyUsableByFfmpeg) {
      args.push('-http_proxy', config.proxy);
    }
  }
  // Input-side seek: ffmpeg issues a ranged request instead of decoding and
  // discarding everything before startTime.
  if (startTime > 0) args.push('-ss', String(startTime));
  args.push('-i', url);
  return args;
}

/**
 * MPEG1 video (+ optional MP2 audio) in an MPEG-TS container on stdout.
 *
 * The whole point of this format is that JSMpeg can decode it in plain JS and
 * paint it into a <canvas>. Tesla's Drive-mode lockout pauses <video> elements
 * at the OS level, and a paused element also poisons drawImage(), so the pixels
 * have to reach the page without ever touching one.
 *
 * JSMpeg's MPEG1 decoder cannot handle B-frames, hence -bf 0.
 */
async function startVideoStream({ videoId, quality, startTime = 0, withAudio = true }) {
  const releaseSlot = reserveSlot();
  try {
    const preset = config.QUALITY[quality] || config.QUALITY[config.DEFAULT_QUALITY];
    const streams = await youtube.resolveStreams(videoId, quality);

    const args = ['-hide_banner', '-loglevel', 'error', '-re'];
    args.push(...inputArgs(streams.video, startTime));

    // DASH gives video and audio as separate URLs; progressive gives one muxed
    // file. Only add a second input when there really is one.
    const separateAudio = withAudio && Boolean(streams.audio);
    if (separateAudio) args.push(...inputArgs(streams.audio, startTime));

    args.push('-map', '0:v:0');
    if (withAudio) args.push('-map', separateAudio ? '1:a:0' : '0:a:0?');

    args.push(
      '-c:v', 'mpeg1video',
      '-b:v', preset.videoBitrate,
      '-maxrate', preset.videoBitrate,
      '-bufsize', preset.videoBitrate,
      '-bf', '0',
      // One intra frame per second, so a fresh connection paints within ~1s.
      '-g', '30',
      '-vf', `fps=30,scale=${preset.scale}`,
    );

    if (withAudio) {
      args.push('-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2');
    }

    args.push(
      '-f', 'mpegts',
      '-muxdelay', '0.001',
      '-muxpreload', '0',
      '-',
    );

    return spawnFfmpeg(args, `video ${videoId}@${quality}p t=${startTime}`);
  } finally {
    releaseSlot();
  }
}

/**
 * Fragmented MP4 on stdout, remuxed rather than re-encoded.
 *
 * Copying YouTube's existing H.264 into a container costs the server almost
 * nothing and hands the car full quality with hardware decoding — but it feeds
 * a <video> element, whose frames Tesla stops presenting once the car moves.
 * Parked only; the canvas path is what survives Drive.
 *
 * The fragmenting flags matter: a normal MP4 puts its index at the end, which
 * a pipe can never reach, so the browser would wait forever before painting.
 */
async function startDirectStream({ videoId, quality, startTime = 0 }) {
  const releaseSlot = reserveSlot();
  try {
    // Copying is free but only legal when YouTube already has an H.264 rendition
    // at this height. When it does not, transcoding is the honest cost of still
    // handing the car something it can decode.
    let streams;
    let copyable = true;
    try {
      streams = await youtube.resolveStreams(videoId, quality, { requireAvc: true });
    } catch (err) {
      copyable = false;
      streams = await youtube.resolveStreams(videoId, quality);
      console.log(`[direct] ${videoId}: no H.264 at ${quality}p, transcoding instead`);
    }

    const args = ['-hide_banner', '-loglevel', 'error'];
    args.push(...inputArgs(streams.video, startTime));
    if (streams.audio) args.push(...inputArgs(streams.audio, startTime));

    args.push('-map', '0:v:0');
    args.push('-map', streams.audio ? '1:a:0' : '0:a:0?');

    if (copyable) {
      args.push('-c', 'copy');
    } else {
      const preset = config.QUALITY[quality] || config.QUALITY[config.DEFAULT_QUALITY];
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
        '-b:v', preset.videoBitrate, '-maxrate', preset.videoBitrate,
        '-bufsize', preset.videoBitrate, '-pix_fmt', 'yuv420p',
        '-vf', `scale=${preset.scale}`,
        '-c:a', 'aac', '-b:a', '128k',
      );
    }

    args.push(
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      // A source with a long GOP would otherwise emit one huge fragment at a
      // time, and nothing paints until each is complete.
      '-frag_duration', '1000000',
      '-f', 'mp4',
      '-',
    );

    return spawnFfmpeg(args, `direct ${videoId}@${quality}p t=${startTime} ${copyable ? 'copy' : 'transcode'}`);
  } finally {
    releaseSlot();
  }
}

/**
 * MP3 on stdout for the fallback audio path.
 *
 * Muxed MP2 decoded by JSMpeg into WebAudio keeps perfect A/V sync, but if
 * WebAudio turns out to be suppressed in Drive on a given firmware, a plain
 * <audio> element is the known-good escape hatch — Tesla does not gate those.
 */
async function startAudioStream({ videoId, startTime = 0 }) {
  const releaseSlot = reserveSlot();
  try {
    const streams = await youtube.resolveStreams(videoId, 480);
    const url = streams.audio || streams.video;

    const args = ['-hide_banner', '-loglevel', 'error', '-re'];
    args.push(...inputArgs(url, startTime));
    args.push(
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '96k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'mp3',
      '-',
    );

    return spawnFfmpeg(args, `audio ${videoId} t=${startTime}`);
  } finally {
    releaseSlot();
  }
}

function spawnFfmpeg(args, label) {
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const session = {
    proc,
    stdout: proc.stdout,
    label,
    lastOutput: Date.now(),
    stop() {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      release();
    },
  };

  live.add(session);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    live.delete(session);
    console.log(`[ffmpeg] stopped ${label} — ${sessionCount()}/${config.maxSessions} in use`);
  };

  // Doubles as the liveness signal the reaper reads.
  proc.stdout.on('data', () => { session.lastOutput = Date.now(); });

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    // Keep only the tail; a stuck stream can otherwise log for hours.
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  proc.on('close', (code, signal) => {
    release();
    if (code !== 0 && !signal) {
      console.error(`[ffmpeg] ${label} exited ${code}: ${stderrTail.trim().split('\n').slice(-2).join(' ')}`);
    }
  });

  proc.on('error', (err) => {
    release();
    console.error(`[ffmpeg] ${label} failed to start: ${err.message}`);
  });

  console.log(`[ffmpeg] started ${label} — ${sessionCount()}/${config.maxSessions} in use`);
  return session;
}

module.exports = { startVideoStream, startDirectStream, startAudioStream, sessionCount, atCapacity };
