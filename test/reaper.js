'use strict';

/**
 * The idle reaper, which for several days was quietly killing every stream that
 * worked.
 *
 * Its job is to collect an ffmpeg that has stopped producing — a dropped CDN
 * connection, a wedged process — because one of those holds a session slot and a
 * share of a single-core box forever. Its whole difficulty is that a healthy
 * stream also stops producing, constantly and on purpose, whenever its consumer
 * stops reading. Both transports throttle by pausing the pipe, and a paused
 * Readable emits nothing at all.
 *
 * Under `-re` that pause was momentary and the reaper never noticed. Under
 * `-readrate 1.5` the consumer is full most of the time by design, so the reaper
 * started killing canvas, H.264, direct and the soundtrack alike, thirty seconds
 * into every attempt — which from the driver's seat is "no video plays".
 *
 * No ffmpeg, no network and no forty-second wait: the sweep is called directly
 * with a fake session, which is the only way a test for this is cheap enough to
 * keep running.
 */
const { PassThrough } = require('stream');
const helpers = require('./helpers');

const rep = helpers.reporter();
const { _reap } = require('../server/stream');
const { reapTick, live, IDLE_LIMIT_MS, HELD_LIMIT_MS } = _reap;

// Shaped like what spawnFfmpeg registers, minus the process.
function fakeSession(label) {
  const stdout = new PassThrough({ highWaterMark: 1024 });
  const session = {
    stdout,
    label,
    lastOutput: Date.now(),
    held: false,
    heldSince: 0,
    killed: false,
    stop() { this.killed = true; live.delete(this); },
  };
  live.add(session);
  return session;
}

function clear() {
  for (const s of [...live]) live.delete(s);
}

// ------------------------------------------------------- a genuinely dead one
//
// The behaviour that must survive the fix: ffmpeg flowing and silent is ffmpeg
// that is not coming back.
clear();
{
  const dead = fakeSession('dead');
  dead.stdout.resume(); // flowing, as spawnFfmpeg's own data listener leaves it
  const now = Date.now();
  dead.lastOutput = now - IDLE_LIMIT_MS - 1000;
  reapTick(now);
  rep.check('a flowing stream that has gone silent is still collected', dead.killed);
}

// ------------------------------------------------------------- and a held one
//
// The regression itself. Backpressure is applied the way Node applies it, by
// piping into something nobody drains, rather than by calling pause() by hand —
// so the test fails if the real mechanism ever stops looking like this.
clear();
{
  const held = fakeSession('held');
  const nobody = new PassThrough({ highWaterMark: 1024 });
  held.stdout.on('data', () => { held.lastOutput = Date.now(); });
  held.stdout.pipe(nobody);
  for (let i = 0; i < 8; i++) held.stdout.write(Buffer.alloc(4096));

  setImmediate(() => {
    rep.check('backpressure really does pause the source',
      held.stdout.isPaused(), `isPaused=${held.stdout.isPaused()}`);

    // Well past the idle limit, and no data event has fired in all that time.
    const now = Date.now() + IDLE_LIMIT_MS + 60000;
    reapTick(now);
    rep.check('a stream held by its consumer is left alone', !held.killed);
    rep.check('and the sweep records when the hold began',
      held.held && held.heldSince > 0);

    // Coming back from a long hold must not be fatal either: the idle clock
    // measures ffmpeg's silence, and it did not run while the consumer was the
    // one keeping things quiet.
    nobody.resume();
    setTimeout(() => {
      rep.check('the hold clears once the consumer drains', !held.stdout.isPaused(),
        `isPaused=${held.stdout.isPaused()}`);
      reapTick(Date.now());
      rep.check('and resuming from a long hold is not read as a stall', !held.killed);

      // The backstop. A consumer that has genuinely vanished without its socket
      // closing still gets collected, just far later than a working one would.
      clear();
      const abandoned = fakeSession('abandoned');
      const void_ = new PassThrough({ highWaterMark: 1024 });
      abandoned.stdout.pipe(void_);
      for (let i = 0; i < 8; i++) abandoned.stdout.write(Buffer.alloc(4096));

      setImmediate(() => {
        const t0 = Date.now();
        reapTick(t0);                              // notices the hold
        reapTick(t0 + HELD_LIMIT_MS - 1000);       // still inside the backstop
        rep.check('a hold shorter than the backstop survives', !abandoned.killed);
        reapTick(t0 + HELD_LIMIT_MS + 1000);
        rep.check('an abandoned stream is collected eventually', abandoned.killed);

        rep.check('the backstop is far longer than the idle limit',
          HELD_LIMIT_MS > IDLE_LIMIT_MS * 10,
          `${HELD_LIMIT_MS / 1000}s vs ${IDLE_LIMIT_MS / 1000}s`);

        clear();
        rep.done('reaper');
      });
    }, 50);
  });
}
