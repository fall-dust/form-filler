import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../store'
import type { ParsedQuestion, SaveStateEvent } from '../types'

/**
 * 存储层的两条「真机才会遇到」的路径（补齐 M7 收尾时标注的未测项）：
 *   1) 换机搬迁：导出的文件只有 JSON 文本，导入到**另一台机器的另一个根目录**后内容必须完整；
 *   2) 写失败：磁盘写不进去时不能静默，要么报错要么保留待写队列，修好后能补上。
 */
let root = ''
const extraRoots: string[] = []

function open(dir: string, debounceMs = 0): TaskStore {
  return createTaskStore(dir, { debounceMs })
}

function q(id: string): ParsedQuestion {
  return {
    id,
    question: '题干',
    type: 'radio',
    options: ['A', 'B'],
    optionValues: ['A', 'B'],
    selectors: [{ css: `input[name="${id}"]` }]
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-durable-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const d of extraRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('换机搬迁：导出 → 另一根目录导入', () => {
  it('只经 JSON 文本往返，内容一字不差，且导入为新实体不覆盖本机任务', () => {
    const a = open(root)
    const itA = a.create('交叉导出')
    a.patch(itA.id, {
      link: 'https://form.example/x',
      autoSubmit: true,
      questions: [q('q1')],
      answers: { q1: 'A' }
    })
    a.flush()
    a.setHtml(itA.id, '<form id="f"><input name="q1"></form>')

    const exported = a.exportTasks([itA.id], true)
    // 模拟「拷到另一台机器」：中间只允许留下 JSON 文本
    const onDisk = JSON.parse(JSON.stringify(exported)) as typeof exported

    const rootB = mkdtempSync(join(tmpdir(), 'ff-durable-b-'))
    extraRoots.push(rootB)
    const b = open(rootB)
    const out = b.importTasks(onDisk)

    expect(out.failed).toEqual([])
    expect(out.imported.length).toBe(1)
    const itB = out.imported[0]
    // 新机器上是新实体，id 与来源不同（绝不覆盖本机已有任务）
    expect(itB.id).not.toBe(itA.id)
    expect(itB.name).toBe('交叉导出')

    const cfgB = b.get(itB.id)
    expect(cfgB).not.toBeNull()
    expect(cfgB!.link).toBe('https://form.example/x')
    expect(cfgB!.autoSubmit).toBe(true)
    expect(cfgB!.questions.length).toBe(1)
    expect(cfgB!.questions[0].id).toBe('q1')
    expect(cfgB!.answers.q1).toBe('A')
    // HTML 随导出一起搬过去
    expect(b.getHtml(itB.id)).toContain('name="q1"')
  })

  it('同名任务导入到已有同名任务的机器：改名共存，不覆盖原任务', () => {
    const a = open(root)
    const itA = a.create('同名任务')
    a.patch(itA.id, { link: 'https://a.example' })
    a.flush()

    const rootB = mkdtempSync(join(tmpdir(), 'ff-durable-c-'))
    extraRoots.push(rootB)
    const b = open(rootB)
    const itB0 = b.create('同名任务')
    b.patch(itB0.id, { link: 'https://b.example' })
    b.flush()

    const out = b.importTasks(JSON.parse(JSON.stringify(a.exportTasks('all', false))))
    expect(out.failed).toEqual([])
    expect(out.imported.length).toBe(1)
    // 两条任务都在，且各自的链接没有被互相覆盖
    expect(b.list().length).toBe(2)
    expect(b.get(itB0.id)!.link).toBe('https://b.example')
    expect(b.get(out.imported[0].id)!.link).toBe('https://a.example')
    expect(out.imported[0].name).not.toBe('同名任务')
  })
})

describe('写失败路径：不静默、可重试', () => {
  it('写盘失败时报 error 并保留待写内容，修好目录后重试成功且重启后能读到', () => {
    const events: SaveStateEvent[] = []
    const s = createTaskStore(root, { debounceMs: 60000, onSaveState: (e) => events.push(e) })
    const it = s.create('写失败')

    // 正常写入一次（同时把「自动快照」的时间桶用掉，后面不再触发快照写入）
    s.patch(it.id, { link: 'https://a.example' })
    s.flush()
    expect(events[events.length - 1].state).toBe('saved')

    // 把任务目录换成同名文件 → 之后任何写入必然失败
    const dir = join(root, 'tasks', it.id)
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'not a directory')

    s.patch(it.id, { link: 'https://b.example' })
    s.flush()
    expect(events[events.length - 1].state).toBe('error')
    expect(events[events.length - 1].message).toBeTruthy()
    // 内存里保留最新值（否则界面会像「改动被吞了」）
    expect(s.get(it.id)!.link).toBe('https://b.example')

    // 修好目录后重试（界面的重试按钮 / 退出前 flush）= 同一份待写内容补上
    rmSync(dir, { force: true })
    mkdirSync(dir, { recursive: true })
    s.flush()
    expect(events[events.length - 1].state).toBe('saved')

    // 换一个 store 实例（= 重启应用）能读到最新值
    const s2 = open(root)
    expect(s2.get(it.id)!.link).toBe('https://b.example')
  })
})
