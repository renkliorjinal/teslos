'use strict';
// The browse grid and the feed API: personalised tabs must say "sign in" rather
// than showing an empty page, and cards must carry real thumbnails.
const path=require('path');
const {chromium}=require('playwright');
process.env.PORT='8800'; process.env.BIND='127.0.0.1';
process.env.YT_DLP_COOKIES='/tmp/teslos-nonexistent-jar.txt';
// Its own state directory, or history written by another suite leaks in.
process.env.STATE_DIRECTORY='/tmp/teslos-browse-state';
require('fs').rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true});

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

const yt=require('../server/youtube.js');
const FAKE=[...Array(8)].map((_,i)=>({
  videoId:'aaaaaaaaaa'+i, title:'Video '+i, duration:60+i*30, uploader:'Kanal '+i}));

(async()=>{
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));
  const base='http://127.0.0.1:8800';

  // Without a jar, an account feed must refuse with a reason.
  let r=await fetch(base+'/api/feed?name=subscriptions');
  let j=await r.json();
  check('account feed refuses without cookies', r.status===502 && /giriş/i.test(j.error), j.error);

  r=await fetch(base+'/api/feed?name=nonsense');
  j=await r.json();
  check('unknown feed rejected', j.ok===false && /Bilinmeyen/.test(j.error), j.error);

  const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p=await b.newPage({viewport:{width:1180,height:919}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));

  // Stubbed before the page loads: Chromium stalls a second identical GET
  // behind the first one still in flight, so the boot request has to be the one
  // that exercises the refusal — clicking the same tab again proves nothing.
  const realFeed=yt.feed;
  yt.feed=async()=>{throw new Error('Bu liste için YouTube girişi gerekiyor');};

  await p.goto(base+'/',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(3000);
  yt.feed=realFeed;

  const boot=await p.evaluate(()=>({
    signedIn:document.getElementById('signedIn').textContent,
    tabs:[...document.querySelectorAll('.tab')].map(t=>t.textContent),
    active:document.querySelector('.tab.on')?.dataset.feed,
    note:document.getElementById('feedNote').textContent,
    link:!!document.querySelector('#feedNote a'),
  }));
  check('signed-out state shown', /giriş yok/.test(boot.signedIn), boot.signedIn);
  // With no credential of any kind, the only tabs that can answer are the
  // locally-kept history and Popüler; the rest would error, so they are gone.
  check('only the servable tabs are offered', boot.tabs.length===2
    && /Geçmiş/.test(boot.tabs[0]) && /Popüler/.test(boot.tabs[1]), boot.tabs.join(', '));
  const route=await p.evaluate(()=>
    [...document.querySelectorAll('.picker a')].some(a=>a.getAttribute('href')==='/setup/'));
  check('the way to sign in is still on the page', route);

  // And when a feed does refuse — a lapsed jar, say — the reason has to come
  // with the way out rather than an empty grid.
  const hist=await p.evaluate(()=>({
    note:document.getElementById('feedNote').textContent,
    href:document.querySelector('#feedNote a')?.getAttribute('href'),
    cards:document.querySelectorAll('.card').length,
  }));
  check('an empty history falls through rather than greeting with nothing',
    boot.active==='trending', 'opened on '+boot.active);
  check('a refused feed points at sign-in', /\/setup\//.test(hist.href||''),
    `"${hist.note.trim().slice(0,60)}" -> ${hist.href}`);
  check('no empty grid left behind', hist.cards===0);

  // Rendering goes through the real search path rather than a test hook, so the
  // grid is exercised the way a driver reaches it.
  yt.search = async () => FAKE;
  await p.evaluate(() => {
    document.getElementById('q').value = 'test';
    document.getElementById('go').click();
  });
  await p.waitForSelector('.card', { timeout: 15000 });

  const grid = await p.evaluate(() => {
    const card = document.querySelector('.card');
    return {
      count: document.querySelectorAll('.card').length,
      thumb: card.querySelector('img').getAttribute('src'),
      length: card.querySelector('.len') ? card.querySelector('.len').textContent : null,
      title: card.querySelector('.meta b').textContent,
      channel: card.querySelector('.meta span').textContent,
    };
  });
  check('grid renders a card per result', grid.count === FAKE.length, String(grid.count));
  check('thumbnail comes from YouTube CDN', /i\.ytimg\.com\/vi\/aaaaaaaaaa0/.test(grid.thumb), grid.thumb);
  check('duration badge formatted', grid.length === '1:00', grid.length);
  check('title and channel shown', grid.title === 'Video 0' && grid.channel === 'Kanal 0',
    `${grid.title} / ${grid.channel}`);

  // Tapping a card is a gesture, so it should start straight away rather than
  // showing the tap-to-start screen that link arrivals get.
  yt.getMetadata = async (id) => ({ videoId: id, title: 'Video 0', duration: 60, isLive: false, uploader: '', thumbnail: '' });
  await p.evaluate(() => document.querySelector('.card').click());
  await p.waitForTimeout(1500);
  const afterTap = await p.evaluate(() => ({
    overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
    tapScreen: document.getElementById('tapStart').classList.contains('on'),
  }));
  check('tapping a card starts without a second tap',
    afterTap.overlayHidden && !afterTap.tapScreen,
    `overlay hidden=${afterTap.overlayHidden} tapScreen=${afterTap.tapScreen}`);

  // Paste-and-play is the handoff from the car's signed-in YouTube tab, so it
  // has to work from the clipboard and degrade to the text box when it cannot.
  await p.evaluate(() => {
    document.getElementById('libBtn').click();
  });
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.evaluate(() => navigator.clipboard.writeText('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  await p.evaluate(() => document.getElementById('pasteBtn').click());
  await p.waitForTimeout(2500);
  const pasted = await p.evaluate(() => ({
    box: document.getElementById('q').value,
    overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
  }));
  check('paste-and-play reads the clipboard and opens it',
    /dQw4w9WgXcQ/.test(pasted.box) && pasted.overlayHidden,
    `box="${pasted.box}" overlayHidden=${pasted.overlayHidden}`);

  check('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  await b.close();
  console.log(failures?`\n${failures} failure(s)\n`:'\nbrowse checks pass\n');
  process.exit(failures?1:0);
})();
