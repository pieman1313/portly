/**
 * Drive a headless Chrome over the DevTools Protocol: load the app, import a
 * statement through the real file input, and screenshot every tab at phone and
 * desktop widths.
 *
 * This exists because the app's whole job is rendering numbers, and a test that
 * asserts on `textContent` cannot see a chart overflowing its card or a table
 * pushing the viewport sideways.
 *
 *   node scripts/screenshot.mjs <url> [csvPath]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_BASE = process.argv[2] ?? 'http://localhost:5173/portly/'
const CSV = process.argv[3] ?? null
const OUT = join(process.cwd(), '.context', 'shots')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, scale: 2, mobile: true },
  { name: 'desktop', width: 1280, height: 900, scale: 1, mobile: false },
]
const TABS = ['overview', 'income', 'forecast', 'holdings', 'data']

mkdirSync(OUT, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'portly-chrome-'))
const port = 9222 + Math.floor(process.uptime() * 1000) % 500

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

let chromeErr = ''
chrome.stderr.on('data', (d) => { chromeErr += d.toString() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      const j = await r.json()
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error(`Chrome did not expose a debugger on ${port}. stderr: ${chromeErr.slice(0, 400)}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.sessionId = null
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      }
    })
  }
  send(method, params = {}, useSession = true) {
    const id = ++this.id
    const payload = { id, method, params }
    if (useSession && this.sessionId) payload.sessionId = this.sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 30_000)
    })
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(new Cdp(ws)))
    ws.addEventListener('error', (e) => reject(new Error(`ws: ${e.message ?? 'failed'}`)))
  })
}

const cdp = await connect(await wsUrl())

// Attach to a page target so Page/DOM/Runtime domains are addressable.
const { targetInfos } = await cdp.send('Target.getTargets', {}, false)
let target = targetInfos.find((t) => t.type === 'page')
if (!target) {
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, false)
  target = { targetId: created.targetId }
}
const { sessionId } = await cdp.send(
  'Target.attachToTarget', { targetId: target.targetId, flatten: true }, false,
)
cdp.sessionId = sessionId

await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('DOM.enable')
await cdp.send('Log.enable')
await cdp.send('Network.enable')
const failures = []
cdp.ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    failures.push(`${m.params.response.status} ${m.params.response.url.slice(0, 110)}`)
  }
})
globalThis.__failures = failures

const consoleErrors = []
cdp.ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push(m.params.entry.text)
  }
})

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  }
  return r.result.value
}

async function setViewport(v) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile,
  })
}

async function goto(url) {
  await cdp.send('Page.navigate', { url })
  await sleep(1200)
}

async function shoot(name, v) {
  // Grow the VIEWPORT to the full content height and let the page settle before
  // capturing, rather than using captureBeyondViewport. That flag resizes the
  // page underneath the renderer, which makes every Recharts ResponsiveContainer
  // re-measure via its ResizeObserver — and the capture lands before the redraw,
  // so every chart photographs blank while being perfectly fine in the browser.
  const { contentSize } = await cdp.send('Page.getLayoutMetrics')
  const full = Math.min(Math.ceil(contentSize.height), 4000)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: v.width, height: full, deviceScaleFactor: v.scale, mobile: v.mobile,
  })
  await sleep(900) // one animation frame is not enough; charts re-animate
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await setViewport(v)
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

/** Horizontal overflow is the single most common mobile bug; measure it. */
async function overflow() {
  return evaluate(`(() => {
    const d = document.documentElement
    const over = d.scrollWidth - d.clientWidth
    const culprits = []
    if (over > 1) {
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.right > d.clientWidth + 1) {
          culprits.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 60) + ' right=' + Math.round(r.right))
          if (culprits.length >= 5) break
        }
      }
    }
    return { over, culprits }
  })()`)
}

const results = []

