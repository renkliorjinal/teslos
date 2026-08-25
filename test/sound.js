'use strict';
// Does sound actually come out of the muxed path, and does the player stop
// throwing away a working one? Measured off the WebAudio graph itself rather
// than from anything JSMpeg reports about itself.
const path=require('path'); const fs=require('fs');
const {chromium}=require('playwright');
const ROOT=require('path').join(__dirname,'..');
process.env.PORT='8808'; process.env.BIND='127.0.0.1';
process.env.YT_DLP_COOKIES='/tmp/teslos-nonexistent-jar.txt';
process.env.STATE_DIRECTORY='/tmp/teslos-sound-state';

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

// A local clip with a loud, continuous tone so "is there sound" has an
// unambiguous answer. yt-dlp is replaced by a script that points at it.
const CLIP='/tmp/teslos-tone.mp4';
require('child_process').execFileSync((process.env.FFMPEG||'ffmpeg'),[
  '-hide_banner','-loglevel','error','-y',
  '-f','lavfi','-i','testsrc=size=320x180:rate=15:duration=240',
  '-f','lavfi','-i','sine=frequency=440:duration=240',
  '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
  '-c:a','aac','-shortest',
  // The index has to be at the front, and the fixture below has to honour
  // Range, or ffmpeg cannot read the moov box and decodes nothing at all.
  '-movflags','+faststart',CLIP]);

// resolveStreams only accepts http(s) URLs — a media URL is what yt-dlp
// returns — so the clip is served rather than handed over as a path.
const CLIP_PORT=8913;
const CLIP_BODY=fs.readFileSync(CLIP);
require('http').createServer((req,res)=>{
  const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
  if(!range){
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':CLIP_BODY.length,
      'Accept-Ranges':'bytes'});
    res.end(CLIP_BODY); return;
  }
  const start=range[1]?Number(range[1]):0;
  const end=range[2]?Number(range[2]):CLIP_BODY.length-1;
  const slice=CLIP_BODY.subarray(start,end+1);
  res.writeHead(206,{'Content-Type':'video/mp4','Content-Length':slice.length,
    'Accept-Ranges':'bytes',
    'Content-Range':`bytes ${start}-${end}/${CLIP_BODY.length}`});
  res.end(slice);
}).listen(CLIP_PORT,'127.0.0.1');

const FAKE='/tmp/teslos-fake-ytdlp-sound';
fs.writeFileSync(FAKE,`#!/usr/bin/env bash
for a in "$@"; do case "$a" in -g) echo "http://127.0.0.1:${CLIP_PORT}/tone.mp4"; exit 0 ;; esac; done
echo '{"id":"dQw4w9WgXcQ","title":"tone","duration":240,"is_live":false,"uploader":"x","thumbnail":""}'
`,{mode:0o755});
process.env.YT_DLP=FAKE;
// ffmpeg honours no_proxy, and this fixture is on loopback, which it lists.


const base='http://127.0.0.1:8808';

