'use strict';
// The cookie endpoint writes a live credential to disk on a public host, so
// the access rules matter more than the happy path.
const fs=require('fs'),path=require('path');
const JAR='/tmp/teslos-test-cookies.txt';
process.env.PORT='8790';
// Its own state directory: a shared one let one suite's history leak
// into another's assertions.
process.env.STATE_DIRECTORY=require('path').join(require('os').tmpdir(),'teslos-test-cookies');
require('fs').rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true}); process.env.BIND='127.0.0.1';
process.env.YT_DLP_COOKIES=JAR;

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}
const base='http://127.0.0.1:8790';
try{fs.unlinkSync(JAR)}catch(e){}

const VALID=['# Netscape HTTP Cookie File',
  ['.youtube.com','TRUE','/','TRUE','1799999999','SID','abc123'].join('\t'),
  ['.youtube.com','TRUE','/','TRUE','1788888888','HSID','def456'].join('\t'),
  ['#HttpOnly_.youtube.com','TRUE','/','TRUE','0','SSID','ghi'].join('\t')].join('\n');

(async()=>{
  // Disabled by default: no SETUP_TOKEN in the environment.
  delete process.env.SETUP_TOKEN;
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));

  let r=await fetch(base+'/api/cookies');
  let j=await r.json();
  check('disabled without SETUP_TOKEN', r.status===503 && j.ok===false, `${r.status} ${j.error}`);

  r=await fetch(base+'/');
  const html=await r.text();
  check('/ serves the player', r.ok && /id="screen"/.test(html) && /player\.js/.test(html));

  r=await fetch(base+'/setup/');
  check('/setup/ is served', r.ok);

  // Enable it. config reads the token live from the environment.
  const config=require('../server/config.js');
  process.env.SETUP_TOKEN='s3cret-token-value';
  Object.defineProperty(config,'setupToken',{get:()=>process.env.SETUP_TOKEN||'',configurable:true});

  r=await fetch(base+'/api/cookies',{headers:{'x-setup-token':'wrong'}});
  check('wrong token refused', r.status===401, String(r.status));

  r=await fetch(base+'/api/cookies',{method:'POST',
    headers:{'x-setup-token':process.env.SETUP_TOKEN,'Content-Type':'text/plain'},
    body:'.youtube.com TRUE / TRUE 1799999999 SID abc'});
  j=await r.json();
  check('space-separated paste refused with a reason',
    r.status===400 && /TAB/.test(j.error), j.error);

  r=await fetch(base+'/api/cookies',{method:'POST',
    headers:{'x-setup-token':process.env.SETUP_TOKEN,'Content-Type':'text/plain'},
    body:['.example.com','TRUE','/','TRUE','1799999999','X','y'].join('\t')});
  j=await r.json();
  check('non-YouTube jar refused', r.status===400 && /youtube/i.test(j.error), j.error);

  r=await fetch(base+'/api/cookies',{method:'POST',
    headers:{'x-setup-token':process.env.SETUP_TOKEN,'Content-Type':'text/plain'},
    body:VALID});
  j=await r.json();
  check('valid jar accepted', r.ok && j.ok && j.count===3, `${j.count} cookies, ${JSON.stringify(j.domains)}`);
  check('file written owner-only', (fs.statSync(JAR).mode & 0o777)===0o600,
    '0' + (fs.statSync(JAR).mode & 0o777).toString(8));
  check('config sees it without a restart', config.cookies===JAR, config.cookies || '(none)');
  check('metadata never returns cookie values',
    !JSON.stringify(j).includes('abc123') && !JSON.stringify(j).includes('def456'));
  check('earliest expiry reported', /^2026-|^20\d\d-/.test(j.expiresAt||''), j.expiresAt);

  // A header-less export is the common case; it should be repaired, not rejected.
  r=await fetch(base+'/api/cookies',{method:'POST',
    headers:{'x-setup-token':process.env.SETUP_TOKEN,'Content-Type':'text/plain'},
    body:['.youtube.com','TRUE','/','TRUE','1799999999','SID','zzz'].join('\t')});
  check('header-less export accepted', r.ok,
    fs.readFileSync(JAR,'utf8').split('\n')[0]);

  r=await fetch(base+'/api/cookies',{method:'DELETE',headers:{'x-setup-token':process.env.SETUP_TOKEN}});
  check('delete removes the jar', r.ok && !fs.existsSync(JAR));
  check('config sees the removal', config.cookies==='', config.cookies || '(none)');

  console.log(failures?`\n${failures} failure(s)\n`:'\nall cookie-endpoint checks pass\n');
  process.exit(failures?1:0);
})();
