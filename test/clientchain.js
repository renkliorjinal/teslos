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

// The order is not cosmetic, and getting it wrong is not visible from anywhere
// in this system: a client that needs a proof-of-origin token resolves happily
// and hands back well-formed URLs, and only the fetch is refused, later, in
// ffmpeg. The chain settles on it and stays. So the leaders are pinned here.
//
// Read out of the installed yt-dlp — INNERTUBE_CLIENTS[c].GVS_PO_TOKEN_POLICY —
// not from memory. tv_downgraded is also token-free but requires a cookie jar.
const NO_TOKEN_NEEDED = ['android_vr', 'tv', 'web_embedded'];

// yt-dlp's INNERTUBE_CLIENTS keys. A name that is not one of these is silently
// ignored by yt-dlp, so a typo here costs a wasted attempt every time the chain
// reaches it and shows up nowhere — `tv_embedded` sat in the chain doing that.
const KNOWN = ['web', 'web_safari', 'web_embedded', 'web_music', 'web_creator',
  'android', 'android_vr', 'ios', 'mweb', 'tv', 'tv_downgraded', 'tv_simply',
  // Ours, meaning "pass no player_client at all and take yt-dlp's default".
  'default'];

// The table is a hint, not the rule. The car contradicted it in both directions
// — android fetched media it supposedly needs a token for, android_vr was
// refused without needing one — so the order here only decides who is asked
// first. resolvePlayable settles who is used by actually fetching bytes.

rep.check('the chain leads with a client that needs no proof-of-origin token',
  NO_TOKEN_NEEDED.includes(CHAIN[0]), CHAIN[0]);
rep.check('all three token-free clients are in the chain at all',
  NO_TOKEN_NEEDED.every((c) => CHAIN.includes(c)), CHAIN.join(','));
rep.check('tv_embedded is gone, since yt-dlp has no such client',
  !CHAIN.includes('tv_embedded'));
rep.check('every name is one yt-dlp actually has',
  CHAIN.every((c) => KNOWN.includes(c)), CHAIN.filter((c) => !KNOWN.includes(c)).join(',') || 'all known');

rep.done('clientchain');
