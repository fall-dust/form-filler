import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { runFill } from '../engine'
import type { ParsedQuestion } from '../types'

const cwd = process.cwd()

// 与 samples/form_sample.html 对应的九类题型（显式给出选择器，模拟 AI 导入的完整配置）
const questions: ParsedQuestion[] = [
  {
    id: 'q1',
    question: '你的姓名？',
    type: 'text',
    options: [],
    optionValues: [],
    selectors: [{ css: '#name' }]
  },
  {
    id: 'q2',
    question: '你的建议？',
    type: 'textarea',
    options: [],
    optionValues: [],
    selectors: [{ css: '#suggestion' }]
  },
  {
    id: 'q3',
    question: '性别？',
    type: 'radio',
    options: ['男', '女', '保密'],
    optionValues: ['男', '女', '保密'],
    selectors: [{ css: 'input[type="radio"][name="gender"]' }]
  },
  {
    id: 'q4',
    question: '是否同意本协议？',
    type: 'judge',
    options: ['是', '否'],
    optionValues: ['是', '否'],
    selectors: [{ css: 'input[type="radio"][name="agree"]' }]
  },
  {
    id: 'q5',
    question: '你感兴趣的功能？',
    type: 'checkbox',
    options: ['自动填表', '智能解析', '断点续填'],
    optionValues: ['自动填表', '智能解析', '断点续填'],
    selectors: [{ css: 'input[type="checkbox"][name="features"]' }]
  },
  {
    id: 'q6',
    question: '满意度？',
    type: 'select',
    options: ['非常满意', '满意', '一般'],
    optionValues: ['5', '4', '3'],
    selectors: [{ css: '#satisfaction' }]
  },
  {
    id: 'q7',
    question: '出生日期？',
    type: 'date',
    options: [],
    optionValues: [],
    selectors: [{ css: '#birthday' }]
  },
  {
    id: 'q8',
    question: '上传头像？',
    type: 'file',
    options: [],
    optionValues: [],
    selectors: [{ css: '#avatar' }]
  },
  {
    id: 'q9',
    question: '请对以下各项满意度打分',
    type: 'matrix',
    options: ['非常满意', '满意', '一般'],
    optionValues: ['非常满意', '满意', '一般'],
    matrixRows: ['服务态度', '产品质量'],
    selectors: [{ css: 'table.matrix' }]
  }
]

const answers: Record<string, string | string[]> = {
  q1: '张三',
  q2: '很棒，继续加油',
  q3: '男',
  q4: '是',
  q5: ['自动填表', '断点续填'],
  q6: '满意',
  q7: '2000-01-01',
  q8: resolve(cwd, 'README.md'),
  q9: '满意'
}

describe('fill-engine 端到端（headless chromium）', () => {
  it('九类题型全部 filled 且 DOM 回读正确', async () => {
    const url = pathToFileURL(resolve(cwd, 'samples', 'form_sample.html')).href
    const { report, browser, page } = await runFill({
      config: {
        link: url,
        headless: true,
        waitTimeout: 5000,
        waitAfterLoad: 100,
        outputDir: resolve(cwd, 'out', 'test-output')
      },
      questions,
      answers
    })

    expect(report.summary.failed).toBe(0)
    expect(report.summary.missing).toBe(0)
    expect(report.summary.filled).toBe(questions.length)

    const state = await page.evaluate(() => {
      const val = (sel: string): string | null =>
        (document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null)?.value ?? null
      const checked = (sel: string): boolean =>
        (document.querySelector(sel) as HTMLInputElement | null)?.checked ?? false
      return {
        name: val('input[name="name"]'),
        suggestion: val('textarea[name="suggestion"]'),
        gender: checked('input[name="gender"][value="男"]'),
        agree: checked('input[name="agree"][value="是"]'),
        feat1: checked('input[name="features"][value="自动填表"]'),
        feat2: checked('input[name="features"][value="断点续填"]'),
        satisfaction: val('select[name="satisfaction"]'),
        birthday: val('input[name="birthday"]'),
        m1: checked('input[name="m1"][value="满意"]'),
        m2: checked('input[name="m2"][value="满意"]')
      }
    })

    expect(state.name).toBe('张三')
    expect(state.suggestion).toBe('很棒，继续加油')
    expect(state.gender).toBe(true)
    expect(state.agree).toBe(true)
    expect(state.feat1).toBe(true)
    expect(state.feat2).toBe(true)
    expect(state.satisfaction).toBe('4') // 「满意」对应 value 4
    expect(state.birthday).toBe('2000-01-01')
    expect(state.m1).toBe(true)
    expect(state.m2).toBe(true)

    await browser.close()
  }, 60000)
})
