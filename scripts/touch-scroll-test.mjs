/**
 * Synthetic touch-drag test for scroll trapping.
 *
 * A horizontally scrollable region captures a touch gesture by AXIS: the browser
 * locks the gesture to one axis as it begins, so a diagonal swipe over such a
 * region locks to horizontal and the page does not move until the finger lifts.
 * Invisible to a screenshot and to any jsdom test, and the most common way a
 * mobile table comes to feel broken.
 *
 * Drags a finger across a selector at several angles and reports how far the
 * PAGE moved for each.
 *
 *   node scripts/touch-scroll-test.mjs <url> <csv> [selector] [hash]
 *
 * `touch-action: pan-x` is NOT the fix, though it reads like it. It does not
 * hand the vertical component to the page; it removes vertical panning from the
 * gesture, and every angle then reports 0. Measured, not assumed. The fix is to
 * not nest a horizontal scroller inside the page scroller on a phone.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const [URLB,CSV,SELECTOR='[aria-label^="Payments matrix"]',HASH='#/income']=process.argv.slice(2)
const port=9788, profile=mkdtempSync(join(tmpdir(),'dg-'))
const ch=spawn(CHROME,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions','about:blank'],{stdio:'ignore'})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let wsu; for(let i=0;i<60;i++){try{const j=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();if(j.webSocketDebuggerUrl){wsu=j.webSocketDebuggerUrl;break}}catch{}await sleep(250)}
const sock=new WebSocket(wsu); await new Promise(r=>sock.addEventListener('open',r))
let id=0; const pend=new Map(); let sess=null
sock.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=pend.get(m.id);if(p){pend.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}})
const send=(me,pa={},us=true)=>{const i=++id;const pl={id:i,method:me,params:pa};if(us&&sess)pl.sessionId=sess;sock.send(JSON.stringify(pl));return new Promise((r,j)=>{pend.set(i,{resolve:r,reject:j});setTimeout(()=>{if(pend.delete(i))j(new Error(me))},20000)})}
const {targetInfos}=await send('Target.getTargets',{},false)
const {sessionId}=await send('Target.attachToTarget',{targetId:targetInfos.find(x=>x.type==='page').targetId,flatten:true},false); sess=sessionId
await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
await send('Emulation.setEmitTouchEventsForMouse',{enabled:false})
const ev=async ex=>{const r=await send('Runtime.evaluate',{expression:ex,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value}
await send('Page.navigate',{url:URLB+'#/data'}); await sleep(2500)
const {root}=await send('DOM.getDocument')
const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'})
await send('DOM.setFileInputFiles',{files:[CSV],nodeId}); await sleep(5000)

async function swipe(label, dx, dy) {
  await send('Page.navigate',{url:URLB+HASH}); await sleep(3000)
  const box = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(SELECTOR)});
    if(!el) return null; el.scrollIntoView({block:'center'});
    const r=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2),
      ta:getComputedStyle(el).touchAction, ob:getComputedStyle(el).overscrollBehavior})})()`)
  if (!box) { console.log(`${label.padEnd(28)} selector absent — no scroller to capture the gesture`); return }
  const b = JSON.parse(box); await sleep(400)

  // Suspend scroll snapping for the measurement. This harness answers exactly
  // one question — did a horizontally scrollable element swallow the gesture —
  // and snapping muddies it: a short flick genuinely scrolls the page and is
  // then eased back to the nearest snap point, which nets to zero and reads
  // identically to capture. The two are distinguishable only by watching the
  // scroll events, so remove the variable instead of interpreting it.
  const hadSnap = await ev(`(()=>{const v=getComputedStyle(document.documentElement).scrollSnapType;
    document.documentElement.style.scrollSnapType='none'; return v})()`)

  const before = await ev('Math.round(window.scrollY)')
  // A real finger drag: touchStart, several moves, touchEnd.
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:b.x,y:b.y}]})
  for (let i=1;i<=10;i++){
    await send('Input.dispatchTouchEvent',{type:'touchMove',
      touchPoints:[{x:b.x+Math.round(dx*i/10), y:b.y+Math.round(dy*i/10)}]})
    await sleep(16)
  }
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  await sleep(700)
  const after = await ev('Math.round(window.scrollY)')
  await ev(`document.documentElement.style.scrollSnapType=''`)
  const moved = after - before
  console.log(
    `${label.padEnd(28)} touch-action=${String(b.ta).padEnd(10)} snap=${String(hadSnap).padEnd(12)}` +
      ` page moved ${String(moved).padStart(5)}px  ${moved > 20 ? 'OK' : 'TRAPPED'}`,
  )
}
await swipe('pure vertical (dy -220)', 0, -220)
await swipe('diagonal 30deg (-60,-200)', -60, -200)
await swipe('diagonal 45deg (-150,-150)', -150, -150)
ch.kill(); process.exit(0)