for (const v of VIEWPORTS) {
  await setViewport(v)
  await goto(`${URL_BASE}#/overview`)

  // Import on the first pass only; IndexedDB persists across navigations.
  if (CSV && v === VIEWPORTS[0] && existsSync(CSV)) {
    await goto(`${URL_BASE}#/data`)
    await sleep(800)
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId, selector: 'input[type=file]',
    })
    if (!nodeId) throw new Error('no file input found on the Data tab')
    await cdp.send('DOM.setFileInputFiles', { files: [CSV], nodeId })
    // Parsing, hashing and deriving a year of statement takes a moment.
    await sleep(4000)
    const imported = await evaluate(
      `document.body.innerText.match(/imported|duplicate|already/i)?.[0] ?? 'no import feedback'`,
    )
    console.log(`import: ${imported}`)
    // Wait for the automatic refresh kicked off by the import to settle.
    for (let i = 0; i < 40; i++) {
      const busy = await evaluate(`document.body.innerText.includes('Updating prices')`)
      if (!busy && i > 2) break
      await sleep(1000)
    }
    console.log('post-import sync settled')
  }

  for (const tab of TABS) {
    await goto(`${URL_BASE}#/${tab}`)
    await sleep(1500)
    const o = await overflow()
    if (process.env.DIAG) {
      const d = await evaluate(`JSON.stringify({
        sections: document.querySelectorAll('section').length,
        responsive: document.querySelectorAll('.recharts-responsive-container').length,
        surfaces: document.querySelectorAll('svg.recharts-surface').length,
        sectors: document.querySelectorAll('.recharts-sector').length,
        bars: document.querySelectorAll('.recharts-bar-rectangle').length,
        sized: [...document.querySelectorAll('div')].filter(x=>x.style.height).map(x=>x.style.width+'/'+x.style.height+' -> '+Math.round(x.getBoundingClientRect().width)+'x'+Math.round(x.getBoundingClientRect().height)).slice(0,6)
      })`)
      console.log(`  DIAG ${v.name}/${tab}: ${d}`)
    }
    if (process.env.CARDCHECK && v.name === 'phone') {
      const d = await evaluate(`JSON.stringify([...document.querySelectorAll('section')].map(sec=>{
        const h=sec.querySelector('h2'); const r=sec.getBoundingClientRect();
        const body=sec.lastElementChild; const bs=body?getComputedStyle(body):null;
        return {t:(h?.textContent??'(untitled)').slice(0,26), h:Math.round(r.height),
                cap:Math.round(window.innerHeight*0.75), oy:bs?.overflowY,
                scrolls: body ? body.scrollHeight > body.clientHeight + 1 : false}
      }))`)
      console.log(`  CARDS ${tab}: ${d}`)
    }
    if (process.env.TEXT) console.log(`\n--- ${v.name}/${tab} ---\n` + (await evaluate('document.body.innerText')).slice(0, 1400))
    const path = await shoot(`${v.name}-${tab}`, v)
    const text = await evaluate('document.body.innerText')
    const poison = text.match(/\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/)
    results.push({ viewport: v.name, tab, overflow: o.over, culprits: o.culprits, poison: poison?.[0] ?? null, path, chars: text.length })
  }
}

console.log('\nviewport  tab        overflow  poison  chars  file')
for (const r of results) {
  console.log(
    `${r.viewport.padEnd(9)} ${r.tab.padEnd(10)} ${String(r.overflow).padStart(8)}  ${(r.poison ?? '-').padEnd(6)} ${String(r.chars).padStart(6)}  ${r.path.replace(process.cwd() + '/', '')}`,
  )
  for (const c of r.culprits) console.log(`             overflowing: ${c}`)
}

const fails = globalThis.__failures ?? []
if (fails.length) {
  console.log('\nHTTP failures (a provider miss is expected; a missing asset is not):')
  for (const f of [...new Set(fails)]) console.log('  ' + f)
}
if (consoleErrors.length) {
  console.log('\nconsole errors:')
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log('  ' + e.slice(0, 220))
} else {
  console.log('\nno console errors')
}

chrome.kill()
process.exit(0)
