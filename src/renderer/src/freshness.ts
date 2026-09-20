/**
 * 步骤对钩的「有效性」判定：对钩代表「当前有效」，而不是「历史上做过」。
 *
 * 背景：重新抓取页面（或手工改动步骤 1 的 HTML）后，步骤 2 的题目、步骤 3 的答案
 * 其实已经对不上页面了，但对钩还亮着 —— 看着像「已完成」，实际会把上一页的答案填到新页上。
 * 这里给「题目」「答案」各记一个内容指纹，指纹一变就收回对钩（数据不删，只把状态退回待办）。
 *
 * 判定原则：
 * - 题目新鲜 ⟺ 题目存在 且 指纹与当前 HTML 一致；
 * - 答案新鲜 ⟺ 答案存在 且 题目新鲜 且 答案对应的是这一版题目（题目过期时答案一并过期）。
 * 判不出来的时候（没有 HTML、没有历史指纹）按「新鲜」处理 —— 宁可不报警，也不冤枉旧数据。
 */
import { contentFingerprint } from '../../shared/contracts/hash'
import type { Question, SelectorStrategy } from './types'

/** 指纹里的分隔符：用不会出现在正文里的控制字符，避免「拼接后撞车」 */
const UNIT = '\u0001'
const FIELD = '\u0002'
const RECORD = '\u0003'

/**
 * 通用内容指纹：`长度-FNV1a32`（同步、廉价，够用来判断「还是不是同一份内容」）。
 *
 * **算法与输出格式的唯一实现在 `shared/contracts/hash.ts`** —— 主进程的快照层用同一算法，
 * 站点记忆的题目签名用不带长度前缀的那种（`fnv1a32`）。这里保留 `fingerprint` 这个惯用名，
 * 免得把「单一知识源」的改名扩散到渲染层各处。
 *
 * ⚠️ 输出格式是存量数据的一部分（任务里的 `fp`/`questionsFor`/`answersFor` 都存它），
 * 改格式 = 所有老任务的对钩失效，不能动。
 */
export { contentFingerprint as fingerprint } from '../../shared/contracts/hash'

function selectorText(s: SelectorStrategy): string {
  return [s.css ?? '', s.xpath ?? '', s.text ?? ''].join(UNIT)
}

/**
 * 题目集指纹。
 *
 * **按字段显式拼接**，不直接 `JSON.stringify(questions)` —— 后者依赖对象键的插入顺序，
 * 存盘再读回（经过 sanitize 重建对象）可能得到不同字符串，从而导致「明明没改过却报过期」。
 */
export function questionsFingerprint(questions: Question[]): string {
  const canonical = questions
    .map((q) =>
      [
        q.id,
        q.type,
        q.question,
        q.options.join(UNIT),
        (q.optionValues ?? []).join(UNIT),
        (q.matrixRows ?? []).join(UNIT),
        q.hint ?? '',
        q.selectors.map(selectorText).join(UNIT)
      ].join(FIELD)
    )
    .join(RECORD)
  return contentFingerprint(canonical)
}

export interface FreshnessInput {
  /** 当前表单 HTML 的内容指纹（没有 HTML 时传 ''） */
  htmlFp: string
  /** 当前是否有 HTML（没有 HTML 就无从判断题目是不是过期） */
  hasHtml: boolean
  questions: Question[]
  /** 是否已填过答案（一条非空即可） */
  hasAnswers: boolean
  /** 生成题目时所记的 HTML 指纹（旧数据可能没有） */
  questionsFor?: string
  /** 生成答案时所记的题目指纹（旧数据可能没有） */
  answersFor?: string
}

export interface Freshness {
  /** 题目是上一版页面生成的 → 步骤 2 的对钩要收回 */
  questionsStale: boolean
  /** 答案对不上现有题目（含「题目已过期」的级联）→ 步骤 3/4 的对钩要收回 */
  answersStale: boolean
}

export function freshnessOf(input: FreshnessInput): Freshness {
  const questionsStale =
    input.questions.length > 0 &&
    input.hasHtml &&
    !!input.questionsFor &&
    input.questionsFor !== input.htmlFp

  // 题目一过期，答案一律跟着过期（题目都不对了，下游不可能还算「完成」）
  const answersStale =
    input.hasAnswers &&
    input.questions.length > 0 &&
    (questionsStale ||
      (!!input.answersFor && input.answersFor !== questionsFingerprint(input.questions)))

  return { questionsStale, answersStale }
}
