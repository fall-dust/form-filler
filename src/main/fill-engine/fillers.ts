import type { Locator } from 'playwright-core'
import { switchStateInPage } from '../../shared/contracts/checked'
import type { ParsedQuestion } from './types'
import { cssEscape } from './util'
import type { AnswerValue } from './types'
import { bestMatch } from './similarity'
import { isChoiceChecked } from './verify'

/** 元素所在文档的 body（同 frame 根，用于文档级查找，兼容 iframe） */
function docRoot(el: Locator): Locator {
  return el.locator('xpath=ancestor::body')
}

/** 读属性：默认 30s 会拖死流程（元素被框架重渲染掉时会空等）。一律短超时 + 返回 null */
const ATTR_TIMEOUT = 2000

async function attrOnce(loc: Locator, name: string): Promise<string | null> {
  try {
    return await loc.getAttribute(name, { timeout: ATTR_TIMEOUT })
  } catch {
    return null
  }
}

/** 尽力点击：不存在/不可见/被重渲染掉都不抛错，只回「有没有点到」 */
async function clickQuietly(loc: Locator, timeout = 1500): Promise<boolean> {
  const n = await loc.count().catch(() => 0)
  if (n === 0) return false
  try {
    await loc.click({ timeout })
    return true
  } catch {
    /* 落到下面的 JS 派发 */
  }
  try {
    await loc.dispatchEvent('click')
    return true
  } catch {
    return false
  }
}

/** 等待动态渲染的选项出现（懒加载/点开才渲染），最多 5s */
async function waitForChoiceGroup(group: Locator): Promise<number> {
  const n0 = await group.count()
  if (n0 > 0) return n0
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await group.page().waitForTimeout(300)
    const n = await group.count()
    if (n > 0) return n
  }
  return 0
}

/** 从页面上动态读取一组单选/多选控件的选项文字与 value */
export async function readChoiceOptions(
  group: Locator
): Promise<{ options: string[]; optionValues: string[] }> {
  const n = await group.count()
  const options: string[] = []
  const optionValues: string[] = []
  for (let i = 0; i < n; i++) {
    const el = group.nth(i)
    const value = (await attrOnce(el, 'value')) || ''
    let text = ''

    // label[for] 从元素所在文档根查（兼容 iframe 内控件）
    const id = await attrOnce(el, 'id')
    if (id) {
      const lbl = docRoot(el).locator(`label[for="${cssEscape(id)}"]`).first()
      if ((await lbl.count()) > 0) text = (await lbl.innerText()).trim()
    }
    if (!text) {
      const wrap = el.locator('xpath=ancestor::label[1]')
      if ((await wrap.count()) > 0) text = (await wrap.innerText()).trim()
    }
    if (!text) {
      const parent = el.locator('xpath=..')
      if ((await parent.count()) > 0) text = (await parent.innerText()).trim()
    }

    options.push(text || value)
    optionValues.push(value)
  }
  return { options, optionValues }
}

/**
 * 自定义控件的「选项容器」候选。选中逻辑挂在**外层可见容器**上，点隐藏的原生 input
 * 或只派发 click 事件都可能不触发组件状态更新（问卷网 `ws-radio` 就是这种）。
 * XPath 的 `ancestor::*[...][1]` 在反向轴上取**最近**的祖先，正好命中单个选项容器。
 */
const CHOICE_BOX_XPATHS = [
  'xpath=ancestor::*[@role="radio" or @role="checkbox"][1]',
  'xpath=ancestor::*[contains(@class,"ws-radio") or contains(@class,"ws-checkbox")][1]',
  'xpath=ancestor::*[contains(@class,"t-radio") or contains(@class,"t-checkbox")][1]',
  'xpath=ancestor::*[contains(@class,"el-radio") or contains(@class,"el-checkbox")][1]',
  'xpath=ancestor::*[contains(@class,"ant-radio") or contains(@class,"ant-checkbox")][1]'
]

