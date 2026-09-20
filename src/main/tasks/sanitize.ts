/**
 * 导入数据的清洗与校验（容错：字段缺失/类型偏差一律归一到合法结构）。
 * 与渲染层 prompt.ts 的 parseImportedQuestions 思路一致，但这里是主进程侧的
 * 最后一道防线 —— 导入文件可能来自任意来源，宁可丢弃坏字段也不能让脏数据进库。
 */
import { normalizeAnswers } from '../../shared/contracts/answers'
import { isQuestionType } from '../../shared/contracts/question'
import type { ParsedQuestion, QuestionType, SelectorStrategy } from '../fill-engine/types'
import type { TaskPage } from './types'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function sanitizeSelectors(v: unknown): SelectorStrategy[] {
  if (!Array.isArray(v)) return []
  const out: SelectorStrategy[] = []
  for (const item of v) {
    if (!isRecord(item)) continue
    const s: SelectorStrategy = {}
    if (typeof item.css === 'string' && item.css.trim()) s.css = item.css.trim()
    if (typeof item.xpath === 'string' && item.xpath.trim()) s.xpath = item.xpath.trim()
    if (typeof item.text === 'string' && item.text.trim()) s.text = item.text.trim()
    if (s.css || s.xpath || s.text) out.push(s)
  }
  return out
}

/** 把任意来源的题目数组归一化为合法的 ParsedQuestion[]（无法识别的条目直接丢弃） */
export function sanitizeQuestions(v: unknown): ParsedQuestion[] {
  if (!Array.isArray(v)) return []
  const out: ParsedQuestion[] = []
  v.forEach((raw, i) => {
    if (!isRecord(raw)) return
    // 白名单来自 `shared/contracts/question.ts`（原先这里另有一份 TYPES 数组）
    const type: QuestionType = isQuestionType(raw.type) ? raw.type : 'text'
    const options = Array.isArray(raw.options)
      ? raw.options.filter((x): x is string => typeof x === 'string')
      : []
    const optionValues =
      Array.isArray(raw.optionValues) && raw.optionValues.length > 0
        ? raw.optionValues.map((x) => String(x))
        : options
    const matrixRows = Array.isArray(raw.matrixRows)
      ? raw.matrixRows.filter((x): x is string => typeof x === 'string')
      : undefined
    out.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `q${i + 1}`,
      question: typeof raw.question === 'string' ? raw.question : '',
      type,
      options,
      optionValues,
      ...(matrixRows && matrixRows.length > 0 ? { matrixRows } : {}),
      selectors: sanitizeSelectors(raw.selectors),
      ...(typeof raw.hint === 'string' && raw.hint ? { hint: raw.hint } : {})
    })
  })
  return out
}

/**
 * 答案表归一化：值一律转字符串（数组用逗号连接，与渲染层约定一致）。
 *
 * 实现与渲染层「粘贴导入」共用同一份（`shared/contracts/answers.ts`）——
 * 这里处理的是外部导入文件（不可信），是最后一道防线，规则更不能与别处不同。
 */
export const sanitizeAnswers = normalizeAnswers

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** 可选字符串：空串一律归一为「没有」（指纹/URL 这类字段缺省 = 判不了） */
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** 页 id 只允许文件名安全字符（它同时是 HTML 的文件名） */
export function safePageId(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : fallback
}

/**
 * 页面存档归一化。
 *
 * 页面存档可能来自 config.json（自己写的，可信）或导入文件（外部，不可信），
 * 故这里按「宁可丢字段也不能让坏数据进库」处理：id 必须是文件名安全字符且互不重复，
 * 题目与答案走同一套清洗，指纹/时间等辅助字段不合规就丢掉。
 */
export function sanitizePages(v: unknown): TaskPage[] {
  if (!Array.isArray(v)) return []
  const out: TaskPage[] = []
  const used = new Set<string>()
  v.forEach((raw, i) => {
    if (!isRecord(raw)) return
    let id = safePageId(raw.id, `p${i + 1}`)
    for (let n = 2; used.has(id); n++) id = `p${i + 1}-${n}`
    used.add(id)
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : ''
    out.push({
      id,
      name: name || `第 ${i + 1} 页`,
      ...(typeof raw.nameAuto === 'boolean' ? { nameAuto: raw.nameAuto } : {}),
      ...(optStr(raw.capturedAt) ? { capturedAt: raw.capturedAt as string } : {}),
      ...(optStr(raw.url) ? { url: raw.url as string } : {}),
      ...(optStr(raw.fp) ? { fp: raw.fp as string } : {}),
      ...(optStr(raw.sig) ? { sig: raw.sig as string } : {}),
      questions: sanitizeQuestions(raw.questions),
      answers: sanitizeAnswers(raw.answers),
      ...(optStr(raw.questionsFor) ? { questionsFor: raw.questionsFor as string } : {}),
      ...(optStr(raw.answersFor) ? { answersFor: raw.answersFor as string } : {})
    })
  })
  return out
}
