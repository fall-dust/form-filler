// 打包瘦身的共享裁剪逻辑。
//
// 三条原则（对应「无损裁剪」档）：
//   1. 只删「本项目这条链路（Electron 窗口 + Playwright 驱动随包 Chromium 填表）绝对用不到」的文件；
//   2. 不碰任何可能被渲染/GPU 路径加载的 DLL（dxcompiler、vk_swiftshader、d3dcompiler_47 等一律保留，
//      要删请显式开 PRUNE_TIER=aggressive，见下）；
//   3. 每个被删条目都记账，构建结束时打印收益，方便回归对比。
//
// 档位（环境变量 PRUNE_TIER）：
//   lean（默认）：无损裁剪
//   aggressive   ：额外删 GPU/软件渲染兜底 DLL 与连字词典，可再省约 34 MB，
//                  极小概率影响 WebGPU / 软件渲染兜底路径，按需开启
import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/** Electron 与 Chromium 都只保留这两个语言包，其余语言包删掉 */
export const LOCALE_KEEP = ['zh-CN.pak', 'en-US.pak']

/** 随包 Chromium 里可以无条件删掉的东西 */
const CHROMIUM_ALWAYS_REMOVE = [
  // 安装器与系统集成辅助进程：自动化链路永远不会走到
  'setup.exe',
  'chrome_proxy.exe',
  'chrome_pwa_launcher.exe',
  'notification_helper.exe',
  'elevation_service.exe',
  'elevated_tracing_service.exe',
  'chrome_wer.dll',
  // Chrome for Testing 的安装标记与预加载数据
  'DEPENDENCIES_VALIDATED',
  'INSTALLATION_COMPLETE',
  'First Run',
  'IwaKeyDistribution',
  'MEIPreload',
  'PrivacySandboxAttestationsPreloaded',
  join('resources', 'reading_mode_gdocs_helper')
]

/** aggressive 档才删：渲染兜底相关，正常路径用不到但不保证 100% 无损 */
const CHROMIUM_AGGRESSIVE_REMOVE = [
  'dxcompiler.dll', // D3D12/WebGPU 着色器编译（不启用 WebGPU 时不加载）
  'dxil.dll',
  'vk_swiftshader.dll', // Vulkan 软件渲染兜底
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
  'd3dcompiler_47.dll',
  'hyphen-data' // 排版连字词典（CSS hyphens 才用）
]

/** 打包副本里的 playwright-core：只留自动化运行时，删掉编辑器/报告查看器与类型声明 */
const PLAYWRIGHT_CORE_REMOVE = [
  join('lib', 'vite'), // HTML 报告 / Trace Viewer 前端产物（只有 showTraceViewer 用）
  'types' // 纯 TS 类型声明（.d.ts），运行时不可能被 require
]

/** 递归统计目录体积（字节） */
export function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else {
      try {
        total += statSync(p).size
      } catch {
        /* 忽略瞬时文件 */
      }
    }
  }
  return total
}

export function fmtMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

export function currentTier() {
  return process.env.PRUNE_TIER === 'aggressive' ? 'aggressive' : 'lean'
}

/** 单个路径的体积（字节）：文件取 stat，目录递归累加 */
export function pathSize(p) {
  let st
  try {
    st = statSync(p)
  } catch {
    return 0
  }
  return st.isDirectory() ? dirSize(p) : st.size
}

/** 删除单个路径，返回省下的字节数 */
function removePath(target) {
  if (!existsSync(target)) return 0
  const size = pathSize(target)
  rmSync(target, { recursive: true, force: true })
  return size
}

/** 保留 LOCALE_KEEP，删掉其它语言包 */
function pruneLocales(localesDir) {
  if (!existsSync(localesDir)) return 0
  let freed = 0
  for (const f of readdirSync(localesDir)) {
    if (!f.endsWith('.pak')) continue
    if (LOCALE_KEEP.includes(f)) continue
    freed += removePath(join(localesDir, f))
  }
  return freed
}

/** 在浏览器根目录下找到含 chrome.exe 的那一层（兼容 chrome-win64 / chrome-win 两种布局） */
export function findChromeDir(root, depth = 3) {
  if (depth < 0 || !existsSync(root)) return null
  if (existsSync(join(root, 'chrome.exe'))) return root
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const hit = findChromeDir(join(root, e.name), depth - 1)
    if (hit) return hit
  }
  return null
}

/**
 * 裁剪一份随包 Chromium（传浏览器根目录或直接传含 chrome.exe 的目录）。
 * 返回 { freed, chromeDir }，chromeDir 为 null 表示没找到（说明布局变了，调用方应告警）。
 */
export function pruneChromium(root, { tier = currentTier() } = {}) {
  const chromeDir = findChromeDir(root)
  if (!chromeDir) return { freed: 0, chromeDir: null, detail: [] }
  const detail = []
  let freed = 0

  const localesFreed = pruneLocales(join(chromeDir, 'locales'))
  if (localesFreed) {
    freed += localesFreed
    detail.push([`locales（仅留 ${LOCALE_KEEP.join(' / ')}）`, localesFreed])
  }

  const list = tier === 'aggressive'
    ? [...CHROMIUM_ALWAYS_REMOVE, ...CHROMIUM_AGGRESSIVE_REMOVE]
    : CHROMIUM_ALWAYS_REMOVE
  for (const rel of list) {
    const f = removePath(join(chromeDir, rel))
    if (f) {
      freed += f
      detail.push([rel, f])
    }
  }
  return { freed, chromeDir, detail }
}

/** 裁剪打包出的 playwright-core（自动化只需要 coreBundle/utilsBundle 这条链路） */
export function prunePlaywrightCore(nmDir) {
  const dir = join(nmDir, 'playwright-core')
  if (!existsSync(dir)) return { freed: 0, detail: [] }
  const detail = []
  let freed = 0
  for (const rel of PLAYWRIGHT_CORE_REMOVE) {
    const f = removePath(join(dir, rel))
    if (f) {
      freed += f
      detail.push([`playwright-core/${rel}`, f])
    }
  }
  return { freed, detail }
}

/** 打印裁剪明细 */
export function reportPrune(title, results) {
  const lines = []
  for (const r of results) {
    if (!r) continue
    for (const [name, size] of r.detail ?? []) lines.push(`    · ${name}  -${fmtMB(size)}`)
  }
  const total = results.reduce((acc, r) => acc + (r?.freed ?? 0), 0)
  console.log(`[prune] ${title}：-${fmtMB(total)}`)
  for (const l of lines) console.log(l)
}
