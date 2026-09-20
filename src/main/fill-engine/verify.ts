import type { Locator } from 'playwright-core'
import { CHECKED_CLASS_SOURCE, switchStateInPage } from '../../shared/contracts/checked'
import { isStrictType } from '../../shared/contracts/registry'
import type { AnswerValue, ParsedQuestion } from './types'
import { bestMatch, similarity } from './similarity'

/**
 * 回读类操作一律显式给短超时。
 *
 * Playwright 不传 timeout 时用默认 30s，而「这个元素不存在」恰恰是回读时最常见的情况：
 * `locator.innerText()` 会踏实等满 30s 才抛错。问卷网那道题的原生 input 既没有 id、
 * 也没有 label 祖先，于是 labelText 里连续两次这样的白等（30s + 30s）撞穿了单题预算 ——
 * 外部表现就是「每道题都单题超时」，而题目其实早被点中了。
 */
const READ_TIMEOUT = 1200

/**
 * 「严格校验题型」与「选中态类名」都来自**唯一知识源**，这里不再维护第二份：
 *   · `isStrictType`          ← `shared/contracts/registry.ts`（题型能力注册表）
 *   · `CHECKED_CLASS_SOURCE`  ← `shared/contracts/checked.ts`（快照层/工具运行时共用）
 *
 * 原先这两条都写死在本文件里，而快照层与工具运行时各自又抄了一份选中态正则 ——
 * 站点换一套类名就要三处同时改，漏一处就会出现「已勾选却回读为未选中」。
 */
export { isStrictType }

/** switch 的答案解析：真值集合 */
function parseBool(answer: string): boolean {
  return ['true', '1', 'on', 'yes', 'y', '是', '开', '启用', '打开'].includes(
    answer.trim().toLowerCase()
  )
}

async function inputValueOf(loc: Locator): Promise<string | null> {
  try {
    return await loc.first().inputValue({ timeout: READ_TIMEOUT })
  } catch {
    return null
  }
}

async function textOf(loc: Locator): Promise<string> {
  return (await loc.first().innerText({ timeout: READ_TIMEOUT }).catch(() => '')).trim()
}

/** 在元素所在文档（可能是 iframe）根查找 label[for=id] */
function labelFor(el: Locator, id: string): Locator {
  return el.locator('xpath=ancestor::body').locator(`label[for="${id}"]`).first()
}

/**
 * 取控件所属「选项」的文字。
 *
 * 自定义控件（问卷网 `ws-radio`、TDesign 等）把选项文字放在**兄弟节点**里：
 * ```
 * <div class="ws-radio">
 *   <span class="ws-radio__input"><input type="radio" aria-hidden="true"></span>
 *   <span class="ws-radio__label"><div class="option-title">16-30分钟</div></span>
 * </div>
 * ```
 * 原生 input 自己、以及它的直接父级 `ws-radio__input` 里都没有文字，所以按
 * 「祖先 label」「父级 label」「父级 innerText」全都取不到 —— 回读必然判为未填写。
 *
 * 这里改成向上逐层找**只包含当前这一个勾选控件**的祖先，它的文本就是该选项的文字。
 * 一次 evaluate 完成，没有多次往返开销。
 */
async function optionTextOf(el: Locator): Promise<string> {
  return el
    .evaluate(
      (node) => {
        const SEL = 'input[type="radio"], input[type="checkbox"]'
        let cur: HTMLElement | null = (node as HTMLElement).parentElement
        for (let depth = 0; depth < 4 && cur; depth++) {
          if (cur.querySelectorAll(SEL).length === 1) {
            const t = (cur.innerText || '').trim()
            if (t) return t
          }
          cur = cur.parentElement
        }
        return ''
      },
      undefined,
      { timeout: READ_TIMEOUT }
    )
    .catch(() => '')
}

async function labelText(el: Locator): Promise<string> {
  // 读属性用短超时：框架重渲染后旧句柄会一直等到默认 30s
  const id = await el.getAttribute('id', { timeout: READ_TIMEOUT }).catch(() => null)
  if (id) {
    const t = (await labelFor(el, id)
      .innerText({ timeout: READ_TIMEOUT })
      .catch(() => '')).trim()
    if (t) return t
  }
  const wrap = (
    await el
      .locator('xpath=ancestor::label[1]')
      .innerText({ timeout: READ_TIMEOUT })
      .catch(() => '')
  ).trim()
  if (wrap) return wrap
  // 腾讯问卷 / TDesign：<label for> 与 input 是兄弟节点，取同容器的 label 文本
  const sib = (
    await el
      .locator('xpath=..')
      .locator('label')
      .first()
      .innerText({ timeout: READ_TIMEOUT })
      .catch(() => '')
  ).trim()
  if (sib) return sib
  // 无 label 的自定义控件（问卷网）：向上找「只含当前这一个控件」的祖先
  const own = await optionTextOf(el)
  if (own) return own
  return (
    await el
      .locator('xpath=..')
      .innerText({ timeout: READ_TIMEOUT })
      .catch(() => '')
  ).trim()
}

