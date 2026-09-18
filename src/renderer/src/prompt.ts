import type { Question, QuestionType, SelectorStrategy } from './types'

/**
 * 提示词模板一：让 LLM 分析 HTML，产出「题干 + 题型 + 选项 + 定位回退链」。
 * 选项由 AI 给出（方便界面下拉选择），脚本运行时若选项缺失会动态读取兜底。
 * 唯一变量是 {{HTML}}。
 */
const PROMPT_TEMPLATE = `你是网页表单自动化配置专家。下面是某网页表单/问卷的 HTML 源码。

请分析其中所有需要用户「填写」或「作答」的题目，并为每道题生成一个 JSON 对象；所有对象组成一个 JSON 数组，数组顺序与题目在页面中的出现顺序严格一致。

每道题对象的字段定义如下：
- id：题目编号，按出现顺序 "q1"、"q2"… 递增
- question：题干文字；若 HTML 中无法直接判断题干，可据选项内容推断一句简短描述，实在没有则填 ""
- type：题型，只能是以下之一：text / textarea / radio / judge / checkbox / select / date / file / matrix
  · 单选用 radio；若只有「对/错」「是/否」两个选项用 judge
  · 多选用 checkbox；下拉框用 select；多行简答用 textarea；日期用 date；文件上传用 file
- options：选项文字数组（radio/checkbox/select/judge 必填，其余给 []），必须按 DOM 出现顺序
- optionValues：与 options 一一对应的 value 属性值数组；无 value 则用该选项文字本身
- selectors：定位策略数组（回退链），每项是 {"css":"…"} 或 {"xpath":"…"} 或 {"text":"题干文字"} 之一
  · 优先稳定 css：id、name、data-* 属性
  · 单选/多选：css 必须能定位到「整组选项」的全部 input（例如 input[name="q1"]），并保证 options 顺序与该组 input 的 DOM 顺序一致
  · 下拉框：css 定位到 select 元素
  · 无 id/name 时：用题干文字的 text 策略，或给出唯一定位该题容器的 css/xpath

硬性要求：
1. 一道选择题的 A/B/C/D 是它的「选项」，必须合并成一道题，绝不拆成多道。
2. 严格只输出 JSON 数组本身，不要任何解释文字、不要用 markdown 代码块包裹、不要加任何前后缀。

HTML 源码如下（以「===== HTML 开始 =====」和「===== HTML 结束 =====」为界）：

===== HTML 开始 =====
{{HTML}}
===== HTML 结束 =====
`

/** 提示词模板二：让 LLM 依据题目列表生成答案 JSON（键为 id，值为答案） */
const ANSWER_PROMPT_TEMPLATE = `你是表单填写助手。下面是一份问卷/考试的全部题目。请为每道题生成一个答案。

作答目标：
{{GOAL}}

题目列表：
{{QUESTIONS_JSON}}

输出要求：
- 输出一个 JSON 对象，键为题目 id（如 "q1"），值为该题的答案
- 单选(radio)/判断(judge)/下拉(select)：值必须是该题 options 里已列出的一个选项文字
- 多选(checkbox)：值是选项文字组成的数组
- 文本(text)/多行(textarea)：值是简短合理的文本
- 日期(date)：值是 "YYYY-MM-DD" 格式字符串
- 文件(file)：值是本地文件路径字符串
- 矩阵(matrix)：值是该题 options 里已列出的一个选项文字（应用到所有行）

严格只输出 JSON 对象，不要解释文字、不要 markdown 代码块、不要前后缀。
`

export function buildPrompt(html: string): string {
  return PROMPT_TEMPLATE.replace('{{HTML}}', html.trim())
}

export function buildAnswerPrompt(questions: Question[], goal?: string): string {
  const qs = questions.map((q) => ({
    id: q.id,
    question: q.question,
    type: q.type,
    options: q.options
  }))
  const goalText = goal && goal.trim() ? goal.trim() : '请合理作答。'
  return ANSWER_PROMPT_TEMPLATE.replace('{{GOAL}}', goalText).replace(
    '{{QUESTIONS_JSON}}',
    JSON.stringify(qs, null, 2)
  )
}

const TYPES: QuestionType[] = [
  'text',
  'textarea',
  'radio',
  'judge',
  'checkbox',
  'select',
  'date',
  'file',
  'matrix'
]

function normalizeSelector(s: Record<string, unknown>): SelectorStrategy {
  const out: SelectorStrategy = {}
  if (typeof s.css === 'string' && s.css) out.css = s.css
  if (typeof s.xpath === 'string' && s.xpath) out.xpath = s.xpath
  if (typeof s.text === 'string' && s.text) out.text = s.text
  return out
}

/** 把 AI 给出的 selector 字符串归一化为定位策略（css / xpath / text） */
function toStrategy(selector: string): SelectorStrategy {
  const s = selector.trim()
  if (s.startsWith('//') || s.startsWith('/') || s.startsWith('xpath=')) {
    return { xpath: s.replace(/^xpath=/, '') }
  }
  return { css: s }
}

function buildSelectors(o: Record<string, unknown>): SelectorStrategy[] {
  if (Array.isArray(o.selectors)) {
    return o.selectors
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map(normalizeSelector)
      .filter((s) => s.css || s.xpath || s.text)
  }
  if (typeof o.selector === 'string' && o.selector.trim()) {
    return [toStrategy(o.selector)]
  }
  return []
}

/** 校验并规范化 AI 返回的题目 JSON（容错处理常见字段缺失/类型偏差） */
export function parseImportedQuestions(
  json: string
): { questions?: Question[]; error?: string } {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { error: 'JSON 解析失败：不是合法 JSON' }
  }
  if (!Array.isArray(data)) return { error: '期望一个 JSON 数组' }

  const questions: Question[] = []
  for (let i = 0; i < data.length; i++) {
    const it = data[i]
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return { error: `第 ${i + 1} 项不是对象` }
    }
    const o = it as Record<string, unknown>

    const id = typeof o.id === 'string' && o.id ? o.id : `q${i + 1}`
    const type: QuestionType =
      typeof o.type === 'string' && (TYPES as string[]).includes(o.type)
        ? (o.type as QuestionType)
        : 'text'
    const question = typeof o.question === 'string' ? o.question : ''

    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === 'string')
      : []
    const optionValues =
      Array.isArray(o.optionValues) && o.optionValues.length > 0
        ? o.optionValues.map((v) => String(v))
        : options

    questions.push({
      id,
      question,
      type,
      options,
      optionValues,
      selectors: buildSelectors(o),
      hint: 'ai-imported'
    })
  }

  if (questions.length === 0) return { error: '没有解析到任何题目' }
  return { questions }
}

/** 校验并规范化 AI 返回的答案 JSON（{ qid: 答案 }；数组值转为逗号分隔字符串） */
export function parseImportedAnswers(
  json: string
): { answers?: Record<string, string>; error?: string } {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { error: 'JSON 解析失败：不是合法 JSON' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: '期望一个 JSON 对象（形如 { "q1": "答案" }）' }
  }
  const answers: Record<string, string> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(v)) answers[k] = v.map((x) => String(x)).join(',')
    else if (v === null || v === undefined) answers[k] = ''
    else answers[k] = String(v)
  }
  return { answers }
}
