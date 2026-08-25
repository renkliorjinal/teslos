'use strict';
// The capacity accounting: a slot must be held across the resolve, released
// exactly once, and reclaimed from a stream that has gone quiet.
const path=require('path');
process.env.MAX_SESSIONS='2';

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

const yt=require('../server/youtube.js');
const stream=require('../server/stream.js');

// A resolve that takes a while is the window the old code left open.
let resolving=0, maxConcurrentResolves=0;
yt.resolveStreams=async()=>{
  resolving++; maxConcurrentResolves=Math.max(maxConcurrentResolves,resolving);
  await new Promise(r=>setTimeout(r,1200));
  resolving--;
  return {video:'http://127.0.0.1:9/never.mp4',audio:null};
};

(async()=>{
  check('starts empty', stream.sessionCount()===0, String(stream.sessionCount()));

  // Two requests in flight at once must fill the two slots immediately, before
  // either resolve finishes — otherwise a third would slip past the check.
  const a=stream.startVideoStream({videoId:'aaaaaaaaaaa',quality:360});
  const b=stream.startVideoStream({videoId:'bbbbbbbbbbb',quality:360});
  await new Promise(r=>setTimeout(r,200));
  check('slots taken during the resolve, not after',
    stream.sessionCount()===2 && stream.atCapacity(),
    `${stream.sessionCount()} in use, atCapacity=${stream.atCapacity()}`);

  const sessions=await Promise.all([a,b]);
  check('both resolved into real sessions', stream.sessionCount()===2, String(stream.sessionCount()));

  sessions.forEach(s=>s.stop());
  await new Promise(r=>setTimeout(r,300));
  check('stopping frees the slots', stream.sessionCount()===0, String(stream.sessionCount()));

  // Stopping twice must not drive the count negative and hand out phantom slots.
  sessions.forEach(s=>s.stop());
  check('double stop is harmless', stream.sessionCount()===0, String(stream.sessionCount()));

  // A resolve that throws must not strand its reservation.
  yt.resolveStreams=async()=>{ throw new Error('nope'); };
  await stream.startVideoStream({videoId:'ccccccccccc',quality:360}).catch(()=>{});
  await new Promise(r=>setTimeout(r,200));
  check('failed resolve releases its slot', stream.sessionCount()===0, String(stream.sessionCount()));

  console.log(failures?`\n${failures} failure(s)\n`:'\nslot accounting is sound\n');
  process.exit(failures?1:0);
})();