/**
 * 单个勾选控件当前是否已选中。
 *
 * 原生 input 读 `checked`；自定义控件（问卷网 `ws-radio`）的选中态其实是**外层容器**上的
 * `is-checked` 类，原生 input 未必同步 —— 两条都认，否则会出现「浏览器里明明已勾选、
 * 程序却回读为未选中」从而反复重填、最终判失败。
 */
export async function isChoiceChecked(el: Locator): Promise<boolean> {
  try {
    if (await el.isChecked({ timeout: READ_TIMEOUT })) return true
  } catch {
    /* 非原生 input / 句柄失效：落到组件态判断 */
  }
  return el
    .evaluate(
      (node, checkedCls) => {
        const rx = new RegExp(checkedCls)
        let cur: Element | null = node as Element
        for (let depth = 0; depth < 3 && cur; depth++) {
          if (cur.getAttribute('aria-checked') === 'true') return true
          const cls = typeof cur.className === 'string' ? cur.className : ''
          if (rx.test(cls)) return true
          cur = cur.parentElement
        }
        return false
      },
      CHECKED_CLASS_SOURCE,
      { timeout: READ_TIMEOUT }
    )
    .catch(() => false)
}

/** radio/judge：组里被勾选项的文本是否匹配答案 */
async function verifyRadioGroup(
  group: Locator,
  answer: string
): Promise<boolean> {
  const n = await group.count()
  for (let i = 0; i < n; i++) {
    const el = group.nth(i)
    if (!(await isChoiceChecked(el))) continue
    return similarity(answer, await labelText(el)) >= 0.6
  }
  return false
}

/** checkbox：每个答案对应的项都被勾选 */
async function verifyCheckboxGroup(
  group: Locator,
  answers: string[]
): Promise<boolean> {
  const n = await group.count()
  for (const ans of answers) {
    let matched = false
    for (let i = 0; i < n; i++) {
      const el = group.nth(i)
      if (!(await isChoiceChecked(el))) continue
      if (similarity(ans, await labelText(el)) >= 0.6) {
        matched = true
        break
      }
    }
    if (!matched) return false
  }
  return true
}

/**
 * switch：当前态是否等于目标态。
 *
 * 读法与「填写」侧（`fillers.ts`）用的是**同一个函数**（`shared/contracts/checked.ts`）——
 * 两处原先各抄一份实现，一旦漂移就会出现「填的时候认为开了、回读时认为没开」的自相矛盾。
 * 顺带补上显式超时：读不到时立刻返回，而不是按 Playwright 默认白等 30s
 * （本仓最贵的一课：回读类调用不传 timeout 会在「元素不存在」时踏实等满）。
 */
async function verifySwitch(el: Locator, answer: string): Promise<boolean> {
  const target = parseBool(answer)
  const state = await el
    .first()
    .evaluate(switchStateInPage, undefined, { timeout: READ_TIMEOUT })
    .catch(() => null)
  if (state === null) return false
  return state === target
}

/** slider：当前值与目标值相等（数值比较） */
async function verifySlider(el: Locator, answer: string): Promise<boolean> {
  const target = parseFloat(answer)
  if (Number.isNaN(target)) return false
  const cur = await el
    .first()
    .evaluate((node) => {
      const n = node as HTMLElement
      const aria = n.getAttribute('aria-valuenow')
      if (aria !== null) return parseFloat(aria)
      if (n instanceof HTMLInputElement) return parseFloat(n.value)
      const input = n.querySelector<HTMLInputElement>('input[type="range"]')
      return input ? parseFloat(input.value) : NaN
    })
    .catch(() => NaN)
  if (Number.isNaN(cur)) return false
  return Math.abs(cur - target) < 1e-6
}

