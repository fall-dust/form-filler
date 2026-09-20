import type { Frame, Locator, Page } from 'playwright-core'
import type { SelectorStrategy } from './types'
import { cssEscape } from './util'
import { similarity } from './similarity'

export interface Resolved {
  loc: Locator
  strategy: string
  /** 命中所在 frame（主文档或某个 iframe） */
  frame: Frame
  /** 该选择器命中元素数（选择题用来判断是否命中「整组选项」） */
  count?: number
}

const TEXT_THRESHOLD = 0.6
/** 单策略在非主 frame 里的等待上限（避免多 frame 叠加过久） */
const CHILD_FRAME_PER = 2000
/** 已有一条弱命中、还要探测后续策略时的等待上限（这些策略多半不存在，短超时即可） */
const PROBE_PER = 1500
/** 读属性：Playwright 默认 30s，命中失败时会白等（见 browser.ts 里默认超时的说明） */
const ATTR_TIMEOUT = 1500

/** 实现是否命中「整组选项」 */
function satisfies(hit: Resolved, minMatches?: number): boolean {
  if (minMatches === undefined) return true
  return (hit.count ?? 0) >= minMatches
}

/** FrameLike：主文档与子 iframe 的公共能力子集 */
type FrameLike = Pick<Frame, 'locator' | 'url'> & { mainFrame?: () => Frame }

async function tryCss(
  ctx: FrameLike,
  css: string,
  timeout: number
): Promise<Locator | null> {
  // 用 .first() 做「是否命中」的等待（单元素无 strict 问题），
  // 返回完整 locator 以保留单选/多选组，供 fillers 里 nth(idx) 选具体选项。
  const loc = ctx.locator(css)
  try {
    await loc.first().waitFor({ state: 'attached', timeout })
    return loc
  } catch {
    return null
  }
}

async function tryXpath(
  ctx: FrameLike,
  xpath: string,
  timeout: number
): Promise<Locator | null> {
  const loc = ctx.locator(`xpath=${xpath}`)
  try {
    await loc.first().waitFor({ state: 'attached', timeout })
    return loc
  } catch {
    return null
  }
}

/** 按问题文本模糊匹配 label/legend，再定位其关联控件 */
async function tryText(
  ctx: FrameLike,
  text: string,
  _timeout: number
): Promise<Locator | null> {
  const labels = ctx.locator('label, legend')
  const n = await labels.count().catch(() => 0)
  if (n === 0) return null

  // 一次 evaluateAll 取回全部标签文本：逐个 innerText() 是 n 次 CDP 往返，
  // 页面标签一多，光这点往返就能吃掉单题预算（而且每个还可能各自白等到超时）。
  const texts = await labels
    .evaluateAll((nodes) => nodes.map((node) => ((node as HTMLElement).innerText || '').trim()))
    .catch(() => [] as string[])

  let bestIdx = -1
  let bestScore = -1
  for (let i = 0; i < texts.length; i++) {
    const s = similarity(text, texts[i])
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  if (bestIdx < 0 || bestScore < TEXT_THRESHOLD) return null

  const best = labels.nth(bestIdx)
  const forAttr = await best.getAttribute('for', { timeout: ATTR_TIMEOUT }).catch(() => null)
  if (forAttr) {
    const target = ctx.locator(`#${cssEscape(forAttr)}`).first()
    if (await target.count()) return target
  }
  const inner = best.locator('input, select, textarea').first()
  if (await inner.count()) return inner
  return best
}

export function describeStrategy(s: SelectorStrategy): string {
  if (s.css) return `css:${s.css}`
  if (s.xpath) return `xpath:${s.xpath}`
  if (s.text) return `text:${s.text}`
  return 'unknown'
}

/**
 * 在一个 frame 内跑完整回退链；命中返回 Resolved。
 *
 * 传了 minMatches（选择题）时改为「整组优先」：回退链里常有这样的组合 ——
 * 第一条 css 只命中单个选项（如某些问卷平台每个选项的 name 都不同，或 AI 给的选择器
 * 指向了某一项），后面的 css 才命中整组。此时不能第一条就收工，要继续探测，
 * 取「命中元素数最多」的那条，避免只能填第一项、或在框架重渲染后彻底失配。
 */
async function resolveInFrame(
  frame: Frame,
  isMain: boolean,
  selectors: SelectorStrategy[],
  timeout: number,
  minMatches?: number
): Promise<Resolved | null> {
  const per = isMain ? Math.min(timeout, 5000) : Math.min(CHILD_FRAME_PER, timeout)
  const tag = isMain ? '' : `@iframe(${frame.url().slice(0, 60)})`
  let best: Resolved | null = null
  let first = true
  for (const s of selectors) {
    // 已有弱命中时，后续策略只做「快速探测」，不重复付满额等待
    const wait = first || minMatches === undefined ? per : Math.min(per, PROBE_PER)
    first = false
    let loc: Locator | null = null
    if (s.css) loc = await tryCss(frame, s.css, wait)
    else if (s.xpath) loc = await tryXpath(frame, s.xpath, wait)
    else if (s.text) loc = await tryText(frame, s.text, wait)
    if (!loc) continue
    const n = await loc.count().catch(() => 0)
    const hit: Resolved = { loc, strategy: describeStrategy(s) + tag, frame, count: n }
    if (satisfies(hit, minMatches)) return hit
    if (!best || n > (best.count ?? 0)) best = hit
  }
  return best
}

/**
 * 逐 frame 尝试回退链（主文档优先，子 iframe 按文档序浅层在前），命中即返回。
 * 使 iframe 内的表单（嵌入式问卷/SaaS 表单）也能被定位与填写。
 *
 * 传了 minMatches 时，优先返回「命中整组」的那条；都不满足才退而取命中最多的一条。
 */
export async function resolveQuestion(
  page: Page,
  selectors: SelectorStrategy[],
  timeout: number,
  minMatches?: number
): Promise<Resolved | null> {
  const main = await resolveInFrame(page.mainFrame(), true, selectors, timeout, minMatches)
  if (main && satisfies(main, minMatches)) return main
  const weak: Resolved[] = main ? [main] : []
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue
    // 跳过空白的 about:blank frame（无内容可定位）
    if (!frame.url() || frame.url() === 'about:blank') continue
    const hit = await resolveInFrame(frame, false, selectors, timeout, minMatches)
    if (!hit) continue
    if (satisfies(hit, minMatches)) return hit
    weak.push(hit)
  }
  if (weak.length === 0) return null
  // 都没有命中完整的一组：取命中元素最多者（同数则靠前者优先）
  return weak.reduce((a, b) => ((b.count ?? 0) > (a.count ?? 0) ? b : a))
}
