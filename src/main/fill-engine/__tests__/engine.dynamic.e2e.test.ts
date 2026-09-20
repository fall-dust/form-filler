import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { runFill } from '../engine'
import type { ParsedQuestion } from '../types'

const cwd = process.cwd()

// 模拟 AI 导入：只给 selector + type，选项留空，由脚本运行时动态读取
const questions: ParsedQuestion[] = [
  {
    id: 'q1',
    question: '性别',
    type: 'radio',
    options: [],
    optionValues: [],
    selectors: [{ css: 'input[name="gender"]' }]
  },
  {
    id: 'q2',
    question: '功能',
    type: 'checkbox',
    options: [],
    optionValues: [],
    selectors: [{ css: 'input[name="features"]' }]
  },
  {
    id: 'q3',
    question: '满意度',
    type: 'select',
    options: [],
    optionValues: [],
    selectors: [{ css: 'select[name="satisfaction"]' }]
  }
]

describe('fill-engine 动态读取选项（AI 导入路径）', () => {
  it('无 options 时从页面读取并正确点选', async () => {
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
      answers: { q1: '女', q2: ['自动填表', '断点续填'], q3: '满意' }
    })

    expect(report.summary.failed).toBe(0)
    expect(report.summary.filled).toBe(3)

    const state = await page.evaluate(() => {
      const checked = (sel: string): boolean =>
        (document.querySelector(sel) as HTMLInputElement | null)?.checked ?? false
      const val = (sel: string): string | null =>
        (document.querySelector(sel) as HTMLSelectElement | null)?.value ?? null
      return {
        gender: checked('input[name="gender"][value="女"]'),
        feat1: checked('input[name="features"][value="自动填表"]'),
        feat2: checked('input[name="features"][value="断点续填"]'),
        satisfaction: val('select[name="satisfaction"]')
      }
    })

    expect(state.gender).toBe(true)
    expect(state.feat1).toBe(true)
    expect(state.feat2).toBe(true)
    expect(state.satisfaction).toBe('4') // 「满意」对应 value 4

    // 收尾保护：本机环境下 chromium 偶发退出挂起，不阻塞测试结论
    await Promise.race([
      browser.close(),
      new Promise((r) => setTimeout(r, 5000))
    ]).catch(() => {})
  }, 60000)
})
