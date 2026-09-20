// electron-builder afterPack 钩子：打包出 app 目录后、生成安装包前，做一遍瘦身。
//
// 为什么放在这里而不是 sources：此时 win-unpacked 已成型，删掉的东西会同时体现在
// 免安装目录与两个安装包（nsis / portable）里，且不影响开发环境。
//
// 档位由环境变量 PRUNE_TIER 控制（lean 默认 / aggressive），详见 scripts/lib/prune.mjs。
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { currentTier, pruneChromium, prunePlaywrightCore, reportPrune } from './lib/prune.mjs'

export default async function afterPack(context) {
  const appOutDir = context.appOutDir
  const resourcesDir = join(appOutDir, 'resources')
  console.log(`[prune] 档位：${currentTier()}  目标目录：${appOutDir}`)

  const results = []

  // 1) 随包 Chromium（extraResources: browsers → resources/browsers）
  const browsersRoot = join(resourcesDir, 'browsers')
  if (existsSync(browsersRoot)) {
    for (const e of readdirSync(browsersRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const r = pruneChromium(join(browsersRoot, e.name))
      if (!r.chromeDir) {
        console.warn(`[prune] 警告：${e.name} 下未找到 chrome.exe，跳过裁剪（浏览器布局可能已变化）`)
        continue
      }
      results.push(r)
    }
  } else {
    console.warn('[prune] 警告：未找到 resources/browsers，本次未打包浏览器内核')
  }

  // 2) 打包副本里的 playwright-core（asarUnpack 后的真实文件）
  const unpacked = join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  if (existsSync(unpacked)) {
    results.push(prunePlaywrightCore(unpacked))
  }

  reportPrune('打包目录瘦身完成', results)
}