/**
 * 点选一个单选/多选控件，兼容常见 UI 库（Element UI / TDesign / 问卷网等）：
 * 原生 input 常被隐藏（opacity:0 / 零尺寸 / aria-hidden），直接 check() 会白等到超时。
 * 依次回退：可见才走原生 check → 点可见的组件容器（点后回读确认）→ 祖先 label
 * → label[for] → 同容器兄弟 label → 选项容器内 label → JS 派发 click。
 * 全程不抛错（框架重渲染会让句柄失效）。
 */
export async function checkOption(input: Locator): Promise<void> {
  // 附属在自定义控件里的原生 input（aria-hidden）—— 选中逻辑在外层容器上，
  // 对它 check() 只会白等到超时，直接走容器点击（问卷网 ws-radio 就是这种）
  const decorative = await input
    .first()
    .evaluate((n) => n.getAttribute('aria-hidden') === 'true', undefined, { timeout: 800 })
    .catch(() => false)
  const visible = decorative ? false : await input.first().isVisible().catch(() => false)
  if (visible) {
    try {
      await input.check({ timeout: 1500 })
      return
    } catch {
      /* 忽略，尝试下一种 */
    }
    try {
      await input.check({ force: true, timeout: 1500 })
      return
    } catch {
      /* 忽略 */
    }
  }

  // 点外层可见容器，由组件自身逻辑完成选中；点完回读确认，没选中就继续试下一条
  for (const xp of CHOICE_BOX_XPATHS) {
    const box = input.locator(xp).first()
    if ((await box.count().catch(() => 0)) === 0) continue
    if (!(await box.isVisible().catch(() => false))) continue
    if (await clickQuietly(box)) {
      await input.page().waitForTimeout(100).catch(() => {})
      if (await isChoiceChecked(input)) return
    }
  }

  // 1) label 包裹 input 的写法
  if (await clickQuietly(input.locator('xpath=ancestor::label[1]'))) return

  // 2) 腾讯问卷 / TDesign：input 与 <label for> 是兄弟节点，label 在同一个选项容器里
  const id = await attrOnce(input, 'id')
  const candidates: Locator[] = []
  if (id) candidates.push(docRoot(input).locator(`label[for="${cssEscape(id)}"]`).first())
  candidates.push(input.locator('xpath=..').locator('label').first())
  candidates.push(
    input
      .locator(
        'xpath=ancestor::*[contains(@class,"checkbox-option") or contains(@class,"option") or contains(@class,"t-radio") or contains(@class,"t-checkbox")][1]'
      )
      .locator('label')
      .first()
  )
  for (const c of candidates) {
    if (await clickQuietly(c)) return
  }

  // 3) 最后的原生派发（元素可能已被框架重渲染，失败也不抛）
  await input.dispatchEvent('click').catch(() => {})
}

async function selectChoice(
  group: Locator,
  answers: string[],
  question: ParsedQuestion
): Promise<void> {
  // 配置里没给选项（AI 导入路径）时，从页面动态读取（懒加载则等待出现）
  let options = question.options
  let optionValues = question.optionValues
  if (options.length === 0) {
    await waitForChoiceGroup(group)
    const dyn = await readChoiceOptions(group)
    options = dyn.options
    optionValues = dyn.optionValues
  }

  const n = await group.count()
  for (const ans of answers) {
    let idx = bestMatch(ans, options)
    if (idx < 0) idx = bestMatch(ans, optionValues)
    if (idx < 0) throw new Error(`选项未匹配: ${ans}`)
    // 选择器只命中单个选项时（某些平台的每个选项 name 不同），报出可操作的原因
    if (idx >= n) {
      throw new Error(
        `定位到的选项不足：要选第 ${idx + 1} 个「${ans}」，但选择器只命中 ${n} 个控件（多半是指向了单个选项，请改用题目容器整组选择器，如 #题目容器 input[type=radio]）`
      )
    }
    await checkOption(group.nth(idx))
  }
}

