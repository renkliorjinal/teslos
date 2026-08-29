'use strict';

/**
 * Reading yt-dlp's answer.
 *
 * The resolve now asks for two different things at once — the media URLs and
 * the User-Agent googlevideo will insist on seeing them fetched with — and gets
 * them back as undifferentiated lines of text. Misreading that does not throw
 * and does not log: it hands ffmpeg a URL with no header, which is a 403 twenty
 * seconds later and, from the driver's seat, a video that simply will not play.
 *
 * So the shapes yt-dlp can actually produce are pinned here, including the ones
 * that only appear for some clients and some videos.
 */
const helpers = require('./helpers');

const rep = helpers.reporter();
const { _parseResolve: parse } = require('../server/youtube');

const UA = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L) gzip';
// What yt-dlp actually prints: the header dict, as JSON, because `User-Agent`
// has a hyphen and can never be addressed as a template field path.
const H = JSON.stringify({ 'User-Agent': UA, 'Accept-Language': 'en-us,en;q=0.5' });
const V = 'https://rr5---sn-pouxga5o.googlevideo.com/videoplayback?expire=1&itag=136';
const A = 'https://rr5---sn-pouxga5o.googlevideo.com/videoplayback?expire=1&itag=140';

// DASH: the usual case. One header line, then video and audio.
{
  const r = parse(`${H}\n${V}\n${A}\n`);
  rep.check('separate video and audio come back in order', r.video === V && r.audio === A);
  rep.check('and carry the header they must be fetched with', r.userAgent === UA);
}

// Progressive: one muxed URL, no second stream.
{
  const r = parse(`${H}\n${V}\n`);
  rep.check('a single muxed URL leaves audio null', r.video === V && r.audio === null);
  rep.check('and still carries the header', r.userAgent === UA);
}

// --print and -g are an ordered list, and one release reordering them must not
// silently cost the header.
{
  const r = parse(`${V}\n${A}\n${H}\n`);
  rep.check('the header is found whichever end it is printed at',
    r.userAgent === UA && r.video === V && r.audio === A);
}

// An extractor that sets no header prints yt-dlp's placeholder, which is not a
// User-Agent and must never be sent as one.
{
  const r = parse(`NA\n${V}\n${A}\n`);
  rep.check('"NA" is not mistaken for a header', r.userAgent === null);
  rep.check('and the URLs still come through', r.video === V && r.audio === A);
}

// The old two-line shape, from a yt-dlp too old for the field or a fallback
// path that did not ask for it. Playback has to survive it, header or no.
{
  const r = parse(`${V}\n${A}\n`);
  rep.check('output with no header line still resolves', r.video === V && r.audio === A);
  rep.check('with the header simply absent', r.userAgent === null);
}

// A bare User-Agent line, which is what the earlier --print produced. Kept
// working so a rollback or an older yt-dlp does not silently drop the header.
{
  const r = parse(`${UA}\n${V}\n${A}\n`);
  rep.check('a plain header line is still understood', r.userAgent === UA);
}

// Blank lines and trailing whitespace, which yt-dlp emits freely.
{
  const r = parse(`\n  ${H}  \n\n  ${V}  \n${A}\n\n`);
  rep.check('whitespace and blank lines are tolerated',
    r.video === V && r.audio === A && r.userAgent === UA);
}

// Nothing usable is a failure the caller must be able to see, not an object
// full of undefined that reaches ffmpeg.
{
  rep.check('no URL at all returns null rather than a broken object', parse(H) === null);
  rep.check('and so does empty output', parse('') === null);
}

rep.done('resolve');
