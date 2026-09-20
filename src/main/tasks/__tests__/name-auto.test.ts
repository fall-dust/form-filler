import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../store'

let root = ''
const clock = (): Date => new Date('2026-09-19T10:00:00.000Z')

function open(dir = root): TaskStore {
  return createTaskStore(dir, { debounceMs: 0, now: clock })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-name-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 「AI 自动为任务命名」的前提：得知道**这个名字是不是程序起的**。
 * 规则：只有 nameAuto = true（默认名「任务 N」，或上一次也是 AI 命名的结果）才允许被 AI 覆盖；
 * 用户亲手改过的名字，AI 绝不动它。
 */
describe('任务名的「自动生成」标记', () => {
  it('新建任务：默认名视为自动名，显式命名视为用户自己的', () => {
    const s = open()
    const auto = s.create()
    expect(auto.name).toBe('任务 1')
    expect(s.get(auto.id)?.nameAuto).toBe(true)

    const named = s.create('2026 校园招聘登记')
    expect(s.get(named.id)?.nameAuto).toBe(false)
  })

  it('AI 命名（autoName=true）后仍可再被 AI 命名覆盖', () => {
    const s = open()
    const it = s.create()
    s.rename(it.id, '校招登记', true)
    expect(s.get(it.id)?.name).toBe('校招登记')
    expect(s.get(it.id)?.nameAuto).toBe(true)
    s.rename(it.id, '校园招聘登记表', true)
    expect(s.get(it.id)?.name).toBe('校园招聘登记表')
  })

  it('用户手动改名后 nameAuto 变 false（此后 AI 不再覆盖）；改名成空串不生效', () => {
    const s = open()
    const it = s.create()
    s.rename(it.id, '我自己起的名字')
    expect(s.get(it.id)?.nameAuto).toBe(false)

    s.rename(it.id, '   ')
    expect(s.get(it.id)?.name).toBe('我自己起的名字') // 空名视为误操作
    expect(s.get(it.id)?.nameAuto).toBe(false) // 标记也没被改
  })

  it('侧栏输入框改名（走 patch）同样视为「用户认领」', () => {
    const s = open()
    const it = s.create()
    s.patch(it.id, { name: '客户满意度回访' })
    expect(s.get(it.id)?.nameAuto).toBe(false)
    expect(s.get(it.id)?.name).toBe('客户满意度回访')
  })

  it('旧数据没有该字段：按「是否形如 任务 N」推断', () => {
    const s = open()
    const it = s.create()
    // 直接改盘上的 config.json，模拟升级前留下的数据
    const file = join(root, 'tasks', it.id, 'config.json')
    writeFileSync(file, JSON.stringify({ id: it.id, name: '任务 7', questions: [] }), 'utf-8')
    expect(open().get(it.id)?.nameAuto).toBe(true)

    writeFileSync(file, JSON.stringify({ id: it.id, name: '问卷 A', questions: [] }), 'utf-8')
    expect(open().get(it.id)?.nameAuto).toBe(false)
  })

  it('导出/导入保留该标记', () => {
    const s = open()
    const it = s.create()
    s.rename(it.id, '岗位投递登记', true)
    const file = s.exportTasks([it.id], false)
    expect(file.tasks[0].nameAuto).toBe(true)

    const other = open(mkdtempSync(join(tmpdir(), 'ff-name-import-')))
    other.importTasks(file)
    const imported = other.list().find((x) => x.name.startsWith('岗位投递登记'))!
    expect(other.get(imported.id)?.nameAuto).toBe(true)
  })
})