async function fillSelect(select: Locator, answer: string): Promise<void> {
  const options = select.locator('option')
  let n = await options.count()
  // 原生 select 也可能异步填充选项，等待最多 5s
  if (n === 0) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && n === 0) {
      await select.page().waitForTimeout(300)
      n = await options.count()
    }
  }
  const texts: string[] = []
  for (let i = 0; i < n; i++) {
    texts.push((await options.nth(i).innerText()).trim())
  }
  const idx = bestMatch(answer, texts)
  if (idx >= 0) {
    await select.selectOption({ index: idx })
    return
  }
  // 原生 fill 失败的部分自定义下拉（select 伪装）：交给 richselect 思路兜底
  await fillRichSelect(select, [answer], { id: '', question: '', options: [], optionValues: [], type: 'richselect', selectors: [] })
}

/**
 * 日期填写：先尝试原生 input fill；失败（面板式日期选择器）后
 * 点击输入框唤起面板，在可见日期面板里按"日"文本点选。
 */
async function fillDate(loc: Locator, answer: string): Promise<void> {
  const el = loc.first()
  try {
    await el.fill(answer, { timeout: 3000 })
    return
  } catch {
    /* 非原生 date 输入，走面板 */
  }
  // 面板式：el-date-picker / ant-picker 等
  await el.click({ timeout: 3000 }).catch(() => el.dispatchEvent('click'))
  const frameRoot = docRoot(el)
  const panel = frameRoot.locator(
    '.el-picker-panel:visible, .el-date-picker:visible, .el-picker-panel__body:visible, .ant-picker-dropdown:visible, [class*="date-picker"]:visible, [class*="picker-panel"]:visible'
  )
  try {
    await panel.first().waitFor({ state: 'visible', timeout: 4000 })
  } catch {
    throw new Error(`日期面板未弹出: ${answer}`)
  }
  // 目标"日"：取答案末段（YYYY-MM-DD → 19）
  const day = answer.split(/[-/.]/).pop()?.replace(/^0/, '') ?? ''
  if (!day) throw new Error(`日期格式无法解析: ${answer}`)
  const cells = panel.locator(
    'td.available, .el-date-table td.available, .ant-picker-cell:not(.ant-picker-cell-disabled), td, button, span'
  )
  const n = await cells.count()
  for (let i = 0; i < n; i++) {
    const t = (await cells.nth(i).innerText().catch(() => '')).trim()
    if (t === day || t === answer) {
      const cell = cells.nth(i)
      try {
        await cell.click({ timeout: 1500 })
      } catch {
        await cell.dispatchEvent('click')
      }
      return
    }
  }
  throw new Error(`日期面板中未找到目标日期: ${answer}`)
}

/** 滑条：原生 range 直接赋值；UI 库滑条回退为按百分比坐标点击轨道 */
export async function fillSlider(loc: Locator, answer: string): Promise<void> {
  const el = loc.first()
  const target = parseFloat(answer)
  if (Number.isNaN(target)) throw new Error(`滑条答案不是数字: ${answer}`)

  const info = await el
    .evaluate((node) => {
      const n = node as HTMLElement
      const input =
        n instanceof HTMLInputElement && n.type === 'range'
          ? n
          : n.querySelector<HTMLInputElement>('input[type="range"]')
      if (input) {
        return { kind: 'native' as const, min: parseFloat(input.min || '0'), max: parseFloat(input.max || '100') }
      }
      const ariaMin = n.getAttribute('aria-valuemin') ?? n.getAttribute('aria-valuemax')
      void ariaMin
      return { kind: 'widget' as const, min: NaN, max: NaN }
    })
    .catch(() => null)
  if (!info) throw new Error('滑条元素不可读')

  if (info.kind === 'native') {
    const isSelf = await el.evaluate((n) => n instanceof HTMLInputElement && (n as HTMLInputElement).type === 'range')
    const input = isSelf ? el : el.locator('input[type="range"]').first()
    await input.evaluate((node, v) => {
      const i = node as HTMLInputElement
      i.value = String(v)
      i.dispatchEvent(new Event('input', { bubbles: true }))
      i.dispatchEvent(new Event('change', { bubbles: true }))
    }, target)
    // 校验是否生效（UI 库可能由 Vue/React 接管，未生效则走坐标）
    const applied = await el
      .evaluate((node) => {
        const n = node as HTMLElement
        const input =
          n instanceof HTMLInputElement && n.type === 'range'
            ? n
            : n.querySelector<HTMLInputElement>('input[type="range"]')
        return input ? parseFloat(input.value) : NaN
      })
      .catch(() => NaN)
    if (!Number.isNaN(applied) && Math.abs(applied - target) < 1e-6) return
  }

  // 坐标点击：value → 百分比 → 轨道位置
  const min = Number.isNaN(info.min) ? 0 : info.min
  const max = Number.isNaN(info.max) ? 100 : info.max
  const pct = Math.min(1, Math.max(0, (target - min) / (max - min)))
  const box = await el.boundingBox()
  if (!box) throw new Error('滑条不可见（无 boundingBox）')
  await el.page().mouse.click(box.x + box.width * pct, box.y + box.height / 2)
}

