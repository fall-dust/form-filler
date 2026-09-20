/**
 * M11.0 契约层的一致性测试。
 *
 * 这组测试不验证功能，它把「单一知识源」变成**可执行断言**：
 *   1. 注册表与各派生点一致 —— 新增题型不可能再漏改某一处；
 *   2. 指纹的两种输出格式被钉死 —— 改格式＝存量任务的对钩与站点记忆全失效，必须有人明确改这里的期望值；
 *   3. 「同一份知识是否又被抄了一遍」用**源码扫描**检查 —— 替代人工 grep。
 *
 * 第 3 条是 M11.0 的验收条件之一（「grep 确认重复定义归零」）。人肉 grep 会随记忆漂移，
 * 测试不会：下次谁再手写一份题型数组或选中态正则，这里立刻变红。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { normalizeAnswers } from '../../shared/contracts/answers'
import {
  CHECKED_CLASS_SOURCE,
  checkedClassRegExp,
  switchStateInPage
} from '../../shared/contracts/checked'
import { contentFingerprint, fnv1a32 } from '../../shared/contracts/hash'
import { htmlExcerpt, structureText } from '../../shared/contracts/page'
import { QUESTION_TYPES, isQuestionType } from '../../shared/contracts/question'
import {
  ALL_TYPES_COVERED,
  QUESTION_TYPE_SPECS,
  REGISTERED_TYPES,
  STRICT_TYPES,
  editorOf,
  isStrictType,
  specOf
} from '../../shared/contracts/registry'
import { sanitizeAnswers } from '../tasks/sanitize'

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

// ---------------------------------------------------------------- 题型注册表

describe('题型注册表（一处定义、多处派生）', () => {
  it('登记表覆盖全部题型，且顺序与 QUESTION_TYPES 完全一致', () => {
    expect(REGISTERED_TYPES).toEqual([...QUESTION_TYPES])
    expect(QUESTION_TYPE_SPECS.length).toBe(QUESTION_TYPES.length)
  })

  it('没有重复登记（重复会让 Map 静默覆盖，只留最后一条）', () => {
    expect(new Set(REGISTERED_TYPES).size).toBe(REGISTERED_TYPES.length)
  })

  it('编译期完整性断言成立（新增题型忘登记时这行会先报类型错）', () => {
    expect(ALL_TYPES_COVERED).toBe(true)
  })

  it('每个题型都能取到 spec；未知题型取不到（由调用方兜底）', () => {
    for (const t of QUESTION_TYPES) expect(specOf(t)).toBeDefined()
    expect(specOf('压根不存在')).toBeUndefined()
  })

  it('题型白名单判定与枚举一致', () => {
    for (const t of QUESTION_TYPES) expect(isQuestionType(t)).toBe(true)
    expect(isQuestionType('richtext2')).toBe(false)
    expect(isQuestionType(null)).toBe(false)
    expect(isQuestionType(3)).toBe(false)
  })
})

describe('严格校验题型：成员与原 verify.ts#STRICT_TYPES 逐字一致', () => {
  /** 改动这个列表＝改动「回读不一致时是否判 failed」的行为，必须是刻意的 */
  const EXPECTED = ['text', 'textarea', 'select', 'radio', 'judge', 'checkbox', 'switch', 'slider']

  it('成员集合不变', () => {
    expect([...STRICT_TYPES].sort()).toEqual([...EXPECTED].sort())
  })

  it('回读不可靠的题型不在严格集（只标 verified=false，不判 failed）', () => {
    for (const t of ['date', 'file', 'matrix', 'rate', 'richselect', 'richtext']) {
      expect(isStrictType(t), `${t} 不该是严格题型`).toBe(false)
    }
  })

  it('未知题型按宽松处理（不会因为不认识就判失败）', () => {
    expect(isStrictType('nope')).toBe(false)
  })
})

describe('答案编辑器形态：与原 TaskFlow#AnswerCell 的 if 链等价', () => {
  it('选择题族用选项下拉', () => {
    for (const t of ['radio', 'judge', 'select', 'matrix']) {
      expect(editorOf(t), t).toBe('optionSelect')
    }
  })

  it('多选用逗号分隔文本框', () => {
    expect(editorOf('checkbox')).toBe('multiText')
  })

  it('其余题型用普通文本框', () => {
    for (const t of [
      'text',
      'textarea',
      'date',
      'file',
      'slider',
      'rate',
      'switch',
      'richselect',
      'richtext'
    ]) {
      expect(editorOf(t), t).toBe('text')
    }
  })

  it('未知题型兜底为文本框', () => {
    expect(editorOf('nope')).toBe('text')
  })
})

// ------------------------------------------------------------------ 内容指纹

describe('内容指纹：两种格式都被钉死（存量数据依赖它们）', () => {
  it('fnv1a32 基准值（纯哈希，站点记忆的键）', () => {
    expect(fnv1a32('')).toBe('811c9dc5')
    expect(fnv1a32('a')).toBe('e40c292c')
    expect(fnv1a32('hello world')).toBe('d58b3fa7')
  })

  it('contentFingerprint 基准值（长度-哈希，页面/题目指纹）', () => {
    expect(contentFingerprint('hello world')).toBe('11-d58b3fa7')
    expect(contentFingerprint('<form><input name="q1"></form>')).toBe('30-fc01d16c')
  })

  it('长度参与指纹（同哈希不同长度的内容不会撞车）', () => {
    expect(contentFingerprint('ab')).toMatch(/^2-[0-9a-f]{8}$/)
    expect(contentFingerprint('ab')).not.toBe(contentFingerprint('ba'))
  })
})

