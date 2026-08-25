'use strict';
// Both direct-path branches must hand the browser H.264 in a fragmented MP4:
// the copy branch when YouTube has an avc1 rendition, the transcode branch when
// it does not. The second is what a VP9-only video hits, and getting it wrong
// looks like sound over a frozen picture rather than an error.
const http=require('http'),fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const helpers=require('./helpers');
const CLIP=helpers.toneClip(40), FF=helpers.ffmpeg;
process.env.FFMPEG=FF; process.env.PORT='8781';
// Its own state directory: a shared one let one suite's history leak
// into another's assertions.
process.env.STATE_DIRECTORY=require('path').join(require('os').tmpdir(),'teslos-test-directpaths');
require('fs').rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true}); process.env.BIND='127.0.0.1';

const fx=http.createServer((req,res)=>{
  const st=fs.statSync(CLIP);
  const m=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
  if(m){const a=Number(m[1]),b=m[2]?Number(m[2]):st.size-1;
    res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':`bytes ${a}-${b}/${st.size}`,'Content-Length':b-a+1,'Accept-Ranges':'bytes'});
    return fs.createReadStream(CLIP,{start:a,end:b}).pipe(res);}
  res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':st.size,'Accept-Ranges':'bytes'});
  fs.createReadStream(CLIP).pipe(res);
});

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

fx.listen(8991,'127.0.0.1',async()=>{
  const yt=require('../server/youtube.js');
  const URL_=`http://127.0.0.1:8991/clip.mp4`;
  yt.getMetadata=async v=>({videoId:v,title:'clip',duration:40,isLive:false,uploader:'',thumbnail:''});
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));

  async function grab(label){
    const res=await fetch('http://127.0.0.1:8781/api/stream?v=dQw4w9WgXcQ&q=480&t=0');
    const rd=res.body.getReader(); const parts=[]; let n=0; const stop=Date.now()+8000;
    while(Date.now()<stop){
      const {value,done}=await Promise.race([rd.read(),new Promise(r=>setTimeout(()=>r({done:true}),stop-Date.now()))]);
      if(done)break; parts.push(Buffer.from(value)); n+=value.length;
    }
    try{await rd.cancel()}catch(e){}
    const f=`/tmp/direct-${label}.mp4`;
    fs.writeFileSync(f,Buffer.concat(parts));
    const probe=spawnSync(FF,['-hide_banner','-i',f],{encoding:'utf8'}).stderr;
    return {bytes:n,probe};
  }

  // Branch 1: an avc1 rendition exists, so copy.
  yt.resolveStreams=async(id,h,opts)=>({video:URL_,audio:null});
  let r=await grab('copy');
  check('copy branch: H.264 video', /Video: h264/.test(r.probe), (r.probe.match(/Video: [^,]+/)||['?'])[0]);
  check('copy branch: AAC audio', /Audio: aac/.test(r.probe), (r.probe.match(/Audio: [^,]+/)||['?'])[0]);
  check('copy branch: fragmented', /major_brand\s*:\s*iso5/.test(r.probe), `${r.bytes} bytes`);

  // Branch 2: no avc1 rendition, so transcode. The strict resolve fails exactly
  // as it would for a VP9-only video.
  yt.resolveStreams=async(id,h,opts)=>{
    if(opts&&opts.requireAvc) throw new Error('Requested format is not available');
    return {video:URL_,audio:null};
  };
  r=await grab('transcode');
  check('transcode branch: H.264 video', /Video: h264/.test(r.probe), (r.probe.match(/Video: [^,]+/)||['?'])[0]);
  check('transcode branch: AAC audio', /Audio: aac/.test(r.probe), (r.probe.match(/Audio: [^,]+/)||['?'])[0]);
  check('transcode branch: scaled to preset', /854x480/.test(r.probe), (r.probe.match(/\d{3,4}x\d{3,4}/)||['?'])[0]);
  check('transcode branch: fragmented', /major_brand\s*:\s*iso5/.test(r.probe), `${r.bytes} bytes`);

  console.log(failures?`\n${failures} failure(s)\n`:'\nboth direct branches produce playable H.264\n');
  process.exit(failures?1:0);
});
