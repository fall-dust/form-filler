import type { Locator, Page } from 'playwright'
import type { SelectorStrategy } from './types'
import { cssEscape } from './util'
import { similarity } from './similarity'

export interface Resolved {
  loc: Locator
  strategy: string
}

const TEXT_THRESHOLD = 0.6

async function tryCss(
  page: Page,
  css: string,
  timeout: number
): Promise<Locator | null> {
  // 用 .first() 做「是否命中」的等待（单元素无 strict 问题），
  // 返回完整 locator 以保留单选/多选组，供 fillers 里 nth(idx) 选具体选项。
  const loc = page.locator(css)
  try {
    await loc.first().waitFor({ state: 'attached', timeout })
    return loc
  } catch {
    return null
  }
}

async function tryXpath(
  page: Page,
  xpath: string,
  timeout: number
): Promise<Locator | null> {
  const loc = page.locator(`xpath=${xpath}`)
  try {
    await loc.first().waitFor({ state: 'attached', timeout })
    return loc
  } catch {
    return null
  }
}

/** 按问题文本模糊匹配 label/legend，再定位其关联控件 */
async function tryText(
  page: Page,
  text: string,
  _timeout: number
): Promise<Locator | null> {
  const labels = page.locator('label, legend')
  const n = await labels.count()
  let best: Locator | null = null
  let bestScore = TEXT_THRESHOLD
  for (let i = 0; i < n; i++) {
    const el = labels.nth(i)
    const t = (await el.innerText().catch(() => '')).trim()
    const s = similarity(text, t)
    if (s >= bestScore && (best === null || s > bestScore)) {
      bestScore = s
      best = el
    }
  }
  if (!best) return null

  const forAttr = await best.getAttribute('for')
  if (forAttr) {
    const target = page.locator(`#${cssEscape(forAttr)}`).first()
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

/** 逐个尝试回退链，命中即返回 */
export async function resolveQuestion(
  page: Page,
  selectors: SelectorStrategy[],
  timeout: number
): Promise<Resolved | null> {
  const per = Math.min(timeout, 3000)
  for (const s of selectors) {
    let loc: Locator | null = null
    if (s.css) loc = await tryCss(page, s.css, per)
    else if (s.xpath) loc = await tryXpath(page, s.xpath, per)
    else if (s.text) loc = await tryText(page, s.text, per)
    if (loc) return { loc, strategy: describeStrategy(s) }
  }
  return null
}