/** 星级评分：点第 N 颗星（多级点选回退复用 checkOption） */
async function fillRate(loc: Locator, answer: string): Promise<void> {
  const root = loc.first()
  const n = parseInt(answer, 10)
  if (Number.isNaN(n) || n < 1) throw new Error(`评分答案无效: ${answer}`)

  const stars = root.locator(
    '.el-rate__item, .ant-rate-star, [class*="rate"] > i, [class*="star"], li, i, svg'
  )
  let count = await stars.count()
  // 过滤：只保留真实可见的直接子元素层级（避免 svg 内部元素干扰）
  if (count < n) {
    const children = root.locator('xpath=./*')
    count = await children.count()
    if (count >= n) {
      const target = children.nth(n - 1)
      await checkOption(target)
      return
    }
    throw new Error(`星级控件可点击项不足（需要 ${n}，发现 ${count}）`)
  }
  await checkOption(stars.nth(n - 1))
}

/** 开关：目标态与当前态不一致才点击 */
async function fillSwitch(loc: Locator, answer: string): Promise<void> {
  const el = loc.first()
  const target = ['true', '1', 'on', 'yes', 'y', '是', '开', '启用', '打开'].includes(
    answer.trim().toLowerCase()
  )
  // 读法与回读校验（verify.ts#verifySwitch）共用同一个函数：两处各写一份的话，
  // 一旦漂移就会出现「填的时候认为已经是目标态、回读时认为不是」的死循环。
  const current = await el
    .evaluate(switchStateInPage, undefined, { timeout: ATTR_TIMEOUT })
    .catch(() => null)
  if (current !== null && current === target) return // 已是目标态
  await checkOption(el)
}

/** 自定义下拉浮层（含 TDesign `.t-*`，腾讯问卷等平台用它渲染下拉） */
const POPUP_SEL = [
  '.t-select__dropdown:visible',
  '.t-select__panel:visible',
  '.t-popup:visible',
  '.t-cascader__panel:visible',
  '.el-select-dropdown:visible',
  '.el-select__popper:visible',
  '.ant-select-dropdown:visible',
  '[role="listbox"]:visible'
].join(', ')

/** 浮层内的选项 */
const POPUP_ITEM_SEL = [
  '.t-select-option',
  '.t-select__list li',
  '.t-cascader__item',
  '.el-select-dropdown__item',
  '.ant-select-item-option',
  '[role="option"]',
  'li'
].join(', ')

/**
 * 自定义下拉（div 模拟，el-select / antd Select / TDesign Select / 腾讯问卷）：
 * 点击展开 → 同文档浮层里读选项 → 相似度匹配 → 点选 → 收起。
 * 浮层内带搜索框（可搜索下拉）时先输入答案过滤，可显著加快长列表定位。
 * 多选时重复"展开-点选"。
 */