/** richselect：触发器上显示的文本是否包含/匹配答案 */
async function verifyRichSelect(
  el: Locator,
  answer: string | string[]
): Promise<boolean> {
  let shown = await textOf(el)
  if (!shown) {
    // TDesign / 腾讯问卷：选中的值放在触发器内 readonly input 的 value 上（innerText 为空）
    shown = (await el.locator('input').first().inputValue({ timeout: 2000 }).catch(() => '')) || ''
    shown = shown.trim()
  }
  if (!shown) return false
  const answers = Array.isArray(answer) ? answer : [answer]
  if (answers.length > 1) {
    // 多选：每个答案都要出现在已选标签/文本中
    return answers.every((a) => shown.includes(a.trim()))
  }
  return similarity(answers[0], shown) >= 0.6
}

/**
 * 「先校验后填写」用的**严格**预校验：只有页面当前状态已经**精确等于**目标才算已完成。
 *
 * 不能拿 verifyFilled 的宽松相似度来做这件事 —— 它会把「非常满意」当成「满意」，
 * 于是页面预置的默认选项被误判为已完成，整题被跳过（真实踩过）。
 *
 * 选择题按「配置选项里的下标」判定：当前勾选的下标集合 === 答案解析出的下标集合。
 * 这样不依赖 label 文本能否提取（问卷网那种选项文字在兄弟节点里的结构也适用）。
 */
export async function alreadyFilled(
  loc: Locator,
  q: ParsedQuestion,
  answer: AnswerValue
): Promise<boolean> {
  const answers = Array.isArray(answer) ? answer : [String(answer)]

  if (q.type === 'radio' || q.type === 'judge' || q.type === 'checkbox') {
    if (q.options.length === 0) return false
    const n = await loc.count()
    const checked: number[] = []
    for (let i = 0; i < n; i++) {
      // 用 isChoiceChecked 而非 isChecked：问卷网这类自定义控件把选中态放在外层容器上
      if (await isChoiceChecked(loc.nth(i))) checked.push(i)
    }
    if (checked.length === 0) return false
    const want = [...new Set(answers.map((a) => bestMatch(a, q.options)).filter((i) => i >= 0))].sort(
      (x, y) => x - y
    )
    return want.length > 0 && want.length === checked.length && want.every((v, i) => v === checked[i])
  }

  // 文本类 verifyFilled 本来就是精确比较，可直接复用
  if (q.type === 'text' || q.type === 'textarea') {
    return verifyFilled(loc, q, answer)
  }

  // 其余题型（matrix/rate/面板日期/富选择等）没有可靠的「已完成」判定：一律去填
  return false
}

/**
 * 填写后回读校验。按题型选择可靠的读取方式；
 * 读取本身失败（选择器结构变化等）返回 false，由调用方决定严格/宽松处理。
 */
export async function verifyFilled(
  loc: Locator,
  q: ParsedQuestion,
  answer: AnswerValue
): Promise<boolean> {
  const a = Array.isArray(answer) ? answer : [String(answer)]
  switch (q.type) {
    case 'text':
    case 'textarea': {
      const v = await inputValueOf(loc)
      if (v === null) return false
      return v.trim() === a[0].trim()
    }
    case 'date': {
      // 宽松：格式差异（2026-09-19 vs 2026/09/19）按相似度容忍
      const v = await inputValueOf(loc)
      if (v === null) return true // 面板式选择器没有原生 value，信任点击结果
      return similarity(a[0], v.trim()) >= 0.6
    }
    case 'select': {
      const selected = await loc
        .first()
        .evaluate((node) => {
          const s = node as HTMLSelectElement
          return s.selectedOptions?.[0]?.text?.trim() ?? ''
        })
        .catch(() => '')
      if (!selected) return false
      return similarity(a[0], selected) >= 0.6
    }
    case 'radio':
    case 'judge':
      return verifyRadioGroup(loc, a[0])
    case 'checkbox':
      return verifyCheckboxGroup(loc, a)
    case 'file': {
      const v = await inputValueOf(loc)
      if (v === null) return false
      return v.length > 0
    }
    case 'switch':
      return verifySwitch(loc, a[0])
    case 'slider':
      return verifySlider(loc, a[0])
    case 'richselect':
      return verifyRichSelect(loc, answer)
    case 'richtext': {
      const t = await textOf(loc)
      if (!t) return false
      return similarity(a[0].trim(), t) >= 0.8 || t.includes(a[0].trim())
    }
    case 'matrix':
    case 'rate':
      // 结构差异大，回读不可靠：信任点击结果
      return true
    default:
      return true
  }
}
