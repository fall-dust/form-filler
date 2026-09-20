import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

/**
 * 浏览器启动参数（与 FillConfig 里浏览器相关字段同形，可直接把配置传进来）。
 */
export interface LaunchConfig {
  headless?: boolean
  slowMo?: number
  /** 复用系统浏览器（免打包内核，瘦身用）；设置后忽略 executablePath */
  channel?: 'chrome' | 'msedge'
  /** chromium 可执行文件路径（打包后指向随包分发的浏览器；dev 留空用默认） */
  executablePath?: string
  /** 登录态持久化目录（Playwright user_data_dir） */
  userDataDir?: string
}

export interface LaunchedBrowser {
  browser: Browser
  context: BrowserContext
  page: Page
}

type LaunchOpts = Parameters<typeof chromium.launchPersistentContext>[1]

/**
 * 兜底默认超时。
 *
 * Playwright 未显式传 timeout 时用 30s，而「元素根本不存在」是最常见的失败形态：
 * 一次 `locator.innerText()`、一次 `click()` 落到不存在的元素上就是 30s 白等，
 * 单题预算当场被拖爆（问卷网「每题都单题超时」的元凶之一就是它）。
 * 这里把默认压到 5s —— 显式传了 timeout 的地方不受影响，漏网的也最多等 5s。
 */
export const DEFAULT_ACTION_TIMEOUT = 5000

/** 页面导航另算：表单站首屏常常要几秒，5s 会误伤 */
export const DEFAULT_NAV_TIMEOUT = 30_000

/** 启动失败的可读化：Playwright 的原始报错是十几行 call log（还可能夹 GBK 乱码），用户看不懂 */
function friendlyLaunchError(e: unknown): Error {
  const raw = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
  if (/in use|singleton|profile|lock|另一个|正在使用|being used/i.test(raw)) {
    return new Error(
      '浏览器启动失败：该任务的浏览器配置目录被占用（多半有残留的浏览器窗口，或上一次会话没退干净）。请点左栏「结束会话」，仍不行就重启客户端。'
    )
  }
  const first = raw
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('    at '))
    .slice(0, 2)
    .join('；')
    .slice(0, 240)
  return new Error(`浏览器启动失败：${first}`)
}

/**
 * 持久化 profile 启动。
 *
 * Chromium 用 ProcessSingleton 锁住 profile 目录，而「关窗口」是异步的：
 * 用户点完「结束会话」马上再点「启动浏览器」时，锁可能还没释放，表现为启动直接失败。
 * 这种情况等一拍重试一次就好，不必让用户自己再点一遍（也不掩盖真正的失败：
 * 第二次仍失败就抛第一次的错误）。
 */
async function launchPersistent(userDataDir: string, opts: LaunchOpts): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(userDataDir, opts)
  } catch (first) {
    await new Promise((r) => setTimeout(r, 700))
    try {
      return await chromium.launchPersistentContext(userDataDir, opts)
    } catch {
      throw friendlyLaunchError(first)
    }
  }
}

/**
 * 启动浏览器并给出一个空白页（**不导航**）。传 userDataDir 则为持久化 profile（登录态落盘）。
 * runFill（填写）与「首次抓取 HTML」共用，保证两处启动行为一致。
 */
export async function launchBrowser(cfg: LaunchConfig): Promise<LaunchedBrowser> {
  const launchOpts = {
    headless: cfg.headless ?? false,
    slowMo: cfg.slowMo ?? 0,
    // 不给显式超时的话默认也是 30s，但写死一份：启动卡死时最多 30s×2 次重试就报错，
    // 而不是让「正在启动浏览器…」挂到天荒地老
    timeout: 30_000,
    ...(cfg.channel
      ? { channel: cfg.channel }
      : cfg.executablePath
        ? { executablePath: cfg.executablePath }
        : {})
  }
  let browser: Browser
  let context: BrowserContext
  if (cfg.userDataDir) {
    context = await launchPersistent(cfg.userDataDir, launchOpts)
    browser = context.browser()!
  } else {
    browser = await chromium.launch(launchOpts)
    context = await browser.newContext()
  }
  // 持久化 profile 启动时 Chromium 自带一个 about:blank 页：直接用它，
  // 否则用户会看到平白多出一个空白标签（填写与抓取都只用返回的这一个 page）。
  const page = context.pages()[0] ?? (await context.newPage())
  applyTimeouts(context)
  return { browser, context, page }
}

/** 给会话设默认超时（导航超时单独放宽，见上方常量注释） */
export function applyTimeouts(context: BrowserContext): void {
  context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT)
  context.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT)
}

/**
 * 关掉浏览器（**唯一**的安全关闭入口，凡是主动关浏览器都该用它）。
 *
 * 优先走 CDP 的 `Browser.close`：它能让 Chromium **真正退出**（释放 profile 目录锁，
 * 不留后台进程）。而 Playwright 的 `browser.close()` 在本环境会**一直挂着不返回** ——
 * 一旦挂住，窗口与进程就留在那里，持久化 profile 的目录锁也释放不了，
 * 下一次启动会直接卡在 ProcessSingleton 上（症状是「莫名其妙再也起不来」）。
 *
 * 这个坑在本仓踩过多次，故把它放在与 `launchBrowser` 同一个文件里：
 * 「怎么开」和「怎么关」是一对，不该分居两处。
 * CDP 不可用（浏览器已断开、实现不支持）时退回标准 `browser.close()`。
 */
export async function shutdown(browser: Browser): Promise<void> {
  try {
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send('Browser.close')
    return
  } catch {
    /* 已断开或拿不到 CDP 会话：走下面的标准关闭 */
  }
  await browser.close()
}

/**
 * 打开目标链接并等页面「长得差不多」，供首次抓取 HTML 用。
 *
 * 比填写路径多等一次 `load`（8s 上限，超时不阻塞）：问卷多是前端渲染，
 * 只等 domcontentloaded 常常抓到空壳。**不点任何按钮、不提交、不做登录流程**；
 * 需要登录时窗口就在那儿，用户手动登录后再抓一次即可。
 * 失败时把刚开的浏览器收掉，避免留下孤儿进程。
 */
export async function openPageAt(
  link: string,
  cfg: LaunchConfig,
  waitAfterLoad = 1000
): Promise<LaunchedBrowser> {
  const r = await launchBrowser(cfg)
  try {
    await r.page.goto(link, { waitUntil: 'domcontentloaded' })
    await r.page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
    await r.page.waitForTimeout(waitAfterLoad)
  } catch (e) {
    await shutdown(r.browser).catch(() => {})
    throw e
  }
  return r
}
