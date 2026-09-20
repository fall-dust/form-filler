// 校验「裁剪后的随包 Chromium」还能不能正常干活。
//
// 背景：为压小安装包，打包时会删掉随包 Chromium 的多语言包与一批辅助 exe/dll
// （见 scripts/lib/prune.mjs）。这类裁剪必须能回归验证，否则出现「装完打不开」很致命。
//
// 用法：
//   node scripts/check-bundled-browser.mjs                    # 默认检查 release/win-unpacked
//   node scripts/check-bundled-browser.mjs --dir <app目录>     # 指定 win-unpacked 之类的目录
//   node scripts/check-bundled-browser.mjs --exe <chrome.exe> # 直接指定浏览器可执行文件
//   node scripts/check-bundled-browser.mjs --headless          # 无头模式（没有桌面会话时用）
//
// 检查项：启动 → 打开本地样例 HTML → 填一个文本框 → 读回值 → 截图（走一遍渲染/GPU 兜底）
//         → 关闭浏览器（CDP，避免个别环境 close() 挂住）
import { existsSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright-core'
import { findChromeDir } from './lib/prune.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const appDir = resolve(arg('--dir', join(root, 'release', 'win-unpacked')))
const headless = process.argv.includes('--headless')

let exe = arg('--exe')
if (exe) {
  exe = resolve(exe)
  if (!existsSync(exe)) {
    console.error(`✗ 指定的浏览器不存在：${exe}`)
    process.exit(1)
  }
} else {
  const browsersRoot = join(appDir, 'resources', 'browsers')
  if (!existsSync(browsersRoot)) {
    console.error(`✗ 未找到 ${browsersRoot}（先执行 npm run dist 生成打包目录）`)
    process.exit(1)
  }
  const dirs = readdirSync(browsersRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
  const chromeDir = dirs.map((e) => findChromeDir(join(browsersRoot, e.name))).find(Boolean)
  if (!chromeDir) {
    console.error(`✗ ${browsersRoot} 下未找到 chrome.exe`)
    process.exit(1)
  }
  exe = join(chromeDir, 'chrome.exe')
}
console.log(`使用浏览器：${exe}`)

const sample = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>裁剪校验</title></head>
<body><h3>裁剪校验样例</h3>
<label>姓名 <input id="name" type="text"></label>
<label><input type="radio" name="g" id="g1"> 男</label>
<label><input type="radio" name="g" id="g2"> 女</label>
<script>document.getElementById('name').addEventListener('input', e => { document.title = 'T:' + e.target.value })</script>
</body></html>`
const samplePath = join(tmpdir(), `form-filler-prune-check-${Date.now()}.html`)
writeFileSync(samplePath, sample, 'utf8')

async function shutdown(browser) {
  try {
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send('Browser.close')
    return
  } catch {
    /* 落到标准关闭 */
  }
  await browser.close().catch(() => {})
}

const browser = await chromium.launch({ headless, executablePath: exe })
try {
  const page = await browser.newPage()
  await page.goto('file:///' + samplePath.replace(/\\/g, '/'))
  const zhTitle = await page.title()
  await page.fill('#name', '张三')
  await page.check('#g2')
  const value = await page.inputValue('#name')
  const shot = await page.screenshot()
  const checked = await page.isChecked('#g2')

  const htmlText = await page.evaluate(() => document.body.innerText)
  console.log(`  · 页面标题：${zhTitle}`)
  console.log(`  · 输入回读：${value}（期望 张三）`)
  console.log(`  · 单选勾选：${checked}`)
  console.log(`  · 截图字节：${shot.length}`)
  console.log(`  · 中文渲染文本包含「裁剪校验样例」：${htmlText.includes('裁剪校验样例')}`)
  const ok = value === '张三' && checked && shot.length > 1000 && htmlText.includes('裁剪校验样例')
  console.log(ok ? '✓ 随包 Chromium 裁剪后工作正常' : '✗ 校验未通过')
  await shutdown(browser)
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('✗ 校验失败：', e instanceof Error ? e.message : e)
  await shutdown(browser)
  process.exit(1)
}
