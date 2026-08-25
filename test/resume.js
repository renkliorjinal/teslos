'use strict';
// Watch history and picking up where you left off, plus what happens when the
// link goes away mid-video.
const fs=require('fs'); const path=require('path');
const {chromium}=require('playwright');
const ROOT=require('path').join(__dirname,'..');
const STATE='/tmp/teslos-resume-state';
fs.rmSync(STATE,{recursive:true,force:true});

process.env.PORT='8810'; process.env.BIND='127.0.0.1';
process.env.YT_DLP_COOKIES='/tmp/teslos-nonexistent-jar.txt';
process.env.STATE_DIRECTORY=STATE;
process.env.SETUP_TOKEN='testtoken12345678';

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

// Deliberately incompressible. A smooth test pattern transcodes to a fraction
// of the bitrate cap, so the client's fixed-byte ring buffer would hold minutes
// of it and no outage this test has the patience for would ever exhaust the
// buffer. Noise makes the MPEG1 encoder spend its whole allowance, which is what
// real video does.
const CLIP='/tmp/teslos-resume-noise.mp4';
if(!fs.existsSync(CLIP)){
  require('child_process').execFileSync((process.env.FFMPEG||'ffmpeg'),[
    '-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc=size=320x180:rate=15:duration=400',
    '-f','lavfi','-i','sine=frequency=440:duration=400',
    '-vf','noise=alls=60:allf=t+u',
    '-c:v','libx264','-preset','ultrafast',
    '-b:v','2500k','-maxrate','2500k','-bufsize','5000k','-pix_fmt','yuv420p',
    '-c:a','aac','-shortest','-movflags','+faststart',CLIP],{timeout:180000});
}

// A fixture the test can cut off mid-stream, which is the point of half of it.
// Streamed from disk rather than held in memory — the noise clip is large.
const CLIP_SIZE=fs.statSync(CLIP).size;
let serving=true;
const openSockets=new Set();
require('http').createServer((req,res)=>{
  openSockets.add(res.socket);
  res.socket.on('close',()=>openSockets.delete(res.socket));
  if(!serving){ res.socket.destroy(); return; }
  const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
  const start=range&&range[1]?Number(range[1]):0;
  const end=range&&range[2]?Number(range[2]):CLIP_SIZE-1;
  res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes',
    'Content-Length':end-start+1,
    ...(range?{'Content-Range':`bytes ${start}-${end}/${CLIP_SIZE}`}:{})});
  const body=fs.createReadStream(CLIP,{start,end});
  body.on('error',()=>res.destroy());
  res.on('close',()=>body.destroy());
  body.pipe(res);
}).listen(8915,'127.0.0.1');

const FAKE='/tmp/teslos-fake-ytdlp-resume';
fs.writeFileSync(FAKE,`#!/usr/bin/env bash
for a in "$@"; do case "$a" in -g) echo "http://127.0.0.1:8915/clip.mp4"; exit 0 ;; esac; done
echo '{"id":"dQw4w9WgXcQ","title":"Uzun klip","duration":400,"is_live":false,"uploader":"Kanal","thumbnail":""}'
`,{mode:0o755});
process.env.YT_DLP=FAKE;

const base='http://127.0.0.1:8810';
const get=(p,o)=>fetch(base+p,o).then(async r=>({status:r.status,body:await r.json()}));

