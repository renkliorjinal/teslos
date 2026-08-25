'use strict';
// Legibility, as a number. "Passive buttons cannot be read at all" is a
// contrast complaint, and contrast is measurable — so it is asserted rather
// than eyeballed, in every state a control can be in.
const path=require('path'); const fs=require('fs');
const {chromium}=require('playwright');
const ROOT=require('path').join(__dirname,'..');
process.env.PORT='8812'; process.env.BIND='127.0.0.1';
process.env.YT_DLP_COOKIES='/tmp/teslos-nonexistent-jar.txt';
process.env.STATE_DIRECTORY='/tmp/teslos-ui-state';
process.env.SETUP_TOKEN='testtoken12345678';
fs.rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true});

let failures=0;
function check(l,ok,d){console.log(`${ok?'  ok  ':'  FAIL'}  ${l}${d?'  — '+d:''}`);if(!ok)failures++;}

// WCAG AA for normal text. A car screen in daylight is a harder case than a
// desk monitor, so this is a floor and not a target.
const MIN_RATIO = 4.5;

const CONTRAST_FN = `
  function parse(c) {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(fg, bg) {
    // Flatten a translucent colour onto what is behind it.
    return { r: fg.r * fg.a + bg.r * (1 - fg.a),
             g: fg.g * fg.a + bg.g * (1 - fg.a),
             b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function effectiveBg(el) {
    let node = el, acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c;
        if (acc.a >= 1 || c.a >= 1) return acc.a >= 1 ? acc : over(acc, { r:0,g:0,b:0,a:1 });
      }
      node = node.parentElement;
    }
    return acc || { r: 0, g: 0, b: 0, a: 1 };
  }
  function ratio(el) {
    const bg = effectiveBg(el);
    let fg = parse(getComputedStyle(el).color);
    if (!fg) return null;
    if (fg.a < 1) fg = over(fg, bg);
    const a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
`;

(async()=>{
  require('../server/index.js');
  await new Promise(r=>setTimeout(r,700));
  const base='http://127.0.0.1:8812';

  const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p=await b.newPage({viewport:{width:1900,height:1080}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));

  await p.goto(base+'/',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2500);

  // Every control, in every state it can reach — including the disabled one the
  // driver could not read.
  const measured=await p.evaluate(`(() => {
    ${CONTRAST_FN}
    const out = [];
    const sample = (label, el) => {
      if (!el) return;
      const r = ratio(el);
      if (r !== null) out.push({ label, ratio: Math.round(r * 100) / 100,
        text: (el.textContent || '').trim().slice(0, 22),
        fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor });
    };

    document.querySelectorAll('.tab').forEach((t, i) => sample('tab ' + i + (t.classList.contains('on') ? ' (active)' : ''), t));
    document.querySelectorAll('.chip').forEach((c, i) => sample('chip ' + i, c));
    sample('search input', document.getElementById('q'));
    sample('primary button', document.getElementById('go'));
    sample('secondary button', document.getElementById('pasteBtn'));
    sample('hint text', document.querySelector('.hint'));
    sample('feed note', document.getElementById('feedNote'));
    sample('account line', document.getElementById('signedIn'));

    // The active filter chip, since inverting it changes both colours at once.
    const tab = document.querySelector('.tab');
    tab.classList.add('on');
    sample('tab (forced active)', tab);

    return out;
  })()`);

  // Disabled — the state the complaint was actually about. Measured after a
  // pause, because .btn animates its background: read immediately and
  // getComputedStyle returns the colour it is transitioning *from*, which made
  // a perfectly readable button look like a 1.9:1 failure.
  await p.evaluate(()=>{
    document.getElementById('go').disabled = true;
    document.querySelector('.chip').disabled = true;
    document.getElementById('pasteBtn').disabled = true;
  });
  await p.waitForTimeout(400);
  const disabled=await p.evaluate(`(() => {
    ${CONTRAST_FN}
    const out=[];
    const sample=(label,el)=>{
      const r=ratio(el);
      if (r!==null) out.push({label, ratio:Math.round(r*100)/100,
        text:(el.textContent||'').trim().slice(0,22),
        fg:getComputedStyle(el).color, bg:getComputedStyle(el).backgroundColor});
    };
    sample('primary button (disabled)', document.getElementById('go'));
    sample('chip (disabled)', document.querySelector('.chip'));
    sample('secondary button (disabled)', document.getElementById('pasteBtn'));
    return out;
  })()`);
  measured.push(...disabled);

  const worst=measured.slice().sort((a,b)=>a.ratio-b.ratio);
  for (const m of worst.slice(0,4)) {
    console.log(`       ${m.ratio.toFixed(2)}:1  ${m.label} "${m.text}"  fg=${m.fg} bg=${m.bg}`);
  }

  const failing=measured.filter(m=>m.ratio<MIN_RATIO);
  check(`every control reads at ${MIN_RATIO}:1 or better`, failing.length===0,
    failing.length ? failing.map(f=>`${f.label} ${f.ratio}:1`).join(', ')
      : `${measured.length} sampled, worst ${worst[0].ratio}:1`);

  // Touch targets: this is a screen used at arm's length in a moving car.
  const small=await p.evaluate(()=>{
    const bad=[];
    document.querySelectorAll('.tab, .chip, .btn').forEach((el)=>{
      const r=el.getBoundingClientRect();
      if (r.width && r.height && r.height < 44) bad.push((el.textContent||'').trim().slice(0,18)+' '+Math.round(r.height)+'px');
    });
    return bad;
  });
  check('touch targets are at least 44px tall', small.length===0, small.join(', '));

  // Nothing may spill off a 1900px screen, since there is no horizontal scroll.
  const overflow=await p.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  check('nothing overflows the screen width', overflow<=0, overflow+'px over');

  // Kept for a human to look at when a number alone is unconvincing.
  await p.screenshot({path:path.join(require('./helpers').FIXTURES,'ui-picker.png')});

  // ------------------------------------------------------------ the setup page
  await p.goto(base+'/setup/',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1200);
  const setupMeasured=await p.evaluate(`(() => {
    ${CONTRAST_FN}
    const out=[];
    document.querySelectorAll('.btn, .input, .muted, .state, code, li, p').forEach((el,i)=>{
      if (!el.textContent.trim()) return;
      const r=ratio(el);
      if (r!==null) out.push({label:el.tagName.toLowerCase()+' '+i, ratio:Math.round(r*100)/100,
        text:el.textContent.trim().slice(0,22)});
    });
    const save=document.getElementById('saveClient');
    save.disabled=true;
    const r=ratio(save);
    out.push({label:'save (disabled)', ratio:Math.round(r*100)/100, text:'KAYDET'});
    return out;
  })()`);
  const setupFailing=setupMeasured.filter(m=>m.ratio<MIN_RATIO);
  check('the setup page reads too', setupFailing.length===0,
    setupFailing.length ? setupFailing.map(f=>`${f.label} ${f.ratio}:1 "${f.text}"`).join(', ')
      : `${setupMeasured.length} sampled`);

  check('no page errors', errs.length===0, errs.slice(0,2).join(' | '));

  await b.close();
  fs.rmSync(process.env.STATE_DIRECTORY,{recursive:true,force:true});
  console.log(failures?`\n${failures} FAILED`:'\nall passed');
  process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
