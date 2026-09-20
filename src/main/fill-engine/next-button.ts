/**
 * 「下一页」按钮识别与点击（多页问卷的翻页入口）。
 *
 * 为什么需要它：多页问卷的每一页都得先翻过去才能采集。让人自己在浏览器里找按钮、
 * 点完再回来点抓取，来回切窗口很烦；这里把「翻页」也做成界面上的一个动作：
 * 识别出候选按钮 → 界面显示成 chip → 点 chip 即在浏览器里点它，然后抓取存成新页。
 *
 * 安全边界：
 * - 识别是**只读**的（只在页面上打一个临时标记属性，不改内容、不点任何东西）；
 * - 点击**只在用户明确点 chip 时**发生，绝不自动翻页、更不会点提交/完成类按钮
 *   （命中「提交/完成/返回/上一步」等关键词的候选一律排除）。
 */
import type { Frame, Page } from 'playwright-core'

/** 识别到的候选「下一页」按钮 */
export interface NextButton {
  /** 按钮上的文字（已压掉空白、截断到 12 字） */
  text: string
  /** 点击用选择器（识别时给元素打了临时标记，比按文本找更稳） */
  selector: string
  /** 元素标签名（小写） */
  tag: string
  /** 置信度 0–100（命中关键词的强度） */
  score: number
  /** 当前是否禁用 —— 禁用的按钮点了也没用，界面要照实说 */
  disabled: boolean
  /** 所在 frame 的 URL（'' = 主 frame）；点击时要用同一个 frame */
  frameUrl: string
}

/** 页面内采集到的原始候选（含排序用的辅助字段） */
interface RawCandidate {
  text: string
  selector: string
  tag: string
  score: number
  disabled: boolean
  /** 是否原生按钮/链接（同为高分时优先，比 div 伪装按钮更可靠） */
  native: boolean
  /** DOM 顺序（越靠后 = 越可能在表单底部，也就是「下一步」的位置） */
  order: number
}

/**
 * 在页面里采集候选（**这个函数会被序列化到浏览器里执行，不能用外面的任何变量**）。
 *
 * 判定：文字命中「下一页/下一步/继续」类关键词、可见、面积正常；
 * 命中「提交/完成/返回/上一步/取消」类关键词的一律排除 —— 宁可漏，不可点错。
 */
function collectCandidates(): RawCandidate[] {
  const MARK = 'data-formfiller-next'
  const POSITIVE: [RegExp, number][] = [
    [/下一\s*页|下\s*页/, 100],
    [/下一\s*步\s*骤?/, 95],
    [/下一\s*(部分|部份|题|节|环节|大项)/, 92],
    [/继续(填写|答题|作答|问卷|下一步|下一步骤)?/, 85],
    [/下一個|下一个/, 75],
    [/^\s*next\s*$/i, 70],
    [/\bnext\b/i, 62]
  ]
  const NEGATIVE =
    /(上一|上一步|上页|返回|后退|back|prev|previous|提交|完成|结束|取消|重置|清空|退出|草稿|暂存|跳过|skip|关闭|返回首页)/i

  const nodes = document.querySelectorAll(
    'button, a, [role="button"], input[type="submit"], input[type="button"], [class*="btn"], [class*="button"], [class*="next"]'
  )
  const out: RawCandidate[] = []
  let order = 0
  for (const el of Array.from(nodes)) {
    const he = el as HTMLElement
    const raw =
      (he.innerText || '').trim() ||
      (he as HTMLInputElement).value ||
      he.getAttribute('aria-label') ||
      he.getAttribute('title') ||
      ''
    const text = raw.replace(/\s+/g, '')
    if (!text || text.length > 12) continue
    if (NEGATIVE.test(text)) continue

    let score = 0
    for (const [re, s] of POSITIVE) {
      if (re.test(text)) score = Math.max(score, s)
    }
    if (score === 0) continue

    // 可见性：宽高为 0 / 隐藏 / 几乎透明的都不算（很多组件库把隐藏的备用按钮留在 DOM 里）
    const rect = he.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) continue
    const style = getComputedStyle(he)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.2) {
      continue
    }

    const disabled =
      (he as HTMLButtonElement).disabled === true ||
      he.getAttribute('aria-disabled') === 'true' ||
      he.classList.contains('disabled') ||
      he.classList.contains('is-disabled')

    const idx = out.length
    he.setAttribute(MARK, String(idx))
    out.push({
      text,
      selector: `[${MARK}="${idx}"]`,
      tag: he.tagName.toLowerCase(),
      score: disabled ? Math.max(0, score - 10) : score,
      disabled,
      native: he.tagName === 'BUTTON' || he.tagName === 'A' || he.tagName === 'INPUT',
      order
    })
    order++
  }
  return out
}

/** 给可能挂起的 evaluate 加超时（超时按「没识别到」处理，绝不让界面卡住） */
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

