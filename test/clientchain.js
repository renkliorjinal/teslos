'use strict';

/**
 * Standing down a client the CDN refuses.
 *
 * This is the fault that stopped everything playing, and it is worth stating
 * plainly because nothing about it looks like a bug from any single vantage
 * point. yt-dlp is asked to resolve, and answers — android_vr hands back
 * perfectly well-formed URLs every time. Minutes later ffmpeg fetches one and
 * googlevideo returns 403. Nothing carried that back to the chain, which only
 * ever saw a client that worked, so it pinned itself there and stayed. Every
 * stream on every transport died, for days, with `android` sitting two places
 * further down the same chain and working fine.
 *
 * Dropping the cached URL was not enough: the same client resolves the same
 * video again and produces another URL refused for the same reason.
 *
 * No yt-dlp, no network — the chain is asked directly which clients it would
 * try, which is the whole of the behaviour that was missing.
 */
const helpers = require('./helpers');

const rep = helpers.reporter();
const youtube = require('../server/youtube');
const { usableChain, refusedUntil, REFUSAL_TTL_MS } = youtube._chain;

const CHAIN = youtube.CLIENT_CHAIN;
const clear = () => refusedUntil.clear();

// ------------------------------------------------------------- the baseline
clear();
rep.check('with nothing refused, the whole chain is on offer',
  usableChain().join(',') === CHAIN.join(','), `${usableChain().length} clients`);

// --------------------------------------------------------- standing one down
clear();
{
  youtube.clientRefused('android_vr');
  const chain = usableChain();
  rep.check('a refused client drops out of the chain',
    !chain.includes('android_vr'), chain.join(','));
  rep.check('and everything else stays', chain.length === CHAIN.length - 1);
  rep.check('including the one that actually works', chain.includes('android'));
}

// The precise failure: the refused client must not be preferred any more. It
// was, and that is the whole reason the chain never advanced past it.
clear();
{
  youtube.clientRefused('android_vr');
  rep.check('and it is no longer the preferred client',
    youtube.activeClient() !== 'android_vr', String(youtube.activeClient()));
}

// ------------------------------------------------------------- coming back
clear();
{
  youtube.clientRefused('ios');
  rep.check('the penalty holds while it is fresh', !usableChain().includes('ios'));
  // Expire it by hand rather than waiting half an hour.
  refusedUntil.set('ios', Date.now() - 1000);
  rep.check('and lifts by itself once it is stale', usableChain().includes('ios'));
  rep.check('the penalty is long enough to outlast one video, short enough to lift',
    REFUSAL_TTL_MS >= 10 * 60 * 1000 && REFUSAL_TTL_MS <= 2 * 60 * 60 * 1000,
    `${REFUSAL_TTL_MS / 60000} minutes`);
}

// --------------------------------------------------- never nothing to try
//
// Standing every client down would leave the chain empty and the next request
// with no client at all, which is a worse failure than the one being avoided —
// and far more likely to mean the penalties are stale than that YouTube has
// closed every door at once.
clear();
{
  for (const client of CHAIN) youtube.clientRefused(client);
  const chain = usableChain();
  rep.check('refusing every client does not leave an empty chain',
    chain.length === CHAIN.length, `${chain.length} of ${CHAIN.length}`);
  rep.check('the penalties are cleared rather than honoured into a dead end',
    refusedUntil.size === 0);
}

// ------------------------------------------------------------------ hygiene
clear();
rep.check('refusing nothing is harmless',
  (youtube.clientRefused(null), youtube.clientRefused(undefined),
    usableChain().length === CHAIN.length));

rep.check('the chain still leads with the clients that need no authentication',
  CHAIN[0] === 'tv_simply', CHAIN.slice(0, 4).join(','));

rep.done('clientchain');
