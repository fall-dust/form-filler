import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../store'
import type { ExportFile, ParsedQuestion } from '../types'

let root = ''
let clock = new Date('2026-09-19T10:00:00.000Z')

function open(dir = root): TaskStore {
  return createTaskStore(dir, { debounceMs: 0, now: () => clock })
}

function q(id: string): ParsedQuestion {
  return {
    id,
    question: `题干 ${id}`,
    type: 'radio',
    options: ['A', 'B'],
    optionValues: ['A', 'B'],
    selectors: [{ css: `input[name="${id}"]` }]
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-stale-'))
  clock = new Date('2026-09-19T10:00:00.000Z')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('步骤对钩用的指纹字段（questionsFor / answersFor）', () => {
  it('落盘后能原样读回（新实例也算）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, {
      questions: [q('q1')],
      answers: { q1: 'A' },
      questionsFor: 'fp-1',
      answersFor: 'fp-2'
    })
    const back = open().get(it.id)
    expect(back?.questionsFor).toBe('fp-1')
    expect(back?.answersFor).toBe('fp-2')
  })

  it('清空内容会一并作废指纹（否则空任务会被判成「已过期」）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { questions: [q('q1')], questionsFor: 'fp-1', answersFor: 'fp-2' })
    const next = s.reset(it.id)
    expect(next?.questionsFor).toBeUndefined()
    expect(next?.answersFor).toBeUndefined()
  })

  it('连 HTML 一起导出时带上指纹，不带 HTML 时不带（到了对面才不会被误判过期）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { questions: [q('q1')], questionsFor: 'fp-1', answersFor: 'fp-2' })
    s.setHtml(it.id, '<form></form>')

    const plain = s.exportTasks([it.id], false)
    expect(plain.tasks[0].questionsFor).toBeUndefined()
    expect(plain.tasks[0].answersFor).toBeUndefined()

    const withHtml = s.exportTasks([it.id], true)
    expect(withHtml.tasks[0].questionsFor).toBe('fp-1')
    expect(withHtml.tasks[0].answersFor).toBe('fp-2')

    const imported = s.importTasks(withHtml)
    const cfg = s.get(imported.imported[0].id)
    expect(cfg?.questionsFor).toBe('fp-1')
    expect(cfg?.answersFor).toBe('fp-2')
  })

  it('导入不带 HTML 的文件不会留下「对不上号」的指纹', () => {
    const s = open()
    const file: ExportFile = {
      format: 'form-filler-task',
      formatVersion: 2,
      exportedAt: clock.toISOString(),
      tasks: [
        {
          name: '只带题目',
          link: 'https://example.com/f',
          channel: '',
          questions: [q('q1')],
          answers: {},
          questionsFor: 'fp-1',
          answersFor: 'fp-2'
        }
      ]
    }
    const r = s.importTasks(file)
    expect(r.failed).toHaveLength(0)
    const cfg = s.get(r.imported[0].id)
    expect(cfg?.questionsFor).toBeUndefined()
    expect(cfg?.answersFor).toBeUndefined()
  })

  it('复制任务：不带 HTML 清掉指纹，带 HTML 则保留', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { questions: [q('q1')], questionsFor: 'fp-1' })

    const copyNoHtml = s.duplicate(it.id, false)
    expect(s.get(copyNoHtml!.id)?.questionsFor).toBeUndefined()

    s.setHtml(it.id, '<form></form>')
    const copy = s.duplicate(it.id, true)
    // 副本页面与题目是配套的，指纹照旧有效
    expect(s.get(copy!.id)?.questionsFor).toBe('fp-1')
  })

  it('脏数据不会进库：非字符串、空串一律归为「没有」', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { questionsFor: 123 as never, answersFor: '' as never })
    const back = s.get(it.id)
    expect(back?.questionsFor).toBeUndefined()
    expect(back?.answersFor).toBeUndefined()
    // 落盘后由新实例读回（再过一遍 normalizeConfig）也不会带出脏值
    const reloaded = open().get(it.id)
    expect(reloaded?.questionsFor).toBeUndefined()
    expect(reloaded?.answersFor).toBeUndefined()
  })
})
