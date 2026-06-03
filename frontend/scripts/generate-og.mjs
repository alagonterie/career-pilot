// One-shot generator for the branded social-share card (STRATEGY §24.36 36.5).
// Reuses the existing Playwright chromium (no new dep): renders a branded HTML
// card at 1200×630 and screenshots it to public/og.png. Regenerate after a brand
// change with:  node scripts/generate-og.mjs  (from the frontend/ dir).
//
// Generic persona only — no real identifiers ([[project_generic_persona]]); the
// candidate's headshot becomes a branded og:image at deploy.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../public/og.png')

const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: #0a0e0c; color: #e7f0ea; padding: 80px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; justify-content: center;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .kicker { display: flex; align-items: center; gap: 16px; margin-bottom: 40px; }
  .dot { width: 22px; height: 22px; border-radius: 9999px; background: #34d399; box-shadow: 0 0 0 7px rgba(52, 211, 153, 0.16); }
  .kicker span { font-size: 24px; letter-spacing: 0.35em; text-transform: uppercase; color: #7c8a82; }
  h1 { font-size: 86px; line-height: 1.04; font-weight: 700; letter-spacing: -0.02em; max-width: 1000px; }
  .accent { color: #34d399; }
  p { margin-top: 34px; font-size: 30px; color: #9fb0a7; max-width: 940px; line-height: 1.4; }
  .foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; font-size: 22px; color: #7c8a82; }
</style></head><body>
  <div class="kicker"><span class="dot"></span><span class="mono">live</span></div>
  <h1>An AI agent runs my <span class="accent">job search</span>, live.</h1>
  <p>Watch it research companies, tailor a resume, and draft outreach — then run it on your own role.</p>
  <div class="foot mono"><span>Jane Doe · Career Pilot</span><span>hire.example.com</span></div>
</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.screenshot({ path: OUT, type: 'png' })
  console.log('wrote', OUT)
} finally {
  await browser.close()
}
