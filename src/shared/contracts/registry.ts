/**
 * 题型能力注册表：**一处定义、多处派生**。
 *
 * 这是「改一处必须改八处」的第一个正面回应。原先这两条知识各自散落：
 *
 * | 知识 | 原先在哪 | 症状 |
 * |---|---|---|
 * | 哪些题型「回读必须严格」 | `verify.ts#STRICT_TYPES` 手写 8 项 | 与 `fillers` 的分派脱节，标注不一致时回读失败被当成「宽松」放行 |
 * | 每种题型用什么输入框编辑答案 | `TaskFlow.tsx#AnswerCell` 里的 if 链 | 新增题型界面默认给文本框，用户只能手打选项文字 |
 *
 * 现在两处都从这里派生。**新增一种题型**：在 `question.ts` 加名字 → 在这里登记一行 →
 * 若忘了登记，下面的编译期断言会直接报错（`ALL_TYPES_COVERED`）。
 *
 * 刻意不加「以后可能用得上」的字段：注册表的价值在于**被使用**，
 * 空字段只会变成下一个人不敢删的负担。M11.1/M11.2 的预检与蓝图需要什么，届时再加。
 */
import { QUESTION_TYPES, type QuestionType } from './question'

/** 答案编辑器形态（界面据此选输入控件） */
export type AnswerEditor = 'optionSelect' | 'multiText' | 'text'

/**
 * 「答案是否已经落在那个元素上」的判定方式（AI 闭环的 `done` 回读用，见 `agent.ts#refStateMatches`）。
 * 每个取值对应一种读取证据的组合，避免 agent 里再写一个题型 switch。
 */
export type AnswerMatchMode =
  /** 必须已选中，且元素名/值能对上答案（单选/多选/开关/评分） */
  | 'checkedText'
  /** 必须已选中，且值或文本与答案一致（文本/多行/富文本） */
  | 'valueText'
  /** 只要求有值（文件） */
  | 'nonEmpty'
  /** 只比文本相似（矩阵：答案应用到所有行） */
  | 'looseText'
  /** 宽松：值/文本/名称任一能对上（下拉、日期、滑块…） */
  | 'loose'

export interface QuestionTypeSpec {
  type: QuestionType
  /**
   * 填写后回读是否**严格**：不一致 → 重填一次 → 仍不一致判 `failed`。
   * 宽松题型（日期面板、评分、矩阵、富文本…）结构差异大、回读不可靠，只标记 `verified=false`。
   */
  strict: boolean
  /** 编辑答案时用哪种输入控件 */
  editor: AnswerEditor
  /**
   * 是否「文本类」题型。执行期用它识别**错配**：
   * 「题型说是文本框，定位到的却不是文本框」是升级 AI 闭环的四类触发条件之一。
   */
  textLike: boolean
  /**
   * 是否「一组多个成员」（选择题族）。这类题必须定位到**整组**而非单个选项 ——
   * 问卷平台常见「同一题每个选项 name 都不同」，只命中一个选项会填错。
   */
  grouped: boolean
  /** 回读判定方式（见 `AnswerMatchMode`） */
  matchMode: AnswerMatchMode
}

const SPECS = [
  { type: 'text', strict: true, editor: 'text', textLike: true, grouped: false, matchMode: 'valueText' },
  { type: 'textarea', strict: true, editor: 'text', textLike: true, grouped: false, matchMode: 'valueText' },
  { type: 'radio', strict: true, editor: 'optionSelect', textLike: false, grouped: true, matchMode: 'checkedText' },
  { type: 'judge', strict: true, editor: 'optionSelect', textLike: false, grouped: true, matchMode: 'checkedText' },
  { type: 'checkbox', strict: true, editor: 'multiText', textLike: false, grouped: true, matchMode: 'checkedText' },
  { type: 'select', strict: true, editor: 'optionSelect', textLike: false, grouped: false, matchMode: 'loose' },
  { type: 'date', strict: false, editor: 'text', textLike: false, grouped: false, matchMode: 'loose' },
  { type: 'file', strict: false, editor: 'text', textLike: false, grouped: false, matchMode: 'nonEmpty' },
  { type: 'matrix', strict: false, editor: 'optionSelect', textLike: false, grouped: false, matchMode: 'looseText' },
  { type: 'slider', strict: true, editor: 'text', textLike: false, grouped: false, matchMode: 'loose' },
  { type: 'rate', strict: false, editor: 'text', textLike: false, grouped: false, matchMode: 'checkedText' },
  { type: 'switch', strict: true, editor: 'text', textLike: false, grouped: false, matchMode: 'checkedText' },
  { type: 'richselect', strict: false, editor: 'text', textLike: false, grouped: false, matchMode: 'loose' },
  { type: 'richtext', strict: false, editor: 'text', textLike: true, grouped: false, matchMode: 'valueText' }
] as const satisfies readonly QuestionTypeSpec[]

export const QUESTION_TYPE_SPECS: readonly QuestionTypeSpec[] = SPECS

type UncoveredType = Exclude<QuestionType, (typeof SPECS)[number]['type']>

/**
 * 编译期完整性检查：`question.ts` 里的题型若没在本表登记，`UncoveredType` 就不是 `never`，
 * 这一行会立刻报类型错误。运行时无意义，纯粹是给编译器的断言。
 */
export const ALL_TYPES_COVERED: [UncoveredType] extends [never] ? true : never = true

const BY_TYPE = new Map<string, QuestionTypeSpec>(SPECS.map((s) => [s.type, s]))

export function specOf(type: string): QuestionTypeSpec | undefined {
  return BY_TYPE.get(type)
}

/** 派生：严格校验题型集合（原 `verify.ts#STRICT_TYPES`） */
export const STRICT_TYPES: ReadonlySet<string> = new Set(
  SPECS.filter((s) => s.strict).map((s) => s.type)
)

export function isStrictType(type: string): boolean {
  return STRICT_TYPES.has(type)
}

/** 派生：该题型的答案编辑器形态；未知题型退回文本框（与界面既有兜底一致） */
export function editorOf(type: string): AnswerEditor {
  return BY_TYPE.get(type)?.editor ?? 'text'
}

/** 派生：文本类题型集合（原 `engine.ts#isTextType` 的三个类型字面量） */
export const TEXT_LIKE_TYPES: ReadonlySet<string> = new Set(
  SPECS.filter((s) => s.textLike).map((s) => s.type)
)

export function isTextLike(type: string): boolean {
  return TEXT_LIKE_TYPES.has(type)
}

/** 派生：选择题族集合（原 `engine.ts` 与 `verify.ts#alreadyFilled` 各写一遍的三个类型） */
export const GROUP_LIKE_TYPES: ReadonlySet<string> = new Set(
  SPECS.filter((s) => s.grouped).map((s) => s.type)
)

export function isGroupLike(type: string): boolean {
  return GROUP_LIKE_TYPES.has(type)
}

/** 派生：回读判定方式；未知题型按宽松处理（不认识就别急着判失败） */
export function matchModeOf(type: string): AnswerMatchMode {
  return BY_TYPE.get(type)?.matchMode ?? 'loose'
}

/** 供一致性测试使用：本表覆盖的题型顺序应与 `QUESTION_TYPES` 完全相同 */
export const REGISTERED_TYPES: readonly string[] = SPECS.map((s) => s.type)
export { QUESTION_TYPES }
