/**
 * 渲染层 ↔ 共享契约的**行为桥接**测试。
 *
 * 「唯一知识源」有两层含义：代码里只有一份定义（由 `src/main/__tests__/single-source.test.ts`
 * 用源码扫描保证），**以及**两边跑出来的结果必须真的相同（由本文件保证）。
 * 少了第二层，就会出现「改了 shared、渲染层忘了改调用点」这种半吊子重构 ——
 * 类型检查能过（签名的没变），行为却变了。
 */
import { describe, expect, it } from 'vitest'
import { normalizeAnswers } from '../../../shared/contracts/answers'
import { contentFingerprint } from '../../../shared/contracts/hash'
import { structureText } from '../../../shared/contracts/page'
import { QUESTION_TYPES } from '../../../shared/contracts/question'
import { fingerprint, questionsFingerprint } from '../freshness'
import { pageSignature } from '../pages'
import { buildPrompt, parseImportedAnswers } from '../prompt'
import type { Question } from '../types'

describe('指纹：渲染层与共享实现同值（格式变了存量数据就废了）', () => {
  it('freshness.fingerprint 就是 contentFingerprint', () => {
    for (const s of ['', 'a', 'hello world', '<form><input name="q1"></form>']) {
      expect(fingerprint(s), JSON.stringify(s)).toBe(contentFingerprint(s))
    }
  })

  it('pageSignature 就是「结构文本 → 内容指纹」，没有额外加工', () => {
    const html = '<form class="a"><p>第一页</p><input name="809-q-1-1"></form>'
    expect(pageSignature(html)).toBe(contentFingerprint(structureText(html)))
  })

  it('题目指纹按字段显式拼接（不依赖对象键顺序，存盘读回不会误报过期）', () => {
    const base: Question = {
      id: 'q1',
      question: '满意度',
      type: 'radio',
      options: ['满意', '不满意'],
      optionValues: ['1', '2'],
      selectors: [{ css: '#q1 input' }]
    }
    const reordered: Question = {
      selectors: [{ css: '#q1 input' }],
      optionValues: ['1', '2'],
      options: ['满意', '不满意'],
      type: 'radio',
      question: '满意度',
      id: 'q1'
    }
    expect(questionsFingerprint([base])).toBe(questionsFingerprint([reordered]))
    expect(questionsFingerprint([base])).not.toBe(
      questionsFingerprint([{ ...base, question: '满意度（改过）' }])
    )
  })
})

describe('解析：粘贴导入的答案与主进程导入清洗规则一致', () => {
  it('数组转逗号、空值转空串、其余转字符串', () => {
    const r = parseImportedAnswers('{"q1":["a","b"],"q2":null,"q3":3}')
    expect(r.answers).toEqual(normalizeAnswers({ q1: ['a', 'b'], q2: null, q3: 3 }))
    expect(r.answers).toEqual({ q1: 'a,b', q2: '', q3: '3' })
  })

  it('不是合法 JSON / 不是对象时给出可读报错', () => {
    expect(parseImportedAnswers('不是 json').error).toBeTruthy()
    expect(parseImportedAnswers('[1,2]').error).toBeTruthy()
  })
})

describe('提示词：题型清单由注册表派生', () => {
  it('清单与 QUESTION_TYPES 逐字一致（手写清单最容易被漏改）', () => {
    const p = buildPrompt('<html></html>')
    expect(p).toContain(QUESTION_TYPES.join(' / '))
    expect(p).toContain('text / textarea / radio')
  })

  it('HTML 被替换进去（占位符没有漏掉）', () => {
    expect(buildPrompt('<form id="x"></form>')).toContain('<form id="x"></form>')
  })
})
