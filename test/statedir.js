'use strict';
// Where the running service writes. The unit mounts the install read-only, so
// anything that lands in the project directory fails with EROFS in production
// while passing every test run from a writable checkout.
const fs=require('fs'); const path=require('path');
const {execFileSync}=require('child_process');
const ROOT=require('path').join(__dirname,'..');

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

const STATE='/tmp/teslos-state-test';
fs.rmSync(STATE,{recursive:true,force:true});

process.env.PORT='8807'; process.env.BIND='127.0.0.1';
process.env.SETUP_TOKEN='testtoken12345678';
process.env.TESLOS_DOMAIN='teslos.example.com';
process.env.STATE_DIRECTORY=STATE;
delete process.env.YT_DLP_COOKIES;
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;

const base='http://127.0.0.1:8807';
const auth={'x-setup-token':process.env.SETUP_TOKEN};
const get=(p,o)=>fetch(base+p,o).then(async r=>({status:r.status,body:await r.json()}));

// --------------------------------------------------------------- the unit
//
// The guarantee only holds if the unit really does grant a writable state
// directory and really does keep the install read-only.
const unit=fs.readFileSync(path.join(ROOT,'deploy/teslos.service'),'utf8');
check('unit keeps the install read-only', /^ProtectSystem=strict$/m.test(unit));
check('unit grants a state directory', /^StateDirectory=teslos$/m.test(unit));
check('unit no longer writes inside the install',
  !/^ReadWritePaths=\/opt\/teslos/m.test(unit),
  (unit.match(/^ReadWritePaths=.*/m)||['none'])[0]);
// systemd's own parser is the authority on whether this unit is valid.
try {
  execFileSync('systemd-analyze',['verify',path.join(ROOT,'deploy/teslos.service')],
    {stdio:['ignore','pipe','pipe']});
  check('systemd accepts the unit', true, 'no complaints at all');
} catch(e){
  const out=(e.stderr||'').toString();
  // Neither a missing service account nor a missing node belongs to this box's
  // idea of the unit; setup.sh rewrites ExecStart and creates the user.
  const real=out.split('\n').filter(l=>l.trim()
    && !/Unknown user|Unknown group|is not executable/i.test(l));
  check('systemd accepts the unit', real.length===0,
    real.join(' ')||'(only this box\'s missing user/node)');
}

(async()=>{
  const config=require('../server/config.js');
  check('state directory created on boot', fs.existsSync(STATE), config.stateDir);
  check('cookie jar lands in the state directory',
    config.cookiesPath===path.join(STATE,'cookies.txt'), config.cookiesPath);
  check('probe reports land in the state directory',
    config.reportsDir===path.join(STATE,'probe-reports'), config.reportsDir);
  check('nothing writable is aimed at the install',
    ![config.cookiesPath,config.reportsDir].some(p=>p.startsWith(ROOT+path.sep)),
    `${config.cookiesPath} ${config.reportsDir}`);

  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));

  // Every write the setup page can trigger, through the real endpoints.
  let r=await get('/api/auth/config',{method:'POST',
    headers:{...auth,'Content-Type':'application/json'},
    body:JSON.stringify({clientId:'123.apps.googleusercontent.com',
      clientSecret:'GOCSPX-abcdefghij'})});
  check('google credentials save', r.status===200 && r.body.configured===true,
    r.body.error||'');
  check('...into the state directory',
    fs.existsSync(path.join(STATE,'google-client.json')));

  const jar='# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n';
  r=await get('/api/cookies',{method:'POST',
    headers:{...auth,'Content-Type':'text/plain'},body:jar});
  check('cookie jar saves', r.status===200 && r.body.present===true, r.body.error||'');
  check('...into the state directory', fs.existsSync(path.join(STATE,'cookies.txt')));

  r=await get('/api/probe-report',{method:'POST',
    headers:{'Content-Type':'application/json'},body:'{"x":1}'});
  check('probe report saves', r.body.ok===true);
  check('...into the state directory',
    fs.readdirSync(path.join(STATE,'probe-reports')).length===1);

  // ------------------------------------------------------- read-only install
  //
  // The production failure, reproduced. chmod would not do it — these tests
  // run as root, which bypasses the bits — and the real cause was a read-only
  // mount rather than permissions anyway, so the errno is what gets injected.
  const realWrite=fs.writeFileSync;
  fs.writeFileSync=()=>{
    const err=new Error("EROFS: read-only file system, open '/opt/teslos/google-client.json'");
    err.code='EROFS';
    throw err;
  };
  r=await get('/api/auth/config',{method:'POST',
    headers:{...auth,'Content-Type':'application/json'},
    body:JSON.stringify({clientId:'456.apps.googleusercontent.com',
      clientSecret:'GOCSPX-klmnopqrst'})});
  check('a read-only state directory explains itself',
    r.status>=400 && /systemctl/.test(r.body.error||''), r.body.error);
  check('...and does not just print the errno',
    !/^EROFS/.test(r.body.error||''), r.body.error);

  // The cookie jar is written by a different path and must say the same thing.
  r=await get('/api/cookies',{method:'POST',
    headers:{...auth,'Content-Type':'text/plain'},body:jar});
  fs.writeFileSync=realWrite;
  check('the cookie upload explains it too',
    r.status>=400 && /systemctl/.test(r.body.error||''), r.body.error);

  fs.rmSync(STATE,{recursive:true,force:true});
  console.log(failures?`\n${failures} FAILED`:'\nall passed');
  process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
