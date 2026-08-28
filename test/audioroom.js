'use strict';

/**
 * Making room for a soundtrack rather than refusing one.
 *
 * The audio budget is small — one more than the video budget — and it used to
 * be enforced by turning requests away. That is the wrong answer in a car: a
 * new audio request always supersedes whatever came before it, so the stream
 * being counted against the driver is the one nobody is listening to.
 *
 * It showed up the moment playback started working again. A burst of retries
 * opened several soundtracks in a few seconds, the browser had not finished
 * dropping the abandoned ones, and the third request was refused: picture,
 * silence, and "ses akışı kapasitesi dolu" — the exact failure the fallback
 * audio path exists to prevent.
 */
const helpers = require('./helpers');

const rep = helpers.reporter();
const config = require('../server/config');
const stream = require('../server/stream');
const { liveAudio } = stream._reap;

const BUDGET = config.maxSessions + 1;

let clock = 1000;
function fakeAudio(label) {
  const session = {
    label,
    startedAt: (clock += 1000),
    stopped: false,
    stdout: { isPaused: () => false },
    stop() { this.stopped = true; liveAudio.delete(this); },
  };
  liveAudio.add(session);
  return session;
}

const clear = () => { for (const s of [...liveAudio]) liveAudio.delete(s); };

// Under budget, nothing is touched.
clear();
{
  const kept = [];
  for (let i = 0; i < BUDGET - 1; i++) kept.push(fakeAudio(`audio ${i}`));
  stream.makeAudioRoom();
  rep.check('below the budget, nothing is retired',
    kept.every((s) => !s.stopped), `${liveAudio.size}/${BUDGET}`);
}

// At budget, the oldest goes — and only the oldest.
clear();
{
  const sessions = [];
  for (let i = 0; i < BUDGET; i++) sessions.push(fakeAudio(`audio ${i}`));
  stream.makeAudioRoom();
  rep.check('at the budget, the oldest is retired', sessions[0].stopped);
  rep.check('and the newest is not', !sessions[sessions.length - 1].stopped);
  rep.check('leaving room for exactly one more',
    liveAudio.size === BUDGET - 1, `${liveAudio.size}/${BUDGET}`);
}

// A pile-up retires as many as it takes, so the request that follows always
// gets through — that is the whole point.
clear();
{
  for (let i = 0; i < BUDGET + 4; i++) fakeAudio(`audio ${i}`);
  stream.makeAudioRoom();
  rep.check('a pile-up is cleared down to leave room',
    liveAudio.size === BUDGET - 1, `${liveAudio.size}/${BUDGET}`);
  rep.check('so the next soundtrack is never refused', !stream.audioAtCapacity());
}

// Order is by age, not by insertion into the set.
clear();
{
  const young = fakeAudio('young');
  const old = fakeAudio('old');
  old.startedAt = 1; // added later, started earlier
  for (let i = 0; i < BUDGET - 2; i++) fakeAudio(`filler ${i}`);
  stream.makeAudioRoom();
  rep.check('the oldest by start time is chosen, not the first added',
    old.stopped && !young.stopped, `old=${old.stopped} young=${young.stopped}`);
}

clear();
rep.done('audioroom');
