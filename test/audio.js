'use strict';
// Two claims: the audio companion has its own budget, and a resolve is not
// repeated for the same video. Both go through the real code — a stub for
// resolveStreams would bypass the very cache under test.
const http=require('http'),fs=require('fs'),path=require('path');
const helpers=require('./helpers');
const CLIP=helpers.toneClip(40);
const CALLS=path.join(helpers.FIXTURES,'ytdlp-calls-audio');
fs.writeFileSync(CALLS,'');
process.env.YTDLP_CALLS=CALLS;
// Counts its own invocations, which is how the resolve cache is observed from
// outside rather than by reaching into the module under test.
helpers.fakeYtDlp({url:'http://127.0.0.1:8912/clip.mp4',duration:40,countFile:CALLS});
process.env.PORT='8780';
// Its own state directory: a shared one let one suite's history leak
// into another's assertions.
process.env.STATE_DIRECTORY=require('path').join(require('os').tmpdir(),'teslos-test-audio');
require('fs').rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true}); process.env.BIND='127.0.0.1'; process.env.MAX_SESSIONS='1';

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}
const calls=()=>fs.readFileSync(CALLS,'utf8').trim().split('\n').filter(Boolean).length;

const fx=http.createServer((req,res)=>{
  const st=fs.statSync(CLIP);
  const m=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
  if(m){const a=Number(m[1]),b=m[2]?Number(m[2]):st.size-1;
    res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':`bytes ${a}-${b}/${st.size}`,'Content-Length':b-a+1,'Accept-Ranges':'bytes'});
    return fs.createReadStream(CLIP,{start:a,end:b}).pipe(res);}
  res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':st.size,'Accept-Ranges':'bytes'});
  fs.createReadStream(CLIP).pipe(res);
});

fx.listen(8912,'127.0.0.1',async()=>{
  const stream=require('../server/stream.js');
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));
  const base='http://127.0.0.1:8780';

  async function hold(url,ms){
    const res=await fetch(url);
    if(!res.ok) return {status:res.status,n:0,cancel:async()=>{}};
    const rd=res.body.getReader(); let n=0; const stop=Date.now()+ms;
    while(Date.now()<stop){
      const {value,done}=await Promise.race([rd.read(),new Promise(r=>setTimeout(()=>r({done:true}),stop-Date.now()))]);
      if(done)break; n+=value.length;
    }
    return {status:res.status,n,cancel:()=>rd.cancel().catch(()=>{})};
  }

  const before=calls();
  const a1=await hold(base+'/api/audio?v=dQw4w9WgXcQ&t=0',2500);
  check('audio streams', a1.status===200 && a1.n>5000, `${a1.status}, ${a1.n} bytes`);
  check('audio pool is separate from video', stream.atCapacity()===false,
    `video slots in use: ${stream.sessionCount()}`);

  // The same video again must come from the cache, not a second lookup.
  const midway=calls();
  const a2=await hold(base+'/api/audio?v=dQw4w9WgXcQ&t=10',2000); // overlaps a1, as a drift restart does
  check('second audio request served', a2.status===200, String(a2.status));
  check('resolve reused from cache', calls()===midway,
    `${calls()-midway} extra yt-dlp call(s)`);
  check('the first request did resolve once', midway-before===1,
    `${midway-before} call(s)`);

  await a1.cancel(); await a2.cancel();
  await new Promise(r=>setTimeout(r,600));
  check('audio pool drains when the clients leave', stream.audioAtCapacity()===false);

  fx.close();
  console.log(failures?`\n${failures} failure(s)\n`:'\naudio budget and resolve cache hold\n');
  process.exit(failures?1:0);
});