// ---------------------------------------------------------------- 答案归一化

describe('答案归一化：两处调用同一个函数', () => {
  it('主进程导入清洗与渲染层粘贴导入是同一实现（不是「抄得像」）', () => {
    expect(sanitizeAnswers).toBe(normalizeAnswers)
  })

  it('数组转逗号、空值转空串、其余转字符串', () => {
    expect(normalizeAnswers({ a: ['x', 'y'], b: null, c: 3, d: undefined })).toEqual({
      a: 'x,y',
      b: '',
      c: '3',
      d: ''
    })
  })

  it('非对象一律空表（含数组与字符串，避免把 ["a"] 当成 {0:"a"}）', () => {
    for (const v of [null, undefined, 'x', 3, [1, 2]]) expect(normalizeAnswers(v)).toEqual({})
  })
})

// ---------------------------------------------------------------- 页面摘要

describe('页面摘要：两种摘要各司其职，实现只有一份', () => {
  it('htmlExcerpt 去标签留文字、压空白', () => {
    expect(htmlExcerpt('<p>你好   世界</p><script>var a = 1</script>')).toBe('你好 世界')
    expect(htmlExcerpt('<p>一二三四五</p>', 3)).toBe('一二三')
  })

  it('structureText 丢属性、压长数字（腾讯问卷那种随机前缀必须认作同一页）', () => {
    const a = structureText('<form class="a"><input name="809-q-1-1"></form>')
    const b = structureText('<form class="b" data-v-9f2c><input name="1207-q-1-1"></form>')
    expect(a).toBe(b)
  })

  it('structureText 保留可见文字（题干变了必须能认出来）', () => {
    expect(structureText('<p>满意度</p>')).not.toBe(structureText('<p>年龄段</p>'))
  })
})

// -------------------------------------------------------- 选中态知识（注入型）

describe('「已选中」判定：唯一来源，且注入后仍自包含', () => {
  it('类名正则覆盖四套 UI 库', () => {
    const rx = checkedClassRegExp()
    for (const cls of ['is-checked', 'is-selected', 'ant-radio-checked', 'ant-checkbox-checked', 't-is-checked']) {
      expect(rx.test(`foo ${cls} bar`), cls).toBe(true)
    }
    expect(rx.test('unchecked')).toBe(false)
    expect(CHECKED_CLASS_SOURCE).toContain('t-is-checked')
  })

  it('switch 状态读取函数可被注入浏览器（不引用任何模块标识符）', () => {
    const code = switchStateInPage.toString()
    // 会被 toString() 送进页面执行：出现 import / 模块常量名就会在页面里 ReferenceError
    expect(code).not.toMatch(/\bimport\b/)
    expect(code).not.toMatch(/CHECKED_CLASS_SOURCE/)
    // 关键分支必须真在里面（这句是行为兼容点：子串匹配而非词边界）
    expect(code).toContain('ant-switch-checked')
  })
})

// ------------------------------------------------- 重复定义归零（源码扫描）

describe('重复定义归零：同一份知识不再被抄第二遍', () => {
  it('选中态类名只在 checked.ts 出现（verify/fillers 都不许内联）', () => {
    const files = ['src/main/fill-engine/verify.ts', 'src/main/fill-engine/fillers.ts']
    for (const f of files) {
      const text = src(f)
      expect(text, `${f} 仍内联 ant-radio-checked`).not.toContain('ant-radio-checked')
      expect(text, `${f} 仍内联 'ant-switch-checked'`).not.toContain("'ant-switch-checked'")
      expect(text, `${f} 仍内联 'is-checked' 字面量`).not.toContain("'is-checked'")
    }
  })

  it('FNV1a 常量只在 hash.ts 出现（不许各处再写一遍魔术数）', () => {
    for (const f of ['src/renderer/src/freshness.ts', 'src/renderer/src/pages.ts']) {
      expect(src(f), `${f} 仍内联 FNV1a 常量`).not.toContain('0x811c9dc5')
    }
  })

  it('题型数组只在 question.ts 出现（四处枚举已收敛）', () => {
    const ARRAY_START = /['"]text['"]\s*,\s*\n\s*['"]textarea['"]/
    for (const f of [
      'src/renderer/src/prompt.ts',
      'src/renderer/src/types.ts',
      'src/main/tasks/sanitize.ts',
      'src/main/fill-engine/types.ts'
    ]) {
      expect(src(f), `${f} 仍手写题型数组`).not.toMatch(ARRAY_START)
    }
    expect(src('src/shared/contracts/question.ts')).toMatch(ARRAY_START)
  })

  it('注入型函数不再内联选中态正则（改为按参数接收）', () => {
    expect(src('src/main/fill-engine/verify.ts')).toContain('CHECKED_CLASS_SOURCE')
    expect(src('src/main/fill-engine/fillers.ts')).toContain('switchStateInPage')
  })

  it('提示词的题型清单由注册表派生（不再是手写字符串）', () => {
    const promptSrc = src('src/renderer/src/prompt.ts')
    expect(promptSrc).toContain('QUESTION_TYPES.join')
    expect(promptSrc).toContain('{{TYPES}}')
  })

  it('渲染层与主进程的指纹/摘要都从 shared 取（不各写一份）', () => {
    expect(src('src/renderer/src/freshness.ts')).toContain("shared/contracts/hash")
    expect(src('src/renderer/src/pages.ts')).toContain("shared/contracts/page")
    expect(src('src/renderer/src/prompt.ts')).toContain("shared/contracts/answers")
    expect(src('src/main/tasks/sanitize.ts')).toContain("shared/contracts/answers")
  })
})