const PROBE_MS = 2000
/** 最多回给界面几个候选（多了反而挑花眼） */
const MAX_RESULTS = 4

/**
 * 识别「下一页」按钮。
 *
 * 先看主 frame（绝大多数问卷的翻页按钮在主文档），主 frame 一个都没有时才去子 frame 找
 * —— 嵌入式问卷的按钮确实常在 iframe 里，但一个个 frame 扫过去太慢，先便宜的来。
 * 排序：置信度优先，同分时「靠后的（表单底部）」「原生按钮」优先。
 */
export async function detectNextButtons(page: Page): Promise<NextButton[]> {
  const frames: Frame[] = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]
  const found: { frame: Frame; raw: RawCandidate }[] = []

  const scan = async (f: Frame, limit: number): Promise<void> => {
    const list = (await withTimeout(f.evaluate(collectCandidates), PROBE_MS)) ?? []
    for (const raw of list.slice(0, limit)) found.push({ frame: f, raw })
  }

  const main = page.mainFrame()
  await scan(main, MAX_RESULTS * 2)
  if (found.length === 0) {
    // 主 frame 没有：看看含表单控件的子 frame（最多 3 个，避免慢）
    for (const f of frames.slice(1, 4)) {
      await scan(f, MAX_RESULTS * 2)
      if (found.length > 0) break
    }
  }

  const seen = new Set<string>()
  return found
    .map((x) => x)
    .sort(
      (a, b) =>
        b.raw.score - a.raw.score ||
        (b.raw.native ? 1 : 0) - (a.raw.native ? 1 : 0) ||
        b.raw.order - a.raw.order
    )
    .filter((x) => {
      // 同一段文字只留一个（组件库常见「外层 div + 内层 button」双命中）
      if (seen.has(x.raw.text)) return false
      seen.add(x.raw.text)
      return true
    })
    .slice(0, MAX_RESULTS)
    .map(({ frame, raw }) => ({
      text: raw.text,
      selector: raw.selector,
      tag: raw.tag,
      score: raw.score,
      disabled: raw.disabled,
      frameUrl: frame === main ? '' : frame.url()
    }))
}

/** 点击时要找的按钮 */
export interface NextClickTarget {
  selector?: string
  text?: string
  /** 识别时按钮所在的 frame（'' / 省略 = 主 frame） */
  frameUrl?: string
}

export interface NextClickResult {
  ok: boolean
  /** 实际生效的策略（选择器 / 语义按钮 / 文本派发） */
  strategy?: string
  /** 点击后页面 URL（可能已翻到下一页） */
  url?: string
  error?: string
}

/** 按文本在页面里找到元素并派发点击（原生 click() 只落在元素本身，不冒泡到别处） */
function clickByTextInPage(text: string): boolean {
  const want = text.replace(/\s+/g, '')
  const nodes = document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="button"]')
  for (const el of Array.from(nodes).reverse()) {
    const he = el as HTMLElement
    const raw = ((he.innerText || '') || (he as HTMLInputElement).value || '').replace(/\s+/g, '')
    if (raw !== want) continue
    he.scrollIntoView({ block: 'center' })
    he.click()
    return true
  }
  return false
}

/**
 * 在浏览器里点一个识别到的按钮。
 *
 * 三级回退，从「最准」到「最抗折腾」：临时标记选择器 → 语义按钮（role=button）→ 文本派发。
 * 前端框架重渲染会把标记属性冲掉，所以后两级是必要的兜底。
 */
export async function clickNextButton(page: Page, target: NextClickTarget): Promise<NextClickResult> {
  const main = page.mainFrame()
  const frame = target.frameUrl ? (page.frames().find((f) => f.url() === target.frameUrl) ?? main) : main
  const urlBefore = page.url()

  const attempts: { name: string; run: () => Promise<unknown> }[] = []
  if (target.selector) {
    attempts.push({ name: '选择器', run: () => frame.click(target.selector as string, { timeout: 4000 }) })
  }
  if (target.text) {
    const text = target.text
    attempts.push({
      name: '语义按钮',
      run: async () => {
        await frame.getByRole('button', { name: text, exact: false }).first().click({ timeout: 4000 })
      }
    })
    attempts.push({
      name: '文本派发',
      run: async () => {
        const done = await frame.evaluate(clickByTextInPage, text)
        if (!done) throw new Error('没找到该按钮')
      }
    })
  }

  let lastError = '没有可用的定位方式'
  for (const a of attempts) {
    try {
      await a.run()
      await page.waitForTimeout(300)
      return { ok: true, strategy: a.name, url: page.url() }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      // 点击本身可能已经生效、只是页面随即跳走导致上下文销毁 —— 那就当成功
      try {
        if (page.url() !== urlBefore) return { ok: true, strategy: `${a.name}（页面已跳转）`, url: page.url() }
      } catch {
        /* 页面可能已关闭 */
      }
    }
  }
  return { ok: false, error: `点击「下一页」失败：${lastError}` }
}
