import type { Frame, Locator, Page } from 'playwright-core'

/**
 * 自动提交辅助（autoSubmit 开启时由 engine 调用）。
 *
 * 找按钮采用「候选打分」而非「优先级短路」：
 *   · 遍历所有 frame（含 iframe），收集 button/[role=button]/input[type=submit]/a 候选
 *   · 按文本强度 + 组件库主按钮 + 是否在 form 内 + 是否 disabled 综合打分，取最高分
 *   · 明确的「取消/重置/保存草稿」类文本直接排除——即使它是主按钮样式
 * 只点击一次；点击后做效果验证（submit 事件/请求/导航/按钮变禁用），结果如实写入报告。
 */

const SUBMIT_STRONG = /提交|送出|submit/i
const SUBMIT_WEAK = /确定|完成|发表|发布|发送|send/i
/** 明确不是提交的按钮文本（比分值更优先——直接排除） */
const NOT_SUBMIT_TEXT =
  /取消|重置|清空|撤销|返回|上一步|暂存|保存|预览|导出|撤回|登出|退出|cancel|reset|back|prev|draft|save|preview|logout/i

interface Candidate {
  loc: Locator
  score: number
  desc: string
  /** 按钮上的人类可读文字，用于失败/未确认时写清「点了哪个」 */
  text: string
  frame: Frame
}

/** 元素是否可见且未禁用 */
async function isClickable(loc: Locator): Promise<boolean> {
  try {
    await loc.waitFor({ state: 'visible', timeout: 1200 })
    return !(await loc.isDisabled().catch(() => false))
  } catch {
    return false
  }
}

/** 元素文本（input 取 value，其余取 textContent） */
async function textOf(loc: Locator): Promise<string> {
  return (
    (await loc
      .evaluate((node) =>
        node instanceof HTMLInputElement
          ? node.value
          : (node as HTMLElement).textContent ?? ''
      )
      .catch(() => '')) ?? ''
  ).trim()
}

/** 是否带组件库主按钮样式 */
async function hasPrimaryClass(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((node) => /(^|\s)(el-button--primary|ant-btn-primary|btn-primary|btn-submit)(\s|$)/.test(node.className))
    .catch(() => false)
}

/** 是否在 form 内 */
async function inForm(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((node) => node.closest('form') !== null)
    .catch(() => false)
}

/** 单个 frame 内收集候选 */
async function collectInFrame(frame: Frame, isMain: boolean): Promise<Candidate[]> {
  const out: Candidate[] = []
  const frameBonus = isMain ? 0 : -5 // 主 frame 与子 frame 同分时优先主 frame

  // 1) 原生 submit 控件：得分最高，但同样跳过 disabled/隐藏
  const natives = frame.locator('button[type="submit"], input[type="submit"]')
  const nNat = Math.min(await natives.count().catch(() => 0), 10)
  for (let i = 0; i < nNat; i++) {
    const el = natives.nth(i)
    if (!(await isClickable(el))) continue
    const form = (await inForm(el)) ? 10 : 0
    out.push({
      loc: el,
      score: 120 + form + frameBonus,
      desc: 'native-submit',
      text: (await textOf(el)) || '提交控件',
      frame
    })
  }

  // 2) 按文本/样式打分的普通按钮（限制数量防巨页卡顿）
  const all = frame.locator('button, [role="button"], a')
  const n = Math.min(await all.count().catch(() => 0), 120)
  for (let i = 0; i < n; i++) {
    const el = all.nth(i)
    const t = await textOf(el)
    if (!t) continue
    if (NOT_SUBMIT_TEXT.test(t)) continue // 排除类文本一票否决，即使是主按钮
    if (!(await isClickable(el))) continue

    let score = 0
    if (SUBMIT_STRONG.test(t)) score = 100
    else if (SUBMIT_WEAK.test(t)) score = 70
    else {
      // 无提交语义文本：仅当带主按钮样式时才作为「保底候选」
      if (await hasPrimaryClass(el)) score = 30
      else continue
    }
    if (await hasPrimaryClass(el)) score += 25
    if (await inForm(el)) score += 20
    out.push({
      loc: el,
      score: score + frameBonus,
      desc: `text:${t.slice(0, 16)}`,
      text: t.slice(0, 24),
      frame
    })
  }
  return out
}

/** 依打分寻找全页面（含 iframe）最佳提交候选 */
async function findSubmit(page: Page): Promise<Candidate | null> {
  const frames = page.frames()
  const all: Candidate[] = []
  for (const f of frames) {
    all.push(...(await collectInFrame(f, f === page.mainFrame()).catch(() => [])))
  }
  if (all.length === 0) return null
  all.sort((a, b) => b.score - a.score)
  return all[0]
}

/**
 * 查找并点击提交按钮。返回是否已提交、效果是否被证实及失败原因。
 * 点击后做效果验证：submit 事件 / 网络请求 / 导航 / 按钮变禁用 任一出现即证实。
 */
export async function trySubmit(page: Page): Promise<{
  submitted: boolean
  /** 已点击时：是否观测到页面响应（submit 事件/请求/导航/按钮禁用）。false 时调用方应提示人工确认 */
  confirmed?: boolean
  /** 实际点击/命中的按钮文字，便于汇报里说清点了哪个 */
  target?: string
  error?: string
}> {
  const cand = await findSubmit(page)
  if (!cand) return { submitted: false, error: '未找到提交按钮（可人工手动提交）' }

  // 预埋效果信号：捕获该 frame 内的 form submit 事件 + 任一网络请求
  await cand.frame
    .evaluate(() => {
      const w = window as unknown as { __ffSubmitSignal?: boolean }
      w.__ffSubmitSignal = false
      document.addEventListener(
        'submit',
        () => {
          ;(window as unknown as { __ffSubmitSignal?: boolean }).__ffSubmitSignal = true
        },
        true
      )
    })
    .catch(() => {})
  const requestArmed = page
    .waitForEvent('request', { timeout: 2500 })
    .then(() => true)
    .catch(() => false)
  const navArmed = page
    .waitForEvent('framenavigated', { timeout: 2500 })
    .then(() => true)
    .catch(() => false)
  const urlBefore = page.url()

  await cand.loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
  try {
    await cand.loc.click({ timeout: 3000 })
  } catch {
    try {
      await cand.loc.dispatchEvent('click')
    } catch (e) {
      return {
        submitted: false,
        target: cand.text,
        error: `提交按钮「${cand.text}」点击失败: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  // 等页面响应（至多 2.5s），再汇总各类效果信号
  await Promise.race([requestArmed, navArmed, page.waitForTimeout(1500)])
  const [req, nav] = await Promise.all([requestArmed, navArmed]).catch(() => [false, false])
  const signal = await cand.frame
    .evaluate(() => (window as unknown as { __ffSubmitSignal?: boolean }).__ffSubmitSignal === true)
    .catch(() => false)
  const disabledAfter = await cand.loc.isDisabled().catch(() => false)
  const confirmed = signal || req || nav || disabledAfter || page.url() !== urlBefore

  return { submitted: true, confirmed, target: cand.text }
}
