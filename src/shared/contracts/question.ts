/**
 * 题目结构的**唯一**定义（题型枚举 + 定位策略 + 题目对象）。
 *
 * 题型枚举原先写了四遍：`main/fill-engine/types.ts`、`renderer/src/types.ts`、
 * `renderer/src/prompt.ts#TYPES`、`main/tasks/sanitize.ts#TYPES`。四份之间没有机制
 * 保证同步 —— 加一种题型漏改其中一处，症状是「AI 生成得出来、导入时被静默降级成 text」。
 * 现在由这份常量数组派生，`QUESTION_TYPE_NAMES` 是唯一的白名单。
 *
 * 注意：**顺序有意义** —— 它同时是提示词里题型清单的展示顺序，改动顺序＝改动提示词。
 */

/** 全部题型（顺序即提示词清单顺序） */
export const QUESTION_TYPES = [
  'text',
  'textarea',
  'radio',
  'judge',
  'checkbox',
  'select',
  'date',
  'file',
  'matrix',
  'slider',
  'rate',
  'switch',
  'richselect',
  'richtext'
] as const

export type QuestionType = (typeof QUESTION_TYPES)[number]

/** 单条定位策略（回退链中的一项） */
export interface SelectorStrategy {
  css?: string
  xpath?: string
  text?: string
}

/**
 * 一道题。
 *
 * 主进程叫它 `ParsedQuestion`（解析产物）、渲染层叫它 `Question`，
 * 结构完全相同、字段语义相同 —— 这里统一取 `Question`，两端各自 re-export 旧名。
 */
export interface Question {
  id: string
  question: string
  type: QuestionType
  options: string[]
  optionValues: string[]
  matrixRows?: string[]
  selectors: SelectorStrategy[]
  hint?: string
}

/** 题型白名单判定（替代原先四处 `(TYPES as string[]).includes(x)` 的写法） */
export function isQuestionType(v: unknown): v is QuestionType {
  return typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v)
}
