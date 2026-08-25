'use strict';
// Signing in with Google from a phone: the credential handshake, the guards on
// it, and whether a signed-in server actually fills the grid.
const fs=require('fs'); const path=require('path');
const {chromium}=require('playwright');
const ROOT=require('path').join(__dirname,'..');
process.env.PORT='8806'; process.env.BIND='127.0.0.1';
process.env.YT_DLP_COOKIES='/tmp/teslos-nonexistent-jar.txt';
// Its own state directory, or history written by another suite leaks in.
process.env.STATE_DIRECTORY='/tmp/teslos-oauth-state';
require('fs').rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true});
process.env.SETUP_TOKEN='testtoken12345678';
process.env.TESLOS_DOMAIN='teslos.example.com';
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;

const TOKENS=path.join(process.env.STATE_DIRECTORY,'google-tokens.json');
const CLIENT=path.join(process.env.STATE_DIRECTORY,'google-client.json');
for(const f of [TOKENS,CLIENT]) { try{fs.unlinkSync(f);}catch{} }

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

// Google, stubbed. oauth.js calls bare fetch(), so replacing the global is
// enough — and it means the token exchange and the Data API are exercised for
// real up to the wire.
const real=globalThis.fetch;
let apiCalls=[];
globalThis.fetch=async (url,init)=>{
  const u=String(url);
  if(u.startsWith('https://oauth2.googleapis.com/token')){
    const body=new URLSearchParams(init.body);
    if(body.get('grant_type')==='authorization_code'){
      if(body.get('code')!=='goodcode') return json({error:'invalid_grant',error_description:'bad code'},400);
      return json({access_token:'at-1',refresh_token:'rt-1',expires_in:3600});
    }
    return json({access_token:'at-2',expires_in:3600});
  }
  if(u.startsWith('https://www.googleapis.com/youtube/v3/')){
    apiCalls.push(u);
    const ep=u.slice('https://www.googleapis.com/youtube/v3/'.length).split('?')[0];
    if(ep==='subscriptions') return json({items:[
      {snippet:{resourceId:{channelId:'UC_a'}}},{snippet:{resourceId:{channelId:'UC_b'}}}]});
    if(ep==='channels') return json({items:[
      {contentDetails:{relatedPlaylists:{uploads:'UU_a'}}},
      {contentDetails:{relatedPlaylists:{uploads:'UU_b'}}}]});
    if(ep==='playlistItems') return json({items:[0,1,2].map(i=>({snippet:{
      title:'Yükleme '+i, publishedAt:'2026-08-0'+(i+1)+'T00:00:00Z',
      videoOwnerChannelTitle:'Kanal', resourceId:{videoId:'vvvvvvvvvv'+i}}}))});
    if(ep==='videos') return json({items:[0,1,2].map(i=>({
      id:'vvvvvvvvvv'+i, snippet:{title:'Yükleme '+i, channelTitle:'Kanal'},
      contentDetails:{duration:'PT4M1'+i+'S'}}))});
    return json({items:[]});
  }
  return real(url,init);
};
function json(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
}

const base='http://127.0.0.1:8806';
const auth={'x-setup-token':process.env.SETUP_TOKEN};
const get=(p,o)=>fetch(base+p,o).then(async r=>({status:r.status,body:await r.json()}));