(async()=>{
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));

  // ================================================================ history
  let r=await get('/api/history');
  check('history starts empty', r.body.ok===true && r.body.items.length===0);

  r=await get('/api/health');
  check('the history tab is always on offer', r.body.feeds.includes('history'),
    JSON.stringify(r.body.feeds));

  // A glance is not a watch.
  await get('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({videoId:'dQw4w9WgXcQ',title:'Uzun klip',duration:400,position:3,watched:3})});
  r=await get('/api/history');
  check('a video barely opened is not remembered', r.body.items.length===0,
    JSON.stringify(r.body.items));

  await get('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({videoId:'dQw4w9WgXcQ',title:'Uzun klip',duration:400,
      uploader:'Kanal',position:120,watched:120})});
  r=await get('/api/history');
  check('a watched one is', r.body.items.length===1 && r.body.items[0].position===120,
    JSON.stringify(r.body.items[0]));

  r=await get('/api/meta?v=dQw4w9WgXcQ');
  check('metadata carries the resume point', r.body.resumeAt===120, String(r.body.resumeAt));

  r=await get('/api/feed?name=history');
  check('the history feed serves it without a cookie jar',
    r.body.ok===true && r.body.items[0].videoId==='dQw4w9WgXcQ', JSON.stringify(r.body).slice(0,90));

  // Finished is not resumable, and neither is the first half-minute.
  await get('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({videoId:'dQw4w9WgXcQ',duration:400,position:395,watched:395})});
  r=await get('/api/meta?v=dQw4w9WgXcQ');
  check('a finished video restarts rather than resuming', r.body.resumeAt===0,
    String(r.body.resumeAt));

  await get('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({videoId:'aaaaaaaaaaa',title:'Kısa',duration:400,position:12,watched:40})});
  r=await get('/api/meta?v=aaaaaaaaaaa').catch(()=>({body:{}}));
  check('nor does the first half-minute', (r.body.resumeAt||0)===0, String(r.body.resumeAt));

  r=await get('/api/history');
  check('newest first', r.body.items[0].videoId==='aaaaaaaaaaa',
    r.body.items.map(i=>i.videoId).join(','));

  // Writes are debounced, so give the file a moment to exist.
  await new Promise(r=>setTimeout(r,3500));
  check('stored owner-only',
    (fs.statSync(path.join(STATE,'history.json')).mode & 0o777)===0o600);

  // ================================================================= player
  const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required']});
  const p=await b.newPage({viewport:{width:1180,height:919}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));

  // Back to a resumable position for the player half.
  await get('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({videoId:'dQw4w9WgXcQ',duration:400,position:180,watched:180})});

  await p.goto(base+'/',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1200);

  const tabs=await p.evaluate(()=>[...document.querySelectorAll('.tab')].map(t=>t.dataset.feed));
  check('the picker offers history', tabs.includes('history'), tabs.join(','));

  await p.evaluate(()=>document.querySelector('.tab[data-feed="history"]').click());
  await p.waitForSelector('.card',{timeout:15000});
  const grid=await p.evaluate(()=>{
    const card=[...document.querySelectorAll('.card')]
      .find(c=>/Uzun klip/.test(c.textContent));
    const bar=card&&card.querySelector('.seen i');
    return {found:!!card, width:bar?bar.style.width:null};
  });
  check('history renders in the grid', grid.found);
  check('with how far it got', grid.width==='45%', String(grid.width));

  // -------------------------------------------------------------- resuming
  await p.evaluate(()=>{
    document.getElementById('q').value='https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    document.getElementById('go').click();
  });
  await p.waitForTimeout(6000);
  const resumed=await p.evaluate(()=>({
    toast:document.getElementById('toast').textContent,
    hasRestart:!!document.querySelector('#toast button'),
    time:document.getElementById('time').textContent,
  }));
  check('it resumes where it was left', /3:00/.test(resumed.toast), resumed.toast.slice(0,40));
  check('and offers to start over instead', resumed.hasRestart);
  check('the clock starts from there', /^3:0/.test(resumed.time.trim()), resumed.time.trim());

  // ---------------------------------------------------------- losing the link
  //
  // The asymmetry that made this necessary: the soundtrack is buffered minutes
  // deep by the browser, the picture only seconds. Cut the feed and the sound
  // would happily play on over a frozen frame.
  const soundBefore=await p.evaluate(()=>{
    const a=document.getElementById('fallbackAudio');
    return {at:a.currentTime, paused:a.paused};
  });
  check('sound is playing before the cut', !soundBefore.paused && soundBefore.at>0,
    soundBefore.at.toFixed(1)+'s');

  serving=false;
  for(const s of openSockets) s.destroy();

  // First the cushion does its job. A cut of a few seconds is exactly what the
  // buffer exists for, and stopping playback for one would be a regression.
  await p.waitForTimeout(8000);
  const riding=await p.evaluate(()=>{
    const a=document.getElementById('fallbackAudio');
    return {paused:a.paused,
      cover:document.getElementById('recut').classList.contains('on'),
      diag:(function(){
        document.getElementById('diagBtn').click();
        const t=document.getElementById('diag').textContent;
        document.getElementById('diagBtn').click();
        return (t.match(/buffer.*/)||[''])[0];
      })()};
  });
  check('a short cut is ridden out by the buffer', !riding.paused && !riding.cover,
    riding.diag.trim());

  // Then it runs dry, and playback has to stop rather than let the soundtrack
  // run on alone. Sampled over the window rather than at an instant: the server
  // here stays reachable while only the upstream is dead, so the player
  // legitimately retries — what must not happen is playback simply continuing.
  let sawWaiting=false, sawCover='';
  const wallStart=Date.now();
  const audioAtOutageStart=await p.evaluate(()=>document.getElementById('fallbackAudio').currentTime);
  for(let i=0;i<70;i++){
    const now=await p.evaluate(()=>({
      paused:document.getElementById('fallbackAudio').paused,
      cover:document.getElementById('recut').classList.contains('on'),
      text:document.getElementById('recut').textContent,
    }));
    if(now.paused && now.cover){ sawWaiting=true; sawCover=now.text; }
    await p.waitForTimeout(700);
  }
  const wallElapsed=(Date.now()-wallStart)/1000;
  const audioAdvanced=(await p.evaluate(()=>document.getElementById('fallbackAudio').currentTime))
    -audioAtOutageStart;

  const during={paused:sawWaiting, coverText:sawCover,
    status:await p.evaluate(()=>document.getElementById('status').textContent)};
  check('playback stops instead of playing on', sawWaiting,
    sawWaiting ? 'entered the waiting state' : 'never entered the waiting state');
  check('and says why', /nternet|ağlantı bekleniyor/.test(during.coverText), during.coverText);
  // Negative means the element was torn down and restarted by a retry, which
  // is just as much proof that it did not play straight through.
  check('the soundtrack does not run on alone',
    audioAdvanced < wallElapsed * 0.6,
    `sound advanced ${audioAdvanced.toFixed(0)}s over ${wallElapsed.toFixed(0)}s of outage`);

  // --------------------------------------------------------- and comes back
  serving=true;
  await p.waitForTimeout(45000);
  const after=await p.evaluate(()=>{
    const a=document.getElementById('fallbackAudio');
    return {paused:a.paused, at:a.currentTime,
      cover:document.getElementById('recut').classList.contains('on'),
      time:document.getElementById('time').textContent};
  });
  check('it resumes by itself when the link returns', !after.paused,
    'audio at '+after.at.toFixed(1)+'s');
  check('the cover is gone', !after.cover);
  check('and it carries on from about where it stopped',
    /^[34]:/.test(after.time.trim()), `${resumed.time.trim()} → ${after.time.trim()}`);

  // The position reached should have been recorded along the way.
  r=await get('/api/history');
  const entry=r.body.items.find(i=>i.videoId==='dQw4w9WgXcQ');
  check('progress was recorded while watching', entry && entry.position>=180,
    entry?entry.position+'s':'missing');

  check('no page errors', errs.length===0, errs.slice(0,2).join(' | '));

  await b.close();
  fs.rmSync(STATE,{recursive:true,force:true});
  console.log(failures?`\n${failures} FAILED`:'\nall passed');
  process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
