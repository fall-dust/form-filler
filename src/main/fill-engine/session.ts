import type { Browser, BrowserContext, Page } from 'playwright-core'
// shutdown 与 launchBrowser 是一对（怎么开 / 怎么关），住在 browser.ts；
// 放在这里会形成 session → browser → session 的循环依赖。
import { openPageAt, shutdown, type LaunchConfig } from './browser'

/**
 * 可复用的浏览器会话（多页问卷「接着填」）。
 *
 * 页面填完后浏览器保持打开（由人工核对提交），这里把它按任务存起来；
 * 下次对同一任务再跑时直接复用 —— **不重开浏览器、不重新 goto**，
 * 于是能在用户手动翻到的当前页面上接着填，而不是回到表单第 1 页。
 */
export interface FillSession {
  browser: Browser
  context: BrowserContext
  page: Page
  /** 建立会话时的目标任务链接；链接一旦改变即视为失效（下次运行重新打开） */
  link: string
}

const sessions = new Map<string, FillSession>()

/**
 * 取仍存活的会话：浏览器已断开或页面已关闭时清理并返回 null。
 * 这样「用户手动关掉浏览器」后，下次运行会自动重新打开，而不是复用一个死会话。
 */
export function getLiveSession(key: string): FillSession | null {
  const s = sessions.get(key)
  if (!s) return null
  let alive = false
  try {
    alive = s.browser.isConnected() && !s.page.isClosed()
  } catch {
    alive = false
  }
  if (!alive) {
    sessions.delete(key)
    return null
  }
  return s
}

/**
 * 登记会话。同一浏览器只挂一次 `disconnected` 监听（避免每次运行重复挂），
 * 断连时清理注册表并回调 onGone（用于通知界面「会话已结束」）。
 */
export function setSession(key: string, s: FillSession, onGone?: () => void): void {
  const prev = sessions.get(key)
  sessions.set(key, s)
  if (!prev || prev.browser !== s.browser) {
    try {
      s.browser.on('disconnected', () => {
        const cur = sessions.get(key)
        // 已被换成别的会话时不误删
        if (cur && cur.browser === s.browser) sessions.delete(key)
        onGone?.()
      })
    } catch {
      /* 个别实现可能不支持事件；忽略即可（getLiveSession 仍会兜底判定失活） */
    }
  }
}

/**
 * 关闭并移除会话（浏览器已断开/关闭也视为成功）。
 * 关闭动作整体加超时保护——调用方（IPC/收尾）绝不因此卡住。
 */
export async function closeSession(key: string, timeoutMs = 8000): Promise<boolean> {
  const s = sessions.get(key)
  if (!s) return false
  sessions.delete(key)
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      shutdown(s.browser),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } catch {
    /* 已经关掉/断开都算处理完成 */
  } finally {
    if (timer) clearTimeout(timer)
  }
  return true
}

export async function closeAllSessions(): Promise<void> {
  const keys = [...sessions.keys()]
  await Promise.all(keys.map((k) => closeSession(k)))
}

export function hasLiveSession(key: string): boolean {
  return getLiveSession(key) !== null
}

/**
 * 「首次抓取」用：没有存活会话时，直接用目标链接把浏览器打开，用户就**不必再手工复制 HTML**。
 *
 * - 已有存活会话且链接未变 → 原样复用（opened=false），不重开、不重新导航
 * - 已有会话但链接已改 → 先关掉旧窗口，再按新链接打开（避免把两件事混在一个窗口里）
 * - 打开失败会抛出（调用方负责转成可读错误），不留半开的会话登记
 */
export async function ensureSession(
  key: string,
  link: string,
  launch: LaunchConfig,
  waitAfterLoad = 1000,
  onGone?: () => void
): Promise<{ session: FillSession; opened: boolean }> {
  const existing = getLiveSession(key)
  if (existing && existing.link === link) return { session: existing, opened: false }
  if (existing) await closeSession(key)

  const { browser, context, page } = await openPageAt(link, launch, waitAfterLoad)
  const session: FillSession = { browser, context, page, link }
  setSession(key, session, onGone)
  return { session, opened: true }
}