export async function fillRichSelect(
  loc: Locator,
  answers: string[],
  _question: ParsedQuestion
): Promise<void> {
  const trigger = loc.first()
  // 浮层与触发器同文档（可能在 iframe 内），用文档级 root 保证同 frame 搜索
  const frameRoot = docRoot(trigger)

  for (const ans of answers) {
    try {
      await trigger.click({ timeout: 2000 })
    } catch {
      await trigger.dispatchEvent('click')
    }
    const popup = frameRoot.locator(POPUP_SEL).first()
    try {
      await popup.waitFor({ state: 'visible', timeout: 5000 })
    } catch {
      throw new Error(`下拉浮层未弹出: ${ans}`)
    }
    const items = popup.locator(POPUP_ITEM_SEL)

    // 可搜索下拉：先在浮层搜索框里输入答案过滤（没过滤到再清空用全量列表兜底）
    const search = popup.locator('input:not([readonly]):visible').first()
    const canSearch = (await search.count().catch(() => 0)) > 0
    let idx = -1
    for (const filtered of canSearch ? [true, false] : [false]) {
      if (filtered) {
        await search.fill(ans, { timeout: 2000 }).catch(() => {})
      } else if (canSearch) {
        await search.fill('', { timeout: 2000 }).catch(() => {})
      }
      let n = await items.count()
      if (n === 0) {
        const deadline = Date.now() + 4000
        while (Date.now() < deadline && n === 0) {
          await trigger.page().waitForTimeout(300)
          n = await items.count()
        }
      }
      const texts: string[] = []
      for (let i = 0; i < n; i++) {
        texts.push((await items.nth(i).innerText().catch(() => '')).trim())
      }
      idx = bestMatch(ans, texts)
      if (idx >= 0) break
    }
    if (idx < 0) throw new Error(`下拉选项未匹配: ${ans}`)
    const item = items.nth(idx)
    try {
      await item.click({ timeout: 1500 })
    } catch {
      await item.dispatchEvent('click')
    }
    // 单选：等浮层收起再继续；多选：浮层通常保持展开
    if (answers.length === 1) {
      await popup
        .waitFor({ state: 'hidden', timeout: 2500 })
        .catch(() => trigger.click({ timeout: 1000 }).catch(() => {}))
    }
  }
}

/** 富文本（contenteditable）：点击聚焦后用键盘插入文本（兼容 React/Vue 受控） */
async function fillRichText(loc: Locator, answer: string): Promise<void> {
  const el = loc.first()
  try {
    await el.click({ timeout: 3000 })
  } catch {
    await el.dispatchEvent('click')
  }
  await el.page().keyboard.insertText(answer)
  // blur 触发 onChange/onBlur 校验
  await el.page().keyboard.press('Escape').catch(() => {})
}

async function fillMatrix(
  table: Locator,
  question: ParsedQuestion,
  answer: AnswerValue
): Promise<void> {
  const rows = question.matrixRows ?? []
  const answers = Array.isArray(answer) ? answer : Array(rows.length).fill(answer)
  for (let i = 0; i < rows.length; i++) {
    const optIdx = bestMatch(String(answers[i] ?? answers[0]), question.options)
    if (optIdx < 0) continue
    const row = table.locator('tbody tr').nth(i)
    const cell = row.locator('td').nth(optIdx + 1)
    await checkOption(cell.locator('input[type="radio"]'))
  }
}

/** 按题型填写（loc 为 resolveQuestion 命中的定位器） */
export async function fillByType(
  question: ParsedQuestion,
  loc: Locator,
  answer: AnswerValue
): Promise<void> {
  switch (question.type) {
    case 'text':
    case 'textarea':
      await loc.first().fill(String(answer))
      break
    case 'date':
      await fillDate(loc, String(answer))
      break
    case 'select':
      await fillSelect(loc.first(), String(answer))
      break
    case 'radio':
    case 'judge':
      await selectChoice(loc, [String(answer)], question)
      break
    case 'checkbox':
      await selectChoice(
        loc,
        Array.isArray(answer) ? answer : [String(answer)],
        question
      )
      break
    case 'file':
      await loc.first().setInputFiles(Array.isArray(answer) ? answer : [String(answer)])
      break
    case 'matrix':
      await fillMatrix(loc.first(), question, answer)
      break
    case 'slider':
      await fillSlider(loc, String(answer))
      break
    case 'rate':
      await fillRate(loc, String(answer))
      break
    case 'switch':
      await fillSwitch(loc, String(answer))
      break
    case 'richselect':
      await fillRichSelect(
        loc,
        Array.isArray(answer) ? answer : [String(answer)],
        question
      )
      break
    case 'richtext':
      await fillRichText(loc, String(answer))
      break
    default:
      throw new Error(`未知题型: ${(question as { type: string }).type}`)
  }
}
