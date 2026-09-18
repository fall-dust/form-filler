import type { Locator } from 'playwright'
import type { ParsedQuestion } from './types'
import { cssEscape } from './util'
import type { AnswerValue } from './types'
import { bestMatch } from './similarity'

/** 从页面上动态读取一组单选/多选控件的选项文字与 value */
async function readChoiceOptions(
  group: Locator
): Promise<{ options: string[]; optionValues: string[] }> {
  const page = group.page()
  const n = await group.count()
  const options: string[] = []
  const optionValues: string[] = []
  for (let i = 0; i < n; i++) {
    const el = group.nth(i)
    const value = (await el.getAttribute('value')) || ''
    let text = ''

    const id = await el.getAttribute('id')
    if (id) {
      const lbl = page.locator(`label[for="${cssEscape(id)}"]`).first()
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
 * 点选一个单选/多选控件，兼容常见 UI 库（Element UI 等）：
 * 原生 input 常被隐藏（opacity:0 / 遮罩），直接 check() 会被外层 label 或固定 header 拦截。
 * 依次回退：普通 check → force check → 点外层 label → 点 label[for] → JS 派发 click。
 */
async function checkOption(input: Locator): Promise<void> {
  const page = input.page()
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
  const wrap = input.locator('xpath=ancestor::label[1]')
  if ((await wrap.count()) > 0) {
    try {
      await wrap.click({ timeout: 1500 })
      return
    } catch {
      /* 忽略 */
    }
  }
  const id = await input.getAttribute('id')
  if (id) {
    const lbl = page.locator(`label[for="${cssEscape(id)}"]`).first()
    if ((await lbl.count()) > 0) {
      try {
        await lbl.click({ timeout: 1500 })
        return
      } catch {
        /* 忽略 */
      }
    }
  }
  await input.dispatchEvent('click')
}

async function selectChoice(
  group: Locator,
  answers: string[],
  question: ParsedQuestion
): Promise<void> {
  // 配置里没给选项（AI 导入路径）时，从页面动态读取
  let options = question.options
  let optionValues = question.optionValues
  if (options.length === 0) {
    const dyn = await readChoiceOptions(group)
    options = dyn.options
    optionValues = dyn.optionValues
  }

  for (const ans of answers) {
    let idx = bestMatch(ans, options)
    if (idx < 0) idx = bestMatch(ans, optionValues)
    if (idx < 0) throw new Error(`选项未匹配: ${ans}`)
    await checkOption(group.nth(idx))
  }
}

async function fillSelect(select: Locator, answer: string): Promise<void> {
  const options = select.locator('option')
  const n = await options.count()
  const texts: string[] = []
  for (let i = 0; i < n; i++) {
    texts.push((await options.nth(i).innerText()).trim())
  }
  const idx = bestMatch(answer, texts)
  if (idx >= 0) {
    await select.selectOption({ index: idx })
    return
  }
  throw new Error(`下拉选项未匹配: ${answer}`)
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
    case 'date':
      await loc.first().fill(String(answer))
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
    default:
      throw new Error(`未知题型: ${(question as { type: string }).type}`)
  }
}