(async()=>{
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));

  // ---------------------------------------------------------------- unset
  let r=await get('/api/auth/status');
  check('status readable without a token', r.body.ok===true);
  check('starts unconfigured', r.body.configured===false && r.body.signedIn===false);
  check('redirect built from TESLOS_DOMAIN',
    r.body.redirectUri==='https://teslos.example.com/api/auth/callback', r.body.redirectUri);

  r=await get('/api/health');
  check('health offers only the local lists when signed out',
    JSON.stringify(r.body.feeds)==='["history","trending"]', JSON.stringify(r.body.feeds));

  // ------------------------------------------------------------- the guards
  r=await get('/api/auth/config',{method:'POST',
    headers:{'Content-Type':'application/json'},body:'{}'});
  check('config refuses without the setup token', r.status===401, JSON.stringify(r.body));

  r=await get('/api/auth/config',{method:'POST',
    headers:{...auth,'Content-Type':'application/json'},
    body:JSON.stringify({clientId:'not-a-google-id',clientSecret:'GOCSPX-abcdefghij'})});
  check('a mistyped client id is caught here, not on the consent screen',
    r.status===400 && /googleusercontent/.test(r.body.error), r.body.error);

  r=await get('/api/auth/config',{method:'POST',
    headers:{...auth,'Content-Type':'application/json'},
    body:JSON.stringify({clientId:'123.apps.googleusercontent.com',clientSecret:'x'})});
  check('a truncated secret is caught too', r.status===400, r.body.error);

  let raw=await fetch(base+'/api/auth/start',{redirect:'manual'});
  check('sign-in link refuses without the token', raw.status===401, String(raw.status));

  // ------------------------------------------------------------- configured
  r=await get('/api/auth/config',{method:'POST',
    headers:{...auth,'Content-Type':'application/json'},
    body:JSON.stringify({clientId:'123.apps.googleusercontent.com',
      clientSecret:'GOCSPX-abcdefghij'})});
  check('valid credentials accepted', r.status===200 && r.body.configured===true);
  check('credentials stored owner-only',
    (fs.statSync(CLIENT).mode & 0o777)===0o600, (fs.statSync(CLIENT).mode & 0o777).toString(8));
  check('secret is never handed back', !JSON.stringify(r.body).includes('GOCSPX'));

  raw=await fetch(base+`/api/auth/start?k=${process.env.SETUP_TOKEN}`,{redirect:'manual'});
  const target=new URL(raw.headers.get('location'));
  check('sign-in redirects to Google', raw.status===302
    && target.host==='accounts.google.com', target.host);
  check('asks for a refresh token', target.searchParams.get('access_type')==='offline'
    && target.searchParams.get('prompt')==='consent');
  check('scope is read-only',
    target.searchParams.get('scope')==='https://www.googleapis.com/auth/youtube.readonly');
  const state=target.searchParams.get('state');
  check('carries an anti-forgery state', /^[0-9a-f]{32}$/.test(state||''), state);

  // -------------------------------------------------------------- callback
  let page=await fetch(base+'/api/auth/callback?code=goodcode&state=deadbeef');
  check('a forged state is refused', page.status===400);
  check('...with a page, not JSON',
    /text\/html/.test(page.headers.get('content-type')), page.headers.get('content-type'));

  page=await fetch(base+`/api/auth/callback?error=access_denied&state=${state}`);
  check('a declined consent is reported', page.status===400
    && /iptal/.test(await page.text()));

  // The state above was spent by the error branch, so take a fresh one.
  raw=await fetch(base+`/api/auth/start?k=${process.env.SETUP_TOKEN}`,{redirect:'manual'});
  const state2=new URL(raw.headers.get('location')).searchParams.get('state');

  page=await fetch(base+`/api/auth/callback?code=badcode&state=${state2}`);
  check('a bad code fails with Google\'s reason', page.status===400
    && /bad code/.test(await page.text()));

  raw=await fetch(base+`/api/auth/start?k=${process.env.SETUP_TOKEN}`,{redirect:'manual'});
  const state3=new URL(raw.headers.get('location')).searchParams.get('state');
  page=await fetch(base+`/api/auth/callback?code=goodcode&state=${state3}`);
  const html=await page.text();
  check('a good code signs in', page.status===200 && /bağlandı/.test(html));
  check('the page says what will not work',
    /geçmiş/i.test(html), (html.match(/[^>]*geçmiş[^<]*/i)||['missing'])[0].trim().slice(0,70));
  check('tokens stored owner-only',
    (fs.statSync(TOKENS).mode & 0o777)===0o600, (fs.statSync(TOKENS).mode & 0o777).toString(8));

  page=await fetch(base+`/api/auth/callback?code=goodcode&state=${state3}`);
  check('a replayed state is refused', page.status===400);

  // ------------------------------------------------------------------ feeds
  r=await get('/api/health');
  check('health now offers the Google feeds',
    ['subscriptions','liked','playlists','trending'].every(f=>r.body.feeds.includes(f)),
    JSON.stringify(r.body.feeds));
  check('health reports the Google sign-in', r.body.google===true);

  apiCalls=[];
  r=await get('/api/feed?name=subscriptions');
  check('subscriptions come from the API, not yt-dlp',
    r.body.ok===true && r.body.items.length===6, JSON.stringify(r.body).slice(0,120));
  check('newest first',
    r.body.items[0].publishedAt>=r.body.items[r.body.items.length-1].publishedAt);
  check('durations filled in from contentDetails',
    r.body.items.every(i=>i.duration>0), String(r.body.items[0].duration));
  check('one channels call, not one per channel',
    apiCalls.filter(u=>u.includes('/channels')).length===1,
    apiCalls.map(u=>u.split('/').pop().split('?')[0]).join(','));

  r=await get('/api/feed?name=liked');
  check('liked parses ISO durations',
    r.body.ok===true && r.body.items[1].duration===4*60+11, JSON.stringify(r.body.items[1]));

  // Watch history is the one thing no Google credential reaches, so it is served
  // from what this server saw itself — which means it answers rather than
  // refusing, just with nothing in it yet.
  r=await get('/api/feed?name=history');
  check('history is served locally, since no API reaches YouTube\'s',
    r.body.ok===true && r.body.items.length===0, JSON.stringify(r.body).slice(0,80));

  // A jar that has lapsed fails exactly like a jar that was never uploaded. The
  // Google sign-in is right there, so it should answer rather than the driver
  // getting an error for a list the server can in fact fill.
  // config reads YT_DLP_COOKIES once but checks the file's existence on every
  // call, so creating it at the configured path is what flips the switch.
  const JAR=process.env.YT_DLP_COOKIES;
  fs.writeFileSync(JAR,'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n');
  const yt=require('../server/youtube.js');
  const realFeed=yt.feed;
  yt.feed=async()=>{throw new Error('Sign in to confirm you\'re not a bot');};
  r=await get('/api/feed?name=subscriptions');
  check('a stale jar falls through to Google instead of failing',
    r.body.ok===true && r.body.items.length===6, r.body.error||`${r.body.items.length} items`);
  r=await get('/api/feed?name=history');
  check('...and a stale jar falls through to the local history too',
    r.body.ok===true, r.body.error||'served locally');
  yt.feed=realFeed;
  fs.unlinkSync(JAR);

  // ------------------------------------------------------------------- page
  const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p=await b.newPage({viewport:{width:1180,height:919}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));

  await p.goto(base+'/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card',{timeout:15000});
  const boot=await p.evaluate(()=>({
    signedIn:document.getElementById('signedIn').textContent,
    tabs:[...document.querySelectorAll('.tab')].map(t=>t.dataset.feed),
    active:document.querySelector('.tab.on')?.dataset.feed,
    cards:document.querySelectorAll('.card').length,
  }));
  check('player says Google is signed in', /Google/.test(boot.signedIn), boot.signedIn);
  check('unservable tabs are removed, not left to fail',
    !boot.tabs.includes('recommended') && !boot.tabs.includes('watch_later'),
    boot.tabs.join(','));
  check('the servable ones are kept',
    ['subscriptions','liked','playlists','trending'].every(f=>boot.tabs.includes(f)),
    boot.tabs.join(','));
  check('opens on the richest list it can fill', boot.active==='subscriptions', boot.active);
  check('grid is populated on arrival', boot.cards===6, String(boot.cards));

  // The setup page is where all of this is driven from on a phone.
  await p.goto(base+`/setup/?k=${process.env.SETUP_TOKEN}`,{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1200);
  const setup=await p.evaluate(()=>({
    redirect:document.getElementById('redirect').textContent,
    state:document.getElementById('gstate').textContent,
  }));
  check('setup shows the exact redirect URI to register',
    setup.redirect==='https://teslos.example.com/api/auth/callback', setup.redirect);
  check('setup reports the live sign-in', /Bağlı/.test(setup.state), setup.state.trim());

  // -------------------------------------------------------------- sign out
  r=await get('/api/auth/logout',{method:'POST',headers:auth});
  check('sign-out clears the tokens', r.body.signedIn===false && !fs.existsSync(TOKENS));
  r=await get('/api/feed?name=subscriptions');
  check('and the feed goes back to refusing', r.body.ok===false, r.body.error);

  check('no page errors', errs.length===0, errs.join(' | '));

  await b.close();
  for(const f of [TOKENS,CLIENT]) { try{fs.unlinkSync(f);}catch{} }
  console.log(failures?`\n${failures} FAILED`:'\nall passed');
  process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
