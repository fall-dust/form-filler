import { describe, expect, it } from 'vitest'
import { fingerprint, freshnessOf, questionsFingerprint } from '../freshness'
import type { Question } from '../types'

function q(id: string, over: Partial<Question> = {}): Question {
  return {
    id,
    question: `题干 ${id}`,
    type: 'radio',
    options: ['A', 'B'],
    optionValues: ['A', 'B'],
    selectors: [{ css: `input[name="${id}"]` }],
    ...over
  }
}

const HTML_1 = '<form><input name="q1"></form>'
const HTML_2 = '<form><input name="q9"></form>'

describe('内容指纹', () => {
  it('同内容同指纹；长度或内容不同则不同', () => {
    expect(fingerprint(HTML_1)).toBe(fingerprint(HTML_1))
    expect(fingerprint(HTML_1)).not.toBe(fingerprint(HTML_2))
    expect(fingerprint('ab')).not.toBe(fingerprint('ba'))
  })

  it('题目指纹与对象键序无关（存盘再读回重建对象后仍一致）', () => {
    const a = q('q1')
    const b: Question = {
      selectors: a.selectors,
      optionValues: a.optionValues,
      options: a.options,
      type: a.type,
      question: a.question,
      id: a.id
    }
    expect(questionsFingerprint([b])).toBe(questionsFingerprint([a]))
  })

  it('题目内容变了指纹就变（同 id 不同题也算变了）', () => {
    expect(questionsFingerprint([q('q1', { question: '换了' })])).not.toBe(questionsFingerprint([q('q1')]))
    expect(questionsFingerprint([q('q1', { options: ['A', 'C'] })])).not.toBe(questionsFingerprint([q('q1')]))
    expect(questionsFingerprint([q('q1'), q('q2')])).not.toBe(questionsFingerprint([q('q2'), q('q1')]))
  })
})

describe('步骤对钩的有效性判定', () => {
  const base = {
    htmlFp: fingerprint(HTML_1),
    hasHtml: true,
    questions: [q('q1')],
    hasAnswers: true
  }

  it('指纹都对得上 → 题目与答案都有效', () => {
    const f = freshnessOf({
      ...base,
      questionsFor: fingerprint(HTML_1),
      answersFor: questionsFingerprint([q('q1')])
    })
    expect(f).toEqual({ questionsStale: false, answersStale: false })
  })

  it('重新抓取换了页面 → 题目过期，答案级联过期（对钩一起收回）', () => {
    const f = freshnessOf({
      ...base,
      htmlFp: fingerprint(HTML_2), // 页面已经换成新的一页
      questionsFor: fingerprint(HTML_1), // 题目还是按上一页生成的
      answersFor: questionsFingerprint([q('q1')])
    })
    expect(f.questionsStale).toBe(true)
    expect(f.answersStale).toBe(true)
  })

  it('题目换了但答案没重生成 → 题目有效、答案过期', () => {
    const f = freshnessOf({
      ...base,
      questions: [q('q1', { question: '换了' })],
      questionsFor: fingerprint(HTML_1),
      answersFor: questionsFingerprint([q('q1')]) // 记的是旧题目
    })
    expect(f.questionsStale).toBe(false)
    expect(f.answersStale).toBe(true)
  })

  it('还没填过答案 → 不算「答案过期」', () => {
    const f = freshnessOf({
      ...base,
      hasAnswers: false,
      htmlFp: fingerprint(HTML_2),
      questionsFor: fingerprint(HTML_1)
    })
    expect(f.questionsStale).toBe(true)
    expect(f.answersStale).toBe(false)
  })

  it('没有 HTML 或没有历史指纹（旧数据）→ 判不了就不报警', () => {
    expect(
      freshnessOf({ ...base, hasHtml: false, htmlFp: '', questionsFor: undefined, answersFor: undefined })
    ).toEqual({ questionsStale: false, answersStale: false })
    expect(freshnessOf({ ...base, htmlFp: fingerprint(HTML_2) })).toEqual({
      questionsStale: false,
      answersStale: false
    })
  })

  it('没有题目时怎么都不算过期', () => {
    expect(
      freshnessOf({
        ...base,
        questions: [],
        hasAnswers: false,
        htmlFp: fingerprint(HTML_2),
        questionsFor: fingerprint(HTML_1)
      })
    ).toEqual({ questionsStale: false, answersStale: false })
  })
})
