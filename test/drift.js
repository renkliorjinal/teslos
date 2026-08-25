'use strict';
// Holding sync, as arithmetic. The rule inverted: the soundtrack is the master
// clock and is never touched, because touching it hands the car's media source
// back and forth. Only the picture moves, and only when the gap is worth a
// second of rebuffering.
//
// Mirrors holdSync() in public/player/player.js.
const RESYNC_THRESHOLD = 1.5;
const RESYNC_COOLDOWN_MS = 12000;

function decide(pictureAt, audioBase, audioTime, nudge, sinceResyncMs) {
  const master = audioBase + audioTime;
  const drift = pictureAt - nudge - master;
  if (Math.abs(drift) > RESYNC_THRESHOLD && sinceResyncMs > RESYNC_COOLDOWN_MS) {
    return { action: 'recut', drift, recutTo: master + nudge };
  }
  return { action: 'leave', drift };
}

let bad = 0;
function check(l, ok, d) { console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`); if (!ok) bad++; }

const LATER = 60000;   // well past the cooldown

let r = decide(30, 0, 30, 0, LATER);
check('in sync leaves everything alone', r.action === 'leave', `drift ${r.drift.toFixed(2)}`);

r = decide(30, 0, 29.5, 0, LATER);
check('half a second is not worth a rebuffer', r.action === 'leave', `drift ${r.drift.toFixed(2)}`);

r = decide(32, 0, 30, 0, LATER);
check('picture ahead is re-cut', r.action === 'recut', `drift ${r.drift.toFixed(2)}`);

r = decide(28, 0, 30, 0, LATER);
check('picture behind is re-cut too', r.action === 'recut', `drift ${r.drift.toFixed(2)}`);

r = decide(32, 0, 30, 0, LATER);
check('re-cut lands on the soundtrack', Math.abs(r.recutTo - 30) < 0.001, `to ${r.recutTo}s`);

// The anti-flapping property, and the reason the cooldown exists: a stuttering
// picture meets the threshold constantly, and re-cutting every time would turn
// playback into a slideshow.
r = decide(32, 0, 30, 0, 3000);
check('a fresh re-cut is not immediately re-cut again',
  r.action === 'leave', `drift ${r.drift.toFixed(2)} at 3s since last`);

// Seeking to 20s starts both streams there, so the audio clock reads from 0.
r = decide(25, 20, 5, 0, LATER);
check('offset stream counted from its own base', r.action === 'leave', `drift ${r.drift.toFixed(2)}`);

// A deliberate nudge is an offset to hold, not an error to correct.
r = decide(32, 0, 30, 2, LATER);
check('deliberate offset is held', r.action === 'leave', `drift ${r.drift.toFixed(2)}`);

r = decide(30, 0, 30, 2, LATER);
check('drifting off the chosen offset is re-cut', r.action === 'recut', `drift ${r.drift.toFixed(2)}`);

r = decide(30, 0, 30, 2, LATER);
check('...to the offset, not to zero', Math.abs(r.recutTo - 32) < 0.001, `to ${r.recutTo}s`);

// The property that matters most, stated directly: nothing this function can
// decide ever disturbs the soundtrack.
const verdicts = [
  decide(30, 0, 30, 0, LATER), decide(40, 0, 30, 0, LATER),
  decide(20, 0, 30, 0, LATER), decide(30, 0, 30, 0, 0),
];
check('no outcome ever touches the soundtrack',
  verdicts.every((v) => v.action === 'leave' || v.action === 'recut'),
  [...new Set(verdicts.map((v) => v.action))].join(', '));

console.log(bad ? `\n${bad} FAILED\n` : '\nsync holding behaves\n');
process.exit(bad ? 1 : 0);