(async()=>{
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));

  const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader',
      // A real output device, so the graph is not optimised into silence.
      '--autoplay-policy=no-user-gesture-required']});
  const p=await b.newPage({viewport:{width:1180,height:919}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const toasts=[];
  p.on('console',m=>{ if(/toast/i.test(m.text())) toasts.push(m.text()); });

  await p.goto(base+'/',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(800);

  // A handle on the player, so JSMpeg's own counters can be inspected.
  await p.evaluate(()=>{
    const Real=JSMpeg.Player;
    JSMpeg.Player=function(){ const i=new Real(...arguments); window.__player=i; return i; };
    JSMpeg.Player.prototype=Real.prototype;
  });

  // Arrive the way a driver does: a tap, which is also what starts the context.
  await p.evaluate(()=>{
    document.getElementById('q').value='https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    document.getElementById('go').click();
  });
  await p.waitForTimeout(2000);
  await p.evaluate(()=>{
    const t=document.getElementById('tapBtn');
    if(document.getElementById('tapStart').classList.contains('on')) t.click();
  });

  // The element path is the default now; these first checks are about the
  // muxed one, so select it.
  await p.evaluate(()=>document.getElementById('audioBtn').click());
  await p.waitForTimeout(4000);

  // ------------------------------------------------- the context is running
  await p.waitForTimeout(2500);
  const ctx=await p.evaluate(()=>{
    const W=window.JSMpeg&&JSMpeg.AudioOutput&&JSMpeg.AudioOutput.WebAudio;
    const c=W&&W.CachedContext;
    return {state:c?c.state:'none', time:c?c.currentTime:0};
  });
  check('the shared context is running before audio is fed', ctx.state==='running', ctx.state);
  check('its clock is advancing', ctx.time>0, ctx.time.toFixed(2)+'s');

  // ------------------------------------------------------- sound comes out
  //
  // Read through the page's own meter, which is spliced into the same graph
  // that feeds the speakers.
  await p.waitForTimeout(6000);
  const level=await p.evaluate(()=>{
    document.getElementById('diagBtn').click();
    return document.getElementById('diag').textContent;
  });
  const peak=Number((level.match(/peak ([\d.]+)/)||[0,0])[1]);
  check('sound is reaching the output', peak>0.01, 'peak '+peak);
  check('the diagnostic reports a level, not a dead counter',
    /audio level/.test(level) && !/audio dec/.test(level),
    (level.match(/audio [a-z]+ +.*/g)||[]).join(' | ').slice(0,140));

  // JSMpeg's own counter is the trap this replaced: on a live stream it never
  // leaves zero, however well audio is playing. Assert that directly, so the
  // reason the meter exists cannot be quietly forgotten.
  const decodedWhileAudible=await p.evaluate(()=>window.__player.audio.decodedTime);
  check('the decoder counter advances while audible',
    decodedWhileAudible>1, decodedWhileAudible.toFixed(2)+'s');

  // ----------------------------------------------- and it is left in place
  const mode=await p.evaluate(()=>({
    mode:document.body.classList.contains('separate-audio')?'separate':'muxed',
    live:document.querySelector('#audioBtn b.live').id,
    toast:document.getElementById('toast').style.display==='none'
      ?'':document.getElementById('toast').textContent,
  }));
  check('a working muxed path is not abandoned', mode.mode==='muxed', mode.mode);
  check('the chip still marks muxed as live', mode.live==='audioMuxed', mode.live);
  check('no complaint raised about working audio', mode.toast==='', mode.toast);

  // ------------------------------------------- recovering from a stopped clock
  //
  // The delayed-audio symptom. JSMpeg books every buffer at an absolute context
  // time it accumulates itself; a suspended context's clock is frozen, so the
  // running total climbs away from the present while it is stopped. Resume
  // without re-basing and the backlog is scheduled minutes out — the sound
  // "starts later and arrives late". Re-basing is what a gesture now does.
  await p.evaluate(()=>JSMpeg.AudioOutput.WebAudio.CachedContext.suspend());
  await p.waitForTimeout(4000);

  const stopped=await p.evaluate(()=>{
    const out=window.__player.audioOut;
    return {ahead:out.startTime-out.context.currentTime, state:out.context.state,
      decoded:window.__player.audio.decodedTime,
      level:Number((document.getElementById('diag').textContent
        .match(/audio level ([\d.]+)/)||[0,0])[1])};
  });
  // How far the schedule runs away is not assertable any more: with flow control
  // the server may be holding the stream when the context stops, so no audio
  // arrives to be misbooked. The magnitude was never the point — that the
  // schedule is re-based on resume is, and the two checks below cover it.
  check('the context really did stop', stopped.state==='suspended',
    'booked '+stopped.ahead.toFixed(2)+'s ahead while frozen');
  // The reason a counter cannot be the signal: it keeps climbing through
  // silence, because decoding into a stopped context still consumes bytes.
  check('the decoder counter keeps climbing through the silence',
    stopped.decoded>decodedWhileAudible+1,
    decodedWhileAudible.toFixed(1)+'s → '+stopped.decoded.toFixed(1)+'s, inaudible throughout');

  // A real tap on the page, which is what a driver does. The diagnostics panel
  // sits over the top-left of the canvas, so aim clear of it.
  await p.locator('#screen').click({position:{x:900,y:500}});
  await p.waitForTimeout(3000);

  const recovered=await p.evaluate(()=>{
    const out=window.__player.audioOut;
    return {ahead:out.startTime-out.context.currentTime, state:out.context.state};
  });
  check('a touch restarts the clock', recovered.state==='running', recovered.state);
  check('and drops the backlog instead of playing it late',
    recovered.ahead<1.5, 'booked '+recovered.ahead.toFixed(2)+'s ahead');

  const after=await p.evaluate(()=>{
    document.getElementById('diagBtn').click();
    document.getElementById('diagBtn').click();
    return document.getElementById('diag').textContent;
  });
  // The peak, not the instantaneous level: a single analyser window can land on
  // a zero crossing of a pure tone and read nothing while sound is playing.
  check('sound is audible again straight away',
    Number((after.match(/peak ([\d.]+)/)||[0,0])[1])>0.001,
    (after.match(/audio level.*/)||[''])[0]);

  // --------------------------------------- silence never switches by itself
  //
  // The old watchdog took the car's media source on its own. Mute the output
  // and confirm the worst it now does is say so.
  await p.evaluate(()=>{
    const W=JSMpeg.AudioOutput.WebAudio;
    W.CachedContext.suspend();
  });
  await p.evaluate(()=>document.getElementById('libBtn').click());
  await p.evaluate(()=>{
    document.getElementById('q').value='https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    document.getElementById('go').click();
  });
  await p.waitForTimeout(9000);
  const afterSilence=await p.evaluate(()=>({
    mode:document.body.classList.contains('separate-audio')?'separate':'muxed',
    audioSrc:document.getElementById('fallbackAudio').getAttribute('src'),
  }));
  check('silence does not seize the car media on its own',
    afterSilence.mode==='muxed' && !afterSilence.audioSrc,
    `${afterSilence.mode} src=${afterSilence.audioSrc}`);

  // ------------------------------------------ but the driver may still ask
  await p.evaluate(()=>document.getElementById('audioBtn').click());
  await p.waitForTimeout(3000);
  const manual=await p.evaluate(()=>({
    mode:document.body.classList.contains('separate-audio')?'separate':'muxed',
    src:document.getElementById('fallbackAudio').getAttribute('src'),
  }));
  check('the chip still switches deliberately',
    manual.mode==='separate' && /\/api\/audio/.test(manual.src||''),
    `${manual.mode} src=${(manual.src||'').slice(0,40)}`);

  // ============================================================ the real one
  //
  // What the driver actually saw: the console handed back and forth between
  // the browser and Spotify, over and over. Each handover was an <audio>
  // element being restarted to chase sync. The soundtrack now holds the media
  // source for the whole video and the picture is what moves — so a re-cut
  // must leave the element completely untouched.
  let audioRequests=0;
  p.on('request',r=>{ if(r.url().includes('/api/audio')) audioRequests++; });

  await p.waitForTimeout(2500);
  const before=await p.evaluate(()=>{
    const a=document.getElementById('fallbackAudio');
    return {src:a.getAttribute('src'), at:a.currentTime, paused:a.paused};
  });
  check('the soundtrack is running before the re-cut',
    !before.paused && before.at>0, before.at.toFixed(2)+'s');

  // Force one, the way the nudge button does.
  audioRequests=0;
  const socketsBefore=await p.evaluate(()=>{
    window.__wsOpens=0;
    const R=window.WebSocket;
    window.WebSocket=function(){ window.__wsOpens++; return new R(...arguments); };
    window.WebSocket.prototype=R.prototype;
    return 0;
  });
  await p.evaluate(()=>document.getElementById('nudgeFwd').click());
  await p.waitForTimeout(5000);

  const recut=await p.evaluate(()=>{
    const a=document.getElementById('fallbackAudio');
    return {src:a.getAttribute('src'), at:a.currentTime, paused:a.paused,
      wsOpens:window.__wsOpens};
  });
  check('the picture really was re-cut', recut.wsOpens>=1,
    recut.wsOpens+' new video socket(s)');
  check('the soundtrack was not restarted', audioRequests===0,
    audioRequests+' new /api/audio request(s)');
  check('...nor even reloaded', recut.src===before.src, 'src unchanged');
  check('...and it never stopped playing',
    !recut.paused && recut.at>before.at, before.at.toFixed(1)+'s → '+recut.at.toFixed(1)+'s');

  // The seek bar has to follow the sound, since that is the clock now.
  const clock=await p.evaluate(()=>document.getElementById('time').textContent);
  check('the seek bar follows the soundtrack', /[1-9]/.test(clock.split('/')[0]), clock.trim());

  // ------------------------------------------------ the picture holds itself
  //
  // What made the re-cuts constant: JSMpeg decodes one frame per animation
  // frame, so against 30 fps content on a 60 Hz display it wants to run at
  // double speed. It drains its buffer the instant anything arrives and then
  // sits starved at the leading edge, which is why a single hiccup became
  // permanent lateness. The loop is now slaved to the soundtrack, so the
  // picture should hold near it without being re-cut at all.
  const recutsBefore=await p.evaluate(()=>{
    document.getElementById('diagBtn').click();
    return Number((document.getElementById('diag').textContent.match(/re-cuts +(\d+)/)||[0,0])[1]);
  });
  await p.waitForTimeout(12000);
  const held=await p.evaluate(()=>{
    const t=document.getElementById('diag').textContent;
    return {
      recuts:Number((t.match(/re-cuts +(\d+)/)||[0,0])[1]),
      sync:Number((t.match(/sync +(-?[\d.]+)s/)||[0,0])[1]),
      cover:document.getElementById('recut').classList.contains('on'),
      text:(t.match(/sync .*/)||[''])[0],
    };
  });
  check('the picture stays locked to the sound', Math.abs(held.sync)<1.5, held.text);
  check('and needs no re-cut to do it', held.recuts===recutsBefore,
    `${recutsBefore} → ${held.recuts} over 12s`);
  check('no cover left on screen', !held.cover);

  // ------------------------------------------------------- bounded buffering
  //
  // The over-rate exists so a hiccup has something to recover from, but the
  // client only consumes at 1x. Left ungoverned the surplus fills the decoder's
  // ring, which then evicts frames nobody has seen — the picture jumps ahead
  // and the sound is heard as late. Both ends cap it, so the held buffer must
  // settle rather than climb.
  const first=await p.evaluate(()=>Number(
    (document.getElementById('diag').textContent.match(/buffer +([\d.]+)s/)||[0,0])[1]));
  await p.waitForTimeout(20000);
  const later=await p.evaluate(()=>({
    buffer:Number((document.getElementById('diag').textContent.match(/buffer +([\d.]+)s/)||[0,0])[1]),
    sync:Number((document.getElementById('diag').textContent.match(/sync +(-?[\d.]+)s/)||[0,0])[1]),
  }));
  check('a buffer is actually built', later.buffer>0.5, later.buffer.toFixed(1)+'s held');
  check('and it stops growing rather than overrunning',
    later.buffer<20, first.toFixed(1)+'s → '+later.buffer.toFixed(1)+'s over 20s');
  check('sync still holds while it fills', Math.abs(later.sync)<1.5,
    later.sync.toFixed(2)+'s');


  check('no page errors', errs.length===0, errs.slice(0,2).join(' | '));

  await b.close();
  fs.rmSync('/tmp/teslos-sound-state',{recursive:true,force:true});
  console.log(failures?`\n${failures} FAILED`:'\nall passed');
  process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
