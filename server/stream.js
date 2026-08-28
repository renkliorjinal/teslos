'use strict';

const { spawn, execFileSync } = require('child_process');
const config = require('./config');
const youtube = require('./youtube');

// Pacing, which turns out to be the whole difference between a picture that
// holds together and one that has to be re-cut every few seconds.
//
// `-re` sends at exactly 1x and never faster. That leaves the client with no
// buffer at all: every network hiccup puts the picture permanently behind the
// soundtrack, because there is nothing queued to catch up with. A slight
// over-rate builds a cushion during the good stretches and spends it on the bad
// ones, which is what a moving car needs.
//
// It must stay slight. The client's decoder writes into a fixed ring buffer that
// evicts undecoded frames when it overflows, so a server racing ahead would
// throw away picture rather than store it.
//
// -readrate arrived in ffmpeg 5.1 and -readrate_initial_burst in 6.1, and the
// droplet's build is not ours to choose, so both are probed once rather than
// assumed.
// Both ends cap how far ahead this may get — the client reports its buffer and
// the server watches its own lead — so the rate can be high enough to refill a
// stall quickly rather than over the following minute.
const READ_RATE = process.env.READ_RATE || '1.5';
const INITIAL_BURST = process.env.READ_BURST || '8';

// `error` was too quiet to debug from a car. ffmpeg reports a refused fetch at
// warning level in several of its paths, so the one stream that mattered most
// died having said nothing at all, and the failure report could only pass on
// that it had been killed. Warnings are the whole diagnosis here and cost a few
// hundred bytes of a tail that is capped anyway.
const LOGLEVEL = process.env.FFMPEG_LOGLEVEL || 'warning';

let pacing = null;
let helpText = null;

