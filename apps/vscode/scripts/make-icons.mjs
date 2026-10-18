// Renders the extension icons from apps/vscode/media/icon.svg. The PNGs are committed; run this
// (`npm run icons`) only after changing the SVG. Needs the Chromium that Playwright installs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const svg = fs.readFileSync(path.join(root, 'apps/vscode/media/icon.svg'), 'utf8')

const targets = [
  { size: 128, file: 'apps/vscode/media/icon.png' },
  ...[16, 32, 48, 128].map((size) => ({
    size,
    file: `apps/browser/static/icons/icon-${size}.png`
  }))
]

const findChromium = () => {
  if (process.env.CODEGENT_CHROMIUM) return process.env.CODEGENT_CHROMIUM
  const own = chromium.executablePath()
  if (own && fs.existsSync(own)) return own
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(
      process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? os.homedir())
        : path.join(os.homedir(), '.cache'),
      'ms-playwright'
    )
  const builds = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : []
  for (const dir of builds) {
    for (const relative of [
      'chrome-win64/chrome.exe',
      'chrome-win/chrome.exe',
      'chrome-linux64/chrome'
    ]) {
      const candidate = path.join(cache, dir, relative)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error('No Chromium found; set CODEGENT_CHROMIUM.')
}

const browser = await chromium.launch({ executablePath: findChromium() })
try {
  for (const { size, file } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    // The SVG is drawn at its final size (not scaled down from a bigger bitmap), so small icons stay crisp.
    const sized = svg.replace(
      /width="128" height="128"/,
      `width="${size}" height="${size}"`
    )
    await page.setContent(`<body style="margin:0;background:transparent">${sized}</body>`)
    const out = path.join(root, file)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    await page.screenshot({
      path: out,
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size }
    })
    await page.close()
    console.log(`${file} (${size}×${size})`)
  }
} finally {
  await browser.close()
}
