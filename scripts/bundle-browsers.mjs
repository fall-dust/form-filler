// 将 Playwright 安装的 chromium 复制到项目 browsers/ 目录，供 electron-builder 打包进 resources/browsers。
//
// 复制后立刻做一次无损裁剪（scripts/lib/prune.mjs）：browsers/ 是构建缓存，
// 提前裁掉多语言包与辅助 exe 能让后续每次 dist 少拷 60+ MB，也让仓库更小。
// 打包输出侧（win-unpacked）仍会由 afterPack 钩子再裁一次，两边口径完全一致。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright-core'
import { pruneChromium, reportPrune } from './lib/prune.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'browsers', 'chromium')

/** 优先问 Playwright 要路径；拿不到时回退到标准缓存目录扫描 */
function resolveBrowserDir() {
  try {
    // chromium.executablePath() -> .../ms-playwright/chromium-1243/chrome-win64/chrome.exe
    // 浏览器根目录为其上两级
    const exe = chromium.executablePath()
    if (exe && existsSync(exe)) return dirname(dirname(exe))
  } catch {
    /* 落到下面的回退逻辑 */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (existsSync(cache)) {
    for (const e of readdirSync(cache, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('chromium-')) continue
      const candidate = join(cache, e.name)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

const browserDir = resolveBrowserDir()
if (!browserDir) {
  console.error('未找到 Playwright chromium，请先执行：npx playwright install chromium')
  process.exit(1)
}

console.log(`源：${browserDir}`)
console.log(`目标：${dest}`)

rmSync(dest, { recursive: true, force: true })
mkdirSync(dirname(dest), { recursive: true })
cpSync(browserDir, dest, { recursive: true })

const r = pruneChromium(dest)
if (!r.chromeDir) {
  console.error(`警告：${dest} 下未找到 chrome.exe，浏览器布局可能已变化`)
} else {
  reportPrune('browsers/ 缓存裁剪', [r])
}
console.log('✓ chromium 已复制到 browsers/chromium')
