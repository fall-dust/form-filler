import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../store'
import type { ParsedQuestion } from '../types'

let root = ''
const clock = (): Date => new Date('2026-09-19T10:00:00.000Z')

function open(dir = root): TaskStore {
  return createTaskStore(dir, { debounceMs: 0, now: clock })
}

function q(id: string, question = '题干'): ParsedQuestion {
  return {
    id,
    question,
    type: 'radio',
    options: ['A', 'B'],
    optionValues: ['A', 'B'],
    selectors: [{ css: `input[name="${id}"]` }]
  }
}

const snapDir = (id: string): string => join(root, 'tasks', id, 'snapshots')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-pregrab-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 「抓取新页面时，第一次的记录不能删除」——
 * 抓取覆盖前自动存一份「抓取前」历史版本（连 HTML 一起），可随时回滚回上一页。
 */
describe('抓取新页面前的自动存档（含 HTML）', () => {
  it('存档带上旧 HTML 与当时的题目；列历史版本时能看出「含 HTML」', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')], answers: { q1: 'A' } })
    s.setHtml(it.id, '<form>PAGE-1</form>')

    const meta = s.createSnapshot(it.id, 'pre-grab', { withHtml: true, skipIfEmpty: true })
    expect(meta).not.toBeNull()
    expect(meta!.label).toBe('pre-grab')
    expect(meta!.hasHtml).toBe(true)
    expect(meta!.questionCount).toBe(1)

    // HTML 放在与快照同名的 .html 旁挂文件里 —— 列历史版本时不必解析大 HTML
    expect(existsSync(join(snapDir(it.id), `${meta!.ts}.html`))).toBe(true)

    const list = s.snapshots(it.id)
    expect(list[0].hasHtml).toBe(true)
    expect(list[0].label).toBe('pre-grab')
  })

  it('翻到第 2 页并抓取后：回滚「抓取前」会把第 1 页的 HTML 与题目一起还原', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { questions: [q('q1', '第 1 页的题')], answers: { q1: 'A' } })
    s.setHtml(it.id, '<form>PAGE-1</form>')

    const meta = s.createSnapshot(it.id, 'pre-grab', { withHtml: true, skipIfEmpty: true })!

    // 用户翻到第 2 页：抓取覆盖 HTML + 导入新一页的题目
    s.setHtml(it.id, '<form>PAGE-2</form>')
    s.patch(it.id, { questions: [q('q2', '第 2 页的题')], answers: { q2: 'B' } })

    const back = s.rollback(it.id, meta.ts)
    expect(back?.questions.map((x) => x.id)).toEqual(['q1'])
    expect(back?.answers.q1).toBe('A')
    expect(s.getHtml(it.id)).toBe('<form>PAGE-1</form>') // 页面也回到第 1 页
    expect(s.list().find((x) => x.id === it.id)?.hasHtml).toBe(true)
  })

  it('老快照（没存过 HTML）回滚时不动当前 HTML', () => {
    const s = open()
    const it = s.create()
    s.setHtml(it.id, '<form>PAGE-1</form>')
    const old = s.createSnapshot(it.id, 'manual')! // 不带 withHtml
    expect(old.hasHtml).toBeFalsy()

    s.setHtml(it.id, '<form>PAGE-2</form>')
    s.rollback(it.id, old.ts)
    expect(s.getHtml(it.id)).toBe('<form>PAGE-2</form>')
  })

  it('既没有 HTML 也没有题目 → skipIfEmpty 不留空档', () => {
    const s = open()
    const it = s.create()
    expect(s.createSnapshot(it.id, 'pre-grab', { withHtml: true, skipIfEmpty: true })).toBeNull()
    expect(s.snapshots(it.id)).toHaveLength(0)
  })

  it('「抓取前」的存档不会被自动清理（自动清理只动 auto）', () => {
    const s = open()
    s.saveSettings({ snapshotLimit: 2 })
    const it = s.create()
    s.patch(it.id, { questions: [q('q1')] })
    s.setHtml(it.id, '<form>PAGE-1</form>')

    const first = s.createSnapshot(it.id, 'pre-grab', { withHtml: true, skipIfEmpty: true })!
    // 连着抓几次，超出份数上限
    for (let i = 0; i < 4; i++) {
      s.patch(it.id, { answers: { q1: `A${i}` } })
      s.createSnapshot(it.id, 'auto')
    }
    const list = s.snapshots(it.id)
    expect(list.some((m) => m.ts === first.ts)).toBe(true) // 第一次的记录还在
    expect(existsSync(join(snapDir(it.id), `${first.ts}.html`))).toBe(true)
  })

  it('回滚本身也留档（当前状态含 HTML），所以回滚也能再回滚', () => {
    const s = open()
    const it = s.create()
    s.setHtml(it.id, '<form>PAGE-1</form>')
    const meta = s.createSnapshot(it.id, 'pre-grab', { withHtml: true, skipIfEmpty: true })!

    s.setHtml(it.id, '<form>PAGE-2</form>')
    s.rollback(it.id, meta.ts)
    expect(s.getHtml(it.id)).toBe('<form>PAGE-1</form>')

    const all = readdirSync(snapDir(it.id)).filter((f) => f.endsWith('.json'))
    expect(all.length).toBeGreaterThanOrEqual(2) // pre-grab + pre-rollback
    const preRollback = s.snapshots(it.id).find((m) => m.label === 'pre-rollback')!
    expect(preRollback.hasHtml).toBe(true)
    s.rollback(it.id, preRollback.ts)
    expect(s.getHtml(it.id)).toBe('<form>PAGE-2</form>') // 回到回滚前
  })
})