// One `-h full` for the whole process. Both the pacing flags and the http
// reconnect options are read out of it, and it is not cheap enough to run twice.
function ffmpegHelp() {
  if (helpText !== null) return helpText;
  try {
    helpText = execFileSync(config.ffmpeg, ['-hide_banner', '-h', 'full'],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    helpText = '';
  }
  return helpText;
}

function pacingArgs() {
  if (pacing) return pacing;

  const help = ffmpegHelp();

  if (help.includes('-readrate ')) {
    pacing = ['-readrate', READ_RATE];
    if (help.includes('-readrate_initial_burst ')) {
      // Fills the client's buffer at once instead of over the first minute, so
      // the protection is there before the first hiccup rather than after it.
      pacing.push('-readrate_initial_burst', INITIAL_BURST);
    }
    console.log(`[ffmpeg] pacing with ${pacing.join(' ')}`);
  } else {
    pacing = ['-re'];
    console.log('[ffmpeg] no -readrate in this build; pacing with -re (no buffer cushion)');
  }
  return pacing;
}

// One ffmpeg process per viewer, so this is the backpressure valve.
//
// Slots are reserved before yt-dlp is asked to resolve, not when ffmpeg finally
// starts. Resolving takes seconds, and counting only at spawn let every request
// that arrived during that window pass the capacity check and then all start at
// once — which on a one-core box is precisely the stutter the limit exists to
// prevent.
// Two pools. The audio companion is a 96 kbit MP3 transcode beside a full
// video encode, so charging it to the same budget lets a viewer be refused
// their own soundtrack.
const live = new Set();
const liveAudio = new Set();
let reserved = 0;

function sessionCount() {
  return live.size + reserved;
}

function atCapacity() {
  return sessionCount() >= config.maxSessions;
}

// One spare over the video budget: correcting drift restarts the audio stream,
// and the replacement briefly overlaps the one it replaces.
function audioAtCapacity() {
  return liveAudio.size >= config.maxSessions + 1;
}

/**
 * Room for one more soundtrack, made by retiring the oldest if it comes to it.
 *
 * Refusing was the wrong answer. This is one car with one driver, and a new
 * audio request always supersedes whatever came before it — a restart, a seek,
 * a reconnect after the CDN refused a client. The stream being retired is by
 * definition the one nobody is listening to.
 *
 * It came up the moment playback started working again: a handful of retries in
 * quick succession opened a handful of soundtracks, the browser had not finished
 * dropping the abandoned ones, and the budget is three. The driver got a picture,
 * silence, and "ses akışı kapasitesi dolu" — the one failure this entire path
 * exists to prevent. The count is still bounded; it is now enforced by eviction
 * rather than by turning the driver away.
 */
function makeAudioRoom() {
  while (liveAudio.size >= config.maxSessions + 1) {
    let oldest = null;
    for (const session of liveAudio) {
      if (!oldest || session.startedAt < oldest.startedAt) oldest = session;
    }
    if (!oldest) return;
    console.warn(`[ffmpeg] retiring ${oldest.label} to make room for a new soundtrack`);
    oldest.stop();
  }
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
// dropped it, or ffmpeg wedged. Left alone it holds a slot and, worse, a share
// of the CPU.
const IDLE_LIMIT_MS = 30000;

// Being quiet and being dead are not the same thing, and the difference is the
// consumer. Both of them throttle by pausing this pipe — the socket writer when
// the client reports its decoder full, Node's own pipe() when the browser stops
// reading the response body — and a paused Readable emits no 'data' events at
// all. So the timestamp those events maintain stops advancing, and silence from
// a held stream says nothing whatever about ffmpeg's health.
//
// That only became fatal when the server started sending faster than real time.
// Under -re the pipe drained continuously and a pause was a passing thing; under
// -readrate 1.5 the consumer is full most of the time *by design*, so the idle
// clock ran out on streams that were working exactly as intended and this reaper
// killed every one of them thirty seconds in — on all three transports at once,
// and on the soundtrack beside them, because every one of them is a paused pipe.
//
// A held stream is therefore left alone. The case the idle limit was really
// guarding against — a consumer gone without its socket closing — is already
// covered at both ends (ws.on('close') and res.on('close') both stop the
// session), so what remains here is a long backstop rather than the front line.
const HELD_LIMIT_MS = 10 * 60 * 1000;

/**
 * Why this session should be killed, or null to leave it alone.
 *
 * Split out from the sweep so the policy can be tested without an ffmpeg, a CDN
 * and a forty-second wait — which is the only reason the original went unnoticed
 * for as long as it did.
 */
function reapReason(session, now) {
  if (session.held) {
    return now - session.heldSince >= HELD_LIMIT_MS
      ? `has been held by its consumer for ${Math.round(HELD_LIMIT_MS / 60000)} minutes`
      : null;
  }
  if (now - session.lastOutput < IDLE_LIMIT_MS) return null;
  // Never started and stopped part-way are different faults with different
  // causes, and the report said neither — only that ffmpeg had been killed,
  // which is true of both and useful for neither.
  return session.everProduced
    ? `stopped producing ${IDLE_LIMIT_MS / 1000}s ago`
    : `never produced a frame in ${IDLE_LIMIT_MS / 1000}s`;
}

function reapTick(now = Date.now()) {
  for (const session of [...live, ...liveAudio]) {
    const stdout = session.stdout;
    const held = Boolean(stdout && typeof stdout.isPaused === 'function' && stdout.isPaused());

    if (held) {
      if (!session.held) session.heldSince = now;
      // The idle clock measures ffmpeg's silence, so it must not run while the
      // consumer is the one keeping it quiet — otherwise a stream resuming from
      // a long hold would be reaped on its first tick back.
      session.lastOutput = now;
    }
    session.held = held;

    const reason = reapReason(session, now);
    if (!reason) continue;
    console.warn(`[ffmpeg] ${session.label} ${reason}, killing it`);
    // Carried to the close handler so the driver is told what happened rather
    // than which signal was used to do it.
    session.reapedFor = reason;
    session.stop();
  }
}

setInterval(reapTick, 5000).unref();

// Not reconnecting on an HTTP status, which was tried and was a mistake.
//
// The idea was that a 403 on an address-locked URL might be a rotating proxy
// handing out a different exit per connection, in which case reopening the
// connection draws again and costs nothing. Measuring it settled that: twelve
// resolves, one address, no rotation. Retrying the same refusal from the same
// address can only ever fail — and it failed *silently*, because with reconnect
// enabled ffmpeg demotes the 403 to a warning that -loglevel error hides. A
// refusal that used to arrive in 400ms with its reason attached became thirty
// seconds of nothing, ending in the reaper's SIGKILL and a failure report that
// said only that ffmpeg had been killed. It also cost the client demotion,
// which keys off exactly that message.
//
// Left here as a note rather than an option, because it is a plausible-sounding
// idea that makes things worse.

// HTTP inputs from YouTube's CDN drop often enough that reconnects are not
// optional. These flags are per-input and must precede the -i they apply to.
// They belong to ffmpeg's http protocol, so a non-HTTP input would be rejected
// outright with "Option reconnect not found".
function inputArgs(url, startTime, userAgent) {
  const args = [];
  if (/^https?:/i.test(url)) {
    // googlevideo hands a URL to whichever client asked for it and, for several
    // of the player clients, refuses to serve it to anything else. ffmpeg's own
    // "Lavf/…" is exactly that anything else, and the refusal arrives as a bare
    // 403 well after the resolve looked perfectly healthy.
    if (userAgent) args.push('-user_agent', userAgent);
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '10',
    );
    // Deliberately no -reconnect_on_http_error: see the note above. A refusal
    // must fail fast and loudly so the client that produced the URL gets stood
    // down, which is the thing that actually recovers.
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

    const args = ['-hide_banner', '-loglevel', LOGLEVEL, ...pacingArgs()];
    args.push(...inputArgs(streams.video, startTime, streams.userAgent));

    // DASH gives video and audio as separate URLs; progressive gives one muxed
    // file. Only add a second input when there really is one.
    const separateAudio = withAudio && Boolean(streams.audio);
    if (separateAudio) args.push(...inputArgs(streams.audio, startTime, streams.userAgent));

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

    return spawnFfmpeg(args, `video ${videoId}@${quality}p t=${startTime}`, 'video', videoId, streams.client);
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

    const args = ['-hide_banner', '-loglevel', LOGLEVEL];
    args.push(...inputArgs(streams.video, startTime, streams.userAgent));
    if (streams.audio) args.push(...inputArgs(streams.audio, startTime, streams.userAgent));

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

    return spawnFfmpeg(args, `direct ${videoId}@${quality}p t=${startTime} ${copyable ? 'copy' : 'transcode'}`, 'video', videoId, streams.client);
  } finally {
    releaseSlot();
  }
}

/**
 * Raw H.264 on stdout, copied rather than re-encoded, with access unit
 * delimiters inserted.
 *
 * This is what the canvas path should have been all along. The car decodes
 * 720p30 H.264 at 231 fps in software — measured, not assumed — so there is no
 * reason for this server to spend a core per viewer turning YouTube's H.264
 * into MPEG1. Copying costs almost nothing, the picture is YouTube's own rather
 * than a second-generation re-encode, and the bitrate is a third of MPEG1's for
 * the same quality.
 *
 * It still reaches the screen through a <canvas>, via WebCodecs, so no <video>
 * element exists and the Drive lockout has nothing to act on.
 *
 * Annex-B rather than MP4 on purpose: with delimiters inserted, splitting the
 * stream into frames is a start-code scan, and VideoDecoder accepts Annex-B
 * directly when configured without a description. An fMP4 would mean writing a
 * box parser on the client for no gain.
 */
async function startH264Stream({ videoId, quality, startTime = 0 }) {
  const releaseSlot = reserveSlot();
  try {
    // Only H.264 will do here, so a video YouTube offers only in VP9 or AV1 has
    // to be re-encoded — the one case where this path costs what the old one
    // always cost.
    let streams;
    let copyable = true;
    try {
      streams = await youtube.resolveStreams(videoId, quality, { requireAvc: true });
    } catch (err) {
      copyable = false;
      streams = await youtube.resolveStreams(videoId, quality);
      console.log(`[h264] ${videoId}: no H.264 at ${quality}p, transcoding instead`);
    }

    const args = ['-hide_banner', '-loglevel', LOGLEVEL, ...pacingArgs()];
    args.push(...inputArgs(streams.video, startTime, streams.userAgent));
    args.push('-map', '0:v:0', '-an');

    if (copyable) {
      args.push('-c:v', 'copy');
    } else {
      const preset = config.QUALITY[quality] || config.QUALITY[config.DEFAULT_QUALITY];
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
        '-b:v', preset.videoBitrate, '-maxrate', preset.videoBitrate,
        '-bufsize', preset.videoBitrate, '-pix_fmt', 'yuv420p',
        '-vf', `scale=${preset.scale}`,
      );
    }

    args.push(
      // Two filters, and both are load-bearing.
      //
      // h264_mp4toannexb moves the parameter sets out of the container and
      // in-band. ffmpeg inserts it automatically when muxing raw H.264, but
      // only when no explicit -bsf is given — set one and the automatic one is
      // gone, and the stream arrives with no SPS for the decoder to configure
      // from. It also repeats them before every keyframe, so a re-cut mid-video
      // does not have to start from the beginning of the file.
      //
      // h264_metadata=aud=insert adds the access unit delimiters that turn
      // frame splitting on the client into a start-code scan.
      '-bsf:v', copyable
        ? 'h264_mp4toannexb,h264_metadata=aud=insert'
        : 'h264_metadata=aud=insert',
      '-f', 'h264',
      '-',
    );

    return spawnFfmpeg(args, `h264 ${videoId}@${quality}p t=${startTime} ${copyable ? 'copy' : 'transcode'}`,
      'video', videoId, streams.client);
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
  const streams = await youtube.resolveStreams(videoId, 480);
  const url = streams.audio || streams.video;

  // The soundtrack is the master clock, so a stall in it stalls everything.
  // Paced the same way, and it is a tenth of the video's bitrate anyway.
  const args = ['-hide_banner', '-loglevel', LOGLEVEL, ...pacingArgs()];
  args.push(...inputArgs(url, startTime, streams.userAgent));
  args.push(
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'mp3',
    '-',
  );

  return spawnFfmpeg(args, `audio ${videoId} t=${startTime}`, 'audio', videoId, streams.client);
}

/**
 * The last thing that went wrong, kept so it can be read from the car.
 *
 * A stream that dies having produced nothing closes its socket like any other,
 * and the player cannot tell that from a link that dropped — so the driver gets
 * "Bağlantı bekleniyor…" and a rising attempt count while the actual explanation
 * sits in journalctl on a box they are a hundred miles from. ffmpeg always knew
 * why; nothing carried it to the screen.
 */
let failure = null;

// ffmpeg quotes the whole media URL back at us, which is a kilometre of signed
// query string, and a proxy URL can carry credentials. Neither belongs in an API
// response.
//
// But which parameters are present is not noise — an `ip` in there means the URL
// is locked to the address that resolved it, and a `pot` means it wants a
// proof-of-origin token — so the names survive and every value goes. Redacting
// them wholesale hid exactly the half worth reading, once.
const TELLING = ['ip', 'ipbits', 'pot', 'expire', 'sparams'];

function redact(text) {
  return String(text || '')
    .replace(/\/\/[^@\s/]*@/g, '//***@')
    .replace(/(https?:\/\/[^\s?]+)\?(\S*)/g, (match, base, query) => {
      const names = query.split('&').map((p) => p.split('=')[0]).filter(Boolean);
      const telling = TELLING.filter((k) => names.includes(k));
      return `${base}?[${names.length} param${telling.length ? '; ' + telling.join(',') : ''}]`;
    })
    .trim();
}

function noteFailure(label, videoId, detail) {
  failure = {
    at: new Date().toISOString(),
    label,
    videoId: videoId || null,
    detail: redact(detail).slice(0, 300),
  };
}

function lastFailure() {
  return failure;
}

function spawnFfmpeg(args, label, pool, videoId, client) {
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const group = pool === 'audio' ? liveAudio : live;
  let produced = 0;

  const session = {
    proc,
    stdout: proc.stdout,
    label,
    startedAt: Date.now(),
    lastOutput: Date.now(),
    // Maintained by the reaper sweep, not here: whether the consumer currently
    // has this pipe paused, and since when, and why it was killed if it was.
    held: false,
    heldSince: 0,
    everProduced: false,
    reapedFor: null,
    stop() {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      release();
    },
  };

  group.add(session);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    group.delete(session);
    console.log(`[ffmpeg] stopped ${label} — ${sessionCount()}/${config.maxSessions} video, ${liveAudio.size} audio`);
  };

  // Doubles as the liveness signal the reaper reads.
  proc.stdout.on('data', (chunk) => {
    session.lastOutput = Date.now();
    session.everProduced = true;
    produced += chunk.length;
  });

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    // Keep only the tail; a stuck stream can otherwise log for hours.
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  proc.on('close', (code, signal) => {
    release();
    const tail = stderrTail.trim().split('\n').slice(-2).join(' ');
    if (code !== 0 && !signal) {
      console.error(`[ffmpeg] ${label} exited ${code}: ${tail}`);
    }
    // Nothing came out at all, or the CDN went sour midway. Either way the media
    // URL this was built from is not worth handing to the next attempt.
    const suspect = /40[0-9] |403|Forbidden|Server returned|Invalid data/i.test(stderrTail);
    if (videoId && (produced === 0 || suspect)) {
      youtube.forgetResolve(videoId);
      console.warn(`[ffmpeg] ${label} produced ${produced} bytes; dropped its cached URLs`);
    }
    // Dropping the URLs is not enough on its own: the same client resolves the
    // same video again and hands back URLs the CDN refuses for the same reason,
    // forever. This is the only place that failure is visible, so it is the only
    // place that can report it.
    //
    // Narrower than the test above, deliberately. Standing a client down for
    // half an hour on the strength of a stray "Invalid data" — which is an
    // ordinary warning now that warnings are captured — would take a working
    // client out of the chain for no reason.
    const denied = /\b40[0-9]\b|Forbidden|access denied/i.test(stderrTail);
    if (denied && client) youtube.clientRefused(client);
    // Not a byte. Whatever ffmpeg said about that is the only explanation anyone
    // is going to get, so it is kept where the player can reach it — and if we
    // were the ones who killed it, say what for. "SIGKILL" describes the method
    // and not the fault, and was the whole of one failure report.
    if (produced === 0) {
      session.failure = tail
        || (session.reapedFor && `ffmpeg ${session.reapedFor}`)
        || (signal
          ? `ffmpeg ${signal} ile durduruldu, hiç görüntü üretmedi`
          : `ffmpeg ${code} ile çıktı, hiç görüntü üretmedi`);
      noteFailure(label, videoId, session.failure);
    }
  });

  proc.on('error', (err) => {
    release();
    session.failure = `ffmpeg başlatılamadı: ${err.message}`;
    noteFailure(label, videoId, session.failure);
    console.error(`[ffmpeg] ${label} failed to start: ${err.message}`);
  });

  console.log(`[ffmpeg] started ${label} — ${sessionCount()}/${config.maxSessions} video, ${liveAudio.size} audio`);
  return session;
}

module.exports = {
  startVideoStream, startDirectStream, startH264Stream, startAudioStream,
  sessionCount, atCapacity, audioAtCapacity, makeAudioRoom, lastFailure,
  // For test/reaper.js. The sweep decides whether a working stream lives, so it
  // is worth testing directly rather than through forty seconds of ffmpeg.
  _reap: { reapReason, reapTick, live, liveAudio, IDLE_LIMIT_MS, HELD_LIMIT_MS },
};
