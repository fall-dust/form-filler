// 将 Playwright 安装的 chromium 复制到项目 browsers/ 目录，供 electron-builder 打包进 resources/browsers
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'browsers', 'chromium')

// chromium.executablePath() -> .../ms-playwright/chromium-1243/chrome-win64/chrome.exe
// 浏览器根目录为其上两级
const exe = chromium.executablePath()
if (!exe || !existsSync(exe)) {
  console.error('未找到 Playwright chromium，请先执行：npx playwright install chromium')
  process.exit(1)
}
const browserDir = dirname(dirname(exe))

console.log(`源：${browserDir}`)
console.log(`目标：${dest}`)

rmSync(dest, { recursive: true, force: true })
mkdirSync(dirname(dest), { recursive: true })
cpSync(browserDir, dest, { recursive: true })
console.log('✓ chromium 已复制到 browsers/chromium')
