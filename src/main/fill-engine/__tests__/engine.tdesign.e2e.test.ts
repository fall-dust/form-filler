import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { runFill } from '../engine'
import type { ParsedQuestion } from '../types'

const cwd = process.cwd()

/**
 * 复刻真实案例（腾讯问卷）：AI 从粘贴的 HTML 生成的选择器回退链里，
 * 第一条命中的是「单个选项」且 name 前缀是框架自动生成、重渲染即变；
 * 第二条才是稳定的「题目容器内整组选择器」。引擎必须选后者。
 */
const questions: ParsedQuestion[] = [
  {
    id: 'q1',
    question: '您的性别是',
    type: 'radio',
    options: ['男', '女'],
    optionValues: ['o-101-66e9', 'o-102-c5d6'],
    selectors: [
      { css: 'input[name="809-q-38-8883"]' },
      { css: '#question_q-38-8883 input[type=radio]' }
    ]
  },
  {
    id: 'q2',
    question: '您的出生年份是？',
    type: 'richselect',
    options: [],
    optionValues: [],
    selectors: [{ css: '#question_q-39-a55b .t-select' }]
  }
]

describe('腾讯问卷（TDesign）式表单', () => {
  it('易变 name 的单选整组定位并点选；TDesign 下拉浮层能识别并选中', async () => {
    const url = pathToFileURL(resolve(cwd, 'samples', 'tdesign_form.html')).href
    const started = Date.now()

    const { report, browser, page } = await runFill({
      config: {
        link: url,
        headless: true,
        waitTimeout: 5000,
        waitAfterLoad: 100,
        outputDir: resolve(cwd, 'out', 'test-output')
      },
      questions,
      answers: { q1: '男', q2: '1995' }
    })
    const elapsed = Date.now() - started

    expect(report.summary.failed).toBe(0)
    expect(report.summary.filled).toBe(2)
    // 「整组优先」：跳过只命中单个选项的易变 name 选择器
    expect(report.fields[0].strategy).toBe('css:#question_q-38-8883 input[type=radio]')

    const state = await page.evaluate(() => {
      const q = (sel: string): HTMLInputElement | null =>
        document.querySelector(sel) as HTMLInputElement | null
      return {
        gender: q('#question_q-38-8883 input[value="o-101-66e9"]')?.checked ?? false,
        checkedCount: document.querySelectorAll('#question_q-38-8883 input:checked').length,
        year: q('#year-select input')?.value ?? ''
      }
    })
    expect(state.gender).toBe(true) // 性别=男 真实选中（且经历过整块重渲染）
    expect(state.checkedCount).toBe(1) // 单选互斥：只选中一个
    expect(state.year).toBe('1995年') // TDesign 可搜索下拉选中

    // 回归保护：选择器失配时旧的 getAttribute 会空等 30s 才抛错
    expect(elapsed).toBeLessThan(25000)

    // 收尾保护：本机环境下 chromium 偶发退出挂起，不阻塞测试结论
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }, 90000)
})
