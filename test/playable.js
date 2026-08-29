'use strict';

/**
 * Resolving to URLs that have been shown to work, rather than to URLs that
 * merely exist.
 *
 * Every round of this failure went the same way. A client resolves cleanly and
 * hands back well-formed URLs; the refusal arrives much later, inside ffmpeg,
 * as a 403. Nothing between the two could tell a good client from a useless
 * one, so the choice was made from the outside — by me, guessing — and the
 * guesses were wrong in both directions. yt-dlp's own table says `android`
 * needs a proof-of-origin token and `android_vr` does not; the car measured the
 * exact opposite. Acting on the table put a working client behind two broken
 * ones and nothing played at all.
 *
 * So the choice is no longer predicted. The caller supplies a way to verify —
 * in production, fetching the first fraction of a second exactly as the real
 * stream will — and the chain is walked until something passes.
 *
 * Here the verifier is a stub, because what needs testing is the walk: that it
 * advances past a refusal, stands the bad client down, stops on the first that
 * works, remembers it, and gives up in a way the driver can read.
 */
const helpers = require('./helpers');

const rep = helpers.reporter();
const youtube = require('../server/youtube');
const { refusedUntil, resetProven } = youtube._chain;

// yt-dlp is never run: resolvePlayable takes its resolver as a seam, so this
// suite needs no network, no ffmpeg and no fixture.
const CHAIN = youtube.CLIENT_CHAIN;

let asked = [];
let resolve = null;
function pretendChainOf(...clients) {
  asked = [];
  let i = 0;
  resolve = async () => {
    // The real one walks the chain itself and returns whichever client answered;
    // standing one down is what makes the next call return the next client.
    const client = clients[Math.min(i++, clients.length - 1)];
    asked.push(client);
    return { video: `https://v/${client}`, audio: null, userAgent: 'UA', client };
  };
}

const accepts = (...good) => async (s) =>
  (good.includes(s.client) ? { ok: true } : { ok: false, why: '403 Forbidden' });

(async () => {
  // ------------------------------------------------- the first one just works
  refusedUntil.clear();
  resetProven();
  pretendChainOf('android_vr');
  {
    const s = await youtube.resolvePlayable('vid00000001', 480, { resolve, verify: accepts('android_vr') });
    rep.check('a client that fetches is used immediately', s.client === 'android_vr');
    rep.check('and nothing else was asked', asked.length === 1, asked.join(','));
  }

  // --------------------------------------------- walking past a refused client
  //
  // The exact shape of the fault: the first client resolves perfectly and its
  // URLs are refused. Before this, that was the end of it.
  refusedUntil.clear();
  resetProven();
  pretendChainOf('android_vr', 'android');
  {
    const s = await youtube.resolvePlayable('vid00000002', 480, { resolve, verify: accepts('android') });
    rep.check('a refused client is walked past, not settled on', s.client === 'android',
      asked.join(' → '));
    rep.check('and stood down so the next video skips it',
      refusedUntil.has('android_vr'));
  }

  // ------------------------------------------------------ remembering a winner
  //
  // Verifying costs a real fetch, so it must not be paid on every video.
  refusedUntil.clear();
  resetProven();
  pretendChainOf('android');
  {
    let verifications = 0;
    const counting = async (s) => { verifications += 1; return accepts('android')(s); };
    await youtube.resolvePlayable('vid00000003', 480, { resolve, verify: counting });
    await youtube.resolvePlayable('vid00000004', 480, { resolve, verify: counting });
    await youtube.resolvePlayable('vid00000005', 480, { resolve, verify: counting });
    rep.check('a proven client is trusted rather than re-probed every time',
      verifications === 1, `${verifications} probe(s) across 3 videos`);
  }

  // ------------------------------------------------------- nothing works at all
  //
  // Has to end, and has to say something a driver can act on rather than
  // looping or throwing a bare 403.
  refusedUntil.clear();
  resetProven();
  pretendChainOf(...CHAIN);
  {
    let error = null;
    try {
      await youtube.resolvePlayable('vid00000006', 480, { resolve, verify: accepts() });
    } catch (err) {
      error = err;
    }
    rep.check('a chain where nothing works terminates', Boolean(error));
    rep.check('having tried more than one client', asked.length > 1, `${asked.length} tried`);
    rep.check('and says so in plain words',
      error && /oynatılabilir adres vermedi/.test(error.message),
      error ? error.message.slice(0, 90) : '');
  }

  // --------------------------------------------------------- no verifier given
  //
  // Paths that do not care — metadata, the media check — must not be made to
  // pay for a fetch they have no use for.
  refusedUntil.clear();
  resetProven();
  pretendChainOf('tv');
  {
    const s = await youtube.resolvePlayable('vid00000007', 480, { resolve });
    rep.check('without a verifier it behaves as before', s.client === 'tv');
  }

  refusedUntil.clear();
  rep.done('playable');
})().catch((e) => { console.error(e); process.exit(1); });
