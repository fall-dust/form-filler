import type { Page } from 'playwright-core'

/** 子 frame 是否含表单控件（只有含控件的 iframe 才值当收录：嵌入式问卷常在 iframe，广告/埋点整段丢弃） */
const HAS_CONTROL = /<(input|textarea|select)\b/i

/** 去掉噪音标签并压缩空白，减小体积、便于喂给 AI 解析 */
function tidy(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/>\s+</g, '><')
    .trim()
}

export interface GrabResult {
  html: string
  url: string
  /** 实际收录的 frame 数（主 frame + 含控件的子 frame） */
  frames: number
}

/**
 * 抓取「当前页面」的 HTML（多页问卷翻页后取本页用）。
 * - 主 frame 必取；
 * - 子 frame 仅当含表单控件才收录，并标注来源 `<!-- frame: URL -->`；
 * - 不点任何按钮、不导航，纯读取（安全）。
 *
 * 注意：调用方需先用 `waitForGrabReady` 确认页面已加载，否则会抓到空壳。
 */
export async function grabCurrentHtml(page: Page): Promise<GrabResult> {
  const parts: string[] = []
  let frames = 0
  const mainFrame = page.mainFrame()
  for (const f of page.frames()) {
    let html = ''
    try {
      html = await f.content()
    } catch {
      continue
    }
    if (f === mainFrame) {
      parts.push(tidy(html))
      frames++
    } else if (HAS_CONTROL.test(html)) {
      parts.push(`<!-- frame: ${f.url()} -->\n${tidy(html)}`)
      frames++
    }
  }
  let url = ''
  try {
    url = page.url()
  } catch {
    /* 页面已关闭 */
  }
  return { html: parts.join('\n\n'), url, frames }
}

// ---------------- 抓取前的「页面是否长好了」判定 ----------------

/** 正文文字下限：低于它视为还没渲染出内容 */
const MIN_TEXT = 120
/** 就绪轮询间隔 */
const POLL_MS = 400
/** 单次探测的上限（页面正在导航时 evaluate 可能长时间挂起，必须兜底） */
const PROBE_MS = 1500

export interface ReadyProbe {
  /** 页面已可用（可以安全抓取） */
  ok: boolean
  /** 主 frame 的 document.readyState */
  state: string
  /** 主 frame + 含控件子 frame 里的表单控件总数 */
  controls: number
  /** 主 frame 正文文字长度 */
  textLen: number
  /** 浏览器窗口是否已被关闭 */
  closed: boolean
}

/** 给可能挂起的 evaluate 加超时（超时按「探测不到」处理，不阻塞轮询） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

/**
 * 探测页面当前是否「长好了」。
 *
 * 只看 readyState 不够：问卷多是前端渲染，`complete` 之后正文/控件才陆续出现，
 * 这时抓回来的是空壳（用户反馈过「还没加载好就抓」）。故就绪 = DOM 不再是 loading，
 * 且**页面上已经有东西**（有表单控件，或正文文字达到阈值）。
 */
async function probe(page: Page): Promise<ReadyProbe> {
  const closed = ((): boolean => {
    try {
      return page.isClosed()
    } catch {
      return true
    }
  })()
  if (closed) return { ok: false, state: 'closed', controls: 0, textLen: 0, closed: true }

  const main = page.mainFrame()
  const state = (await withTimeout(main.evaluate(() => document.readyState), PROBE_MS)) ?? 'loading'
  const mainControls =
    (await withTimeout(
      main.evaluate(() => document.querySelectorAll('input,textarea,select').length),
      PROBE_MS
    )) ?? 0
  const textLen =
    (await withTimeout(
      main.evaluate(() => (document.body?.innerText ?? '').trim().length),
      PROBE_MS
    )) ?? 0

  // 主 frame 已经有控件就不必再探子 frame（避免多 frame 叠加拖慢轮询）
  let controls = mainControls
  if (controls === 0) {
    for (const f of page.frames()) {
      if (f === main) continue
      const html = (await withTimeout(f.content(), PROBE_MS)) ?? ''
      if (HAS_CONTROL.test(html)) {
        controls += (
          (await withTimeout(
            f.evaluate(() => document.querySelectorAll('input,textarea,select').length),
            PROBE_MS
          )) ?? 1
        )
        if (controls > 0) break
      }
    }
  }

  return {
    ok: state !== 'loading' && (controls > 0 || textLen >= MIN_TEXT),
    state,
    controls,
    textLen,
    closed: false
  }
}

/**
 * 等到页面「长好了」再返回（轮询，最多等 `timeoutMs`）。
 *
 * 用户点的「抓取」发生在页面正在加载/渲染时不再抓回空壳，而是先等一等；
 * 等到超时仍没长好就把最后一次探测结果如实返回，由调用方给出可操作的提示。
 */
export async function waitForGrabReady(page: Page, timeoutMs = 15000): Promise<ReadyProbe> {
  const deadline = Date.now() + timeoutMs
  let last: ReadyProbe = { ok: false, state: 'loading', controls: 0, textLen: 0, closed: false }
  for (;;) {
    last = await probe(page)
    if (last.ok || last.closed) return last
    if (Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/** 把探测结果转成给用户看的一句话（未就绪时用） */
export function readyHint(p: ReadyProbe): string {
  if (p.closed) return '浏览器窗口已关闭，请重新点「启动浏览器」'
  if (p.state === 'loading') return '页面还在加载中，请等页面显示出来后再点「抓取当前页 HTML」'
  return '页面还没渲染出内容（未检测到表单控件），请稍等片刻再抓取'
}
