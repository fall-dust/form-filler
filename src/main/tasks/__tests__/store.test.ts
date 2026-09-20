import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../store'
import type { ParsedQuestion, TaskConfig } from '../types'

let root = ''
/** 可控时钟：让时间桶 / 保留期 / 快照排序可测 */
let clock = new Date('2026-09-19T10:00:00.000Z')

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms)
}

function open(dir = root, debounceMs = 0): TaskStore {
  return createTaskStore(dir, { debounceMs, now: () => clock })
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff-tasks-'))
  clock = new Date('2026-09-19T10:00:00.000Z')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('任务 CRUD 与持久化', () => {
  it('创建任务并写入索引与配置', () => {
    const s = open()
    const it = s.create()
    expect(it.id).toMatch(/^t-/)
    expect(it.name).toBe('任务 1')
    expect(existsSync(join(root, 'tasks', it.id, 'config.json'))).toBe(true)
    expect(s.create().name).toBe('任务 2')
    expect(s.list()).toHaveLength(2)
  })

  it('patch 立即落盘，新实例能读回（防抖为 0）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://example.com/f', questions: [q('q1')], answers: { q1: 'A' } })

    const reopened = open()
    const cfg = reopened.get(it.id)
    expect(cfg?.link).toBe('https://example.com/f')
    expect(cfg?.questions).toHaveLength(1)
    expect(cfg?.answers.q1).toBe('A')
    expect(reopened.list()[0].questionCount).toBe(1)
    expect(reopened.list()[0].answerCount).toBe(1)
  })

  it('防抖窗口内不写盘，flush 后落盘（模拟退出前 flush）', () => {
    const s = open(root, 500)
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://late.example.com' })

    // 防抖未到点：磁盘上还是旧内容
    const mid = open()
    expect(mid.get(it.id)?.link).toBe('')

    s.flush()
    const after = open()
    expect(after.get(it.id)?.link).toBe('https://late.example.com')
  })

  it('重命名不改身份（id 不变）且允许重名', () => {
    const s = open()
    const a = s.create('甲')
    const b = s.create('乙')
    const renamed = s.rename(a.id, '乙')
    expect(renamed?.id).toBe(a.id)
    expect(s.list().map((x) => x.name).sort()).toEqual(['乙', '乙'])
    // 两份配置仍是各自独立的实体
    expect(s.get(a.id)?.id).toBe(a.id)
    expect(s.get(b.id)?.id).toBe(b.id)
  })

  it('patch 把名字清空时保留原名（界面输入框删空不丢名字）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { name: '   ' })
    expect(s.get(it.id)?.name).toBe('问卷')
    expect(s.list()[0].name).toBe('问卷')
    s.patch(it.id, { name: '新名字' })
    expect(s.get(it.id)?.name).toBe('新名字')
  })

  it('reorder 持久化标签顺序', () => {
    const s = open()
    const a = s.create('A')
    const b = s.create('B')
    const c = s.create('C')
    s.reorder([c.id, a.id, b.id])
    expect(open().list().map((x) => x.name)).toEqual(['C', 'A', 'B'])
  })

  it('duplicate 复制内容但生成新 id', () => {
    const s = open()
    const it = s.create('模板')
    s.patch(it.id, { link: 'https://x', questions: [q('q1')], answers: { q1: 'A' } })
    const copy = s.duplicate(it.id)
    expect(copy?.id).not.toBe(it.id)
    expect(copy?.name).toBe('模板 (2)')
    expect(s.get(copy!.id)?.questions).toHaveLength(1)
    expect(s.get(copy!.id)?.answers.q1).toBe('A')
  })

  it('老配置里的 headless 字段读回即丢弃（该开关已随机制移除，不留复活口子）', () => {
    const s = open()
    const it = s.create('旧配置')
    // 模拟老版本写在盘上的 config.json：里面还带着 headless
    const file = join(root, 'tasks', it.id, 'config.json')
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    raw.headless = true
    writeFileSync(file, JSON.stringify(raw), 'utf-8')

    // 新实例（不走缓存）从盘上读回来 —— 字段应当被归一化掉
    const cfg = open().get(it.id) as unknown as Record<string, unknown>
    expect('headless' in cfg).toBe(false)
  })
})

describe('崩溃恢复与索引重建', () => {
  it('只有 .tmp 没有正式文件时，把 tmp 提升为 config', () => {
    const s = open()
    const it = s.create('问卷')
    const dir = join(root, 'tasks', it.id)
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as TaskConfig
    cfg.link = 'https://from-tmp.example.com'
    // 模拟写盘中途崩溃：正式文件缺失、tmp 完整
    writeFileSync(join(dir, 'config.json.tmp'), JSON.stringify(cfg), 'utf-8')
    rmSync(join(dir, 'config.json'))

    const reopened = open()
    expect(reopened.get(it.id)?.link).toBe('https://from-tmp.example.com')
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false)
  })

  it('.tmp 与正式文件同时存在时删掉 tmp（保留正式文件）', () => {
    const s = open()
    const it = s.create('问卷')
    const dir = join(root, 'tasks', it.id)
    writeFileSync(join(dir, 'config.json.tmp'), '{"broken":', 'utf-8')
    open()
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false)
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
  })

  it('index.json 损坏时从 tasks/*/config.json 重建', () => {
    const s = open()
    const a = s.create('甲')
    const b = s.create('乙')
    s.patch(b.id, { link: 'https://b' })
    writeFileSync(join(root, 'tasks', 'index.json'), 'not-json', 'utf-8')

    const rebuilt = open()
    expect(rebuilt.list().map((x) => x.name).sort()).toEqual(['乙', '甲'])
    // 顺带把损坏现场清掉，避免每次启动都重建
    expect(readdirSync(join(root, 'tasks')).includes('index.json')).toBe(true)
    expect(rebuilt.get(a.id)?.name).toBe('甲')
  })

  it('索引缺条目时自动补齐（配置写了但索引没写就崩）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://x' })
    writeFileSync(
      join(root, 'tasks', 'index.json'),
      JSON.stringify({ version: 1, tasks: [] }),
      'utf-8'
    )
    expect(open().list().map((x) => x.name)).toEqual(['问卷'])
  })

  it('config.json 损坏时从最近快照恢复，并保留损坏文件', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://good.example.com', questions: [q('q1')] })
    s.createSnapshot(it.id, 'manual')

    const dir = join(root, 'tasks', it.id)
    writeFileSync(join(dir, 'config.json'), '{oops', 'utf-8')

    const reopened = open()
    expect(reopened.get(it.id)?.link).toBe('https://good.example.com')
    expect(readdirSync(dir).some((f) => f.startsWith('config.corrupt-'))).toBe(true)
  })
})

describe('快照', () => {
  it('自动快照按内容去重，手动快照不去重', () => {
    const s = open()
    const it = s.create('问卷')

    // 本次会话的首次改动会立即留一份 auto（lastAutoAt 从 0 起算），保证「会话起始状态」可回溯
    s.patch(it.id, { link: 'https://x' })
    expect(s.snapshots(it.id)).toHaveLength(1)
    expect(s.snapshots(it.id)[0].label).toBe('auto')

    // 内容没变 → 自动快照去重跳过
    expect(s.createSnapshot(it.id, 'auto')).toBeNull()
    // 手动快照一律留档，同一秒内也不会互相覆盖
    expect(s.createSnapshot(it.id, 'manual')).not.toBeNull()
    expect(s.createSnapshot(it.id, 'manual')).not.toBeNull()
    expect(s.snapshots(it.id)).toHaveLength(3)
  })

  it('自动快照受时间桶限制（同一桶内不重复留档）', () => {
    const s = open()
    s.saveSettings({ autoSnapshotMinutes: 5 })
    const it = s.create('问卷')

    s.patch(it.id, { link: 'https://v1' })
    expect(s.snapshots(it.id)).toHaveLength(1)

    advance(60_000) // 1 分钟后改了内容，但还在时间桶内
    s.patch(it.id, { link: 'https://v2' })
    s.createSnapshot(it.id, 'manual') // 手动不受限制
    expect(s.snapshots(it.id).filter((x) => x.label === 'auto')).toHaveLength(1)

    advance(5 * 60_000)
    s.patch(it.id, { link: 'https://v3' })
    expect(s.snapshots(it.id).filter((x) => x.label === 'auto')).toHaveLength(2)
  })

  it('超出上限时优先淘汰最旧的 auto，manual 保留', () => {
    const s = open()
    s.saveSettings({ snapshotLimit: 3 })
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://v0' })
    s.createSnapshot(it.id, 'manual') // 最旧，但受保护

    for (let i = 1; i <= 4; i++) {
      advance(1000)
      s.patch(it.id, { link: `https://v${i}` })
      s.createSnapshot(it.id, 'auto')
    }

    const list = s.snapshots(it.id)
    expect(list).toHaveLength(3)
    expect(list.filter((x) => x.label === 'manual')).toHaveLength(1)
  })

  it('回滚恢复内容但不回滚名字，且回滚前自动留档（可再回滚回去）', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://v1', answers: { q1: 'A' } })
    const first = s.createSnapshot(it.id, 'manual')!
    s.rename(it.id, '新名字')

    advance(1000)
    s.patch(it.id, { link: 'https://v2', answers: { q1: 'B' } })

    const rolled = s.rollback(it.id, first.ts)
    expect(rolled?.link).toBe('https://v1')
    expect(rolled?.answers.q1).toBe('A')
    expect(rolled?.name).toBe('新名字') // 名字是对身份的调整，不被回滚带走

    const preRollback = s.snapshots(it.id).find((x) => x.label === 'pre-rollback')
    expect(preRollback).toBeTruthy()
    const back = s.rollback(it.id, preRollback!.ts)
    expect(back?.link).toBe('https://v2')
  })

  it('reset 清空内容但保留任务与名字，且留一份可回滚的档', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://x', questions: [q('q1')], answers: { q1: 'A' } })
    s.setHtml(it.id, '<form></form>')

    const next = s.reset(it.id)
    expect(next?.id).toBe(it.id)
    expect(next?.name).toBe('问卷')
    expect(next?.questions).toHaveLength(0)
    expect(next?.link).toBe('')
    expect(s.getHtml(it.id)).toBeNull()
    expect(open().list()).toHaveLength(1)
    expect(s.snapshots(it.id).some((x) => x.label === 'pre-rollback')).toBe(true)
  })
})

describe('回收站', () => {
  it('软删除后可从回收站恢复，内容一致且保留创建时间', () => {
    const s = open()
    const it = s.create('问卷')
    s.patch(it.id, { link: 'https://x', questions: [q('q1')], answers: { q1: 'A' } })
    const createdAt = s.list()[0].createdAt

    expect(s.trash(it.id)).toBe(true)
    expect(s.list()).toHaveLength(0)
    expect(existsSync(join(root, 'tasks', it.id))).toBe(false)
    expect(existsSync(join(root, 'trash', it.id, 'config.json'))).toBe(true)

    const trashList = s.listTrash()
    expect(trashList).toHaveLength(1)
    expect(trashList[0].name).toBe('问卷')
    expect(trashList[0].questionCount).toBe(1)
    expect(trashList[0].expiresAt).not.toBeNull()

    const restored = s.restore(it.id)
    expect(restored?.id).toBe(it.id)
    expect(restored?.createdAt).toBe(createdAt)
    expect(s.get(it.id)?.answers.q1).toBe('A')
    expect(s.listTrash()).toHaveLength(0)
  })

  it('恢复时 id 被占用则换新 id，重名自动加后缀', () => {
    const s = open()
    const a = s.create('问卷')
    s.trash(a.id)
    // 回收站外已存在同名任务（重名场景）
    s.create('问卷')

    // 造一个占用同 id 的任务目录，并让它出现在索引里（模拟极端情况下的 id 冲突）
    const dir = join(root, 'tasks', a.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ id: a.id, name: '占用者', link: '', questions: [], answers: {} }),
      'utf-8'
    )
    const indexFile = join(root, 'tasks', 'index.json')
    const idx = JSON.parse(readFileSync(indexFile, 'utf-8')) as {
      version: number
      tasks: unknown[]
    }
    idx.tasks.push({
      id: a.id,
      name: '占用者',
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
      questionCount: 0,
      answerCount: 0,
      hasHtml: false,
      order: idx.tasks.length
    })
    writeFileSync(indexFile, JSON.stringify(idx), 'utf-8')

    const reopened = open()
    const restored = reopened.restore(a.id)
    expect(restored?.id).not.toBe(a.id)
    expect(restored?.name).toBe('问卷 (2)')
    expect(reopened.list()).toHaveLength(3)
    expect(existsSync(join(root, 'trash', a.id))).toBe(false)
  })

  it('彻底删除与过期清理', () => {
    const s = open()
    const a = s.create('甲')
    const b = s.create('乙')
    s.saveSettings({ trashRetentionDays: 1 })
    s.trash(a.id)
    advance(1000)
    s.trash(b.id)

    expect(s.listTrash().map((x) => x.name)).toEqual(['乙', '甲'])

    advance(2 * 86_400_000)
    expect(s.cleanExpiredTrash()).toBe(2)
    expect(s.listTrash()).toHaveLength(0)

    // 彻底删除：立即消失，不进入过期流程
    const c = s.create('丙')
    s.trash(c.id)
    expect(s.purge(c.id)).toBe(true)
    expect(s.listTrash()).toHaveLength(0)
  })

  it('emptyTrash 清空回收站', () => {
    const s = open()
    s.trash(s.create('甲').id)
    s.trash(s.create('乙').id)
    expect(s.emptyTrash()).toBe(2)
    expect(s.listTrash()).toHaveLength(0)
  })
})

describe('导出与导入', () => {
  it('导出全部任务后可原样导入，内容一致', () => {
    const s = open()
    const a = s.create('问卷 A')
    s.patch(a.id, { link: 'https://a', questions: [q('q1'), q('q2')], answers: { q1: 'A', q2: 'B' } })
    s.setHtml(a.id, '<form>a</form>')
    const b = s.create('问卷 B')
    s.patch(b.id, { link: 'https://b' })

    const file = s.exportTasks('all', false)
    expect(file.format).toBe('form-filler-task')
    expect(file.formatVersion).toBe(2)
    expect(file.tasks).toHaveLength(2)
    expect(file.tasks[0].sourceHtml).toBeUndefined() // 默认不带 HTML

    const withHtml = s.exportTasks([a.id], true)
    expect(withHtml.tasks[0].sourceHtml).toBe('<form>a</form>')

    const outcome = s.importTasks(file)
    expect(outcome.canceled).toBe(false)
    expect(outcome.imported).toHaveLength(2)
    expect(outcome.failed).toHaveLength(0)
    expect(s.list()).toHaveLength(4)
    // 导入的一律是新任务，名字自动去重
    expect(s.list().map((x) => x.name)).toContain('问卷 A (2)')

    const importedConfig = s.get(outcome.imported[0].id)
    expect(importedConfig?.questions.map((x) => x.id)).toEqual(['q1', 'q2'])
    expect(importedConfig?.answers.q2).toBe('B')
  })

  it('导入时单条损坏不阻断其余，并给出失败原因', () => {
    const s = open()
    const outcome = s.importTasks({
      format: 'form-filler-task',
      formatVersion: 2,
      exportedAt: clock.toISOString(),
      tasks: [
        {
          name: '好的',
          link: 'https://ok',
          channel: '',
          questions: [q('q1')],
          answers: { q1: 'A' }
        },
        null as never
      ]
    })
    expect(outcome.imported).toHaveLength(1)
    expect(outcome.failed).toHaveLength(1)
    expect(s.list()).toHaveLength(1)
  })

  it('拒绝格式不符与版本过高的文件', () => {
    const s = open()
    expect(() => s.importTasks({ format: 'other' } as never)).toThrow(/格式不匹配/)
    expect(() =>
      s.importTasks({ format: 'form-filler-task', formatVersion: 99, exportedAt: '', tasks: [] })
    ).toThrow(/版本不支持/)
  })
})

describe('旧 projects 目录迁移', () => {
  it('迁移成功并把原目录改名保留', () => {
    const projectsDir = join(root, 'projects')
    mkdirSync(join(projectsDir, '旧问卷'), { recursive: true })
    writeFileSync(
      join(projectsDir, '旧问卷', 'project.json'),
      JSON.stringify({
        link: 'https://old',
        hasLogin: true,
        headless: false,
        channel: '',
        questions: [q('q1', '旧题干')],
        answers: { q1: 'A' }
      }),
      'utf-8'
    )
    mkdirSync(join(projectsDir, '坏的'), { recursive: true })
    writeFileSync(join(projectsDir, '坏的', 'project.json'), '{broken', 'utf-8')

    const s = open()
    const report = s.migrateFromProjects()
    expect(report?.count).toBe(1)
    expect(report?.skipped).toEqual(['坏的'])
    expect(existsSync(projectsDir)).toBe(false)
    expect(existsSync(join(root, report!.backupDir))).toBe(true)
    expect(existsSync(join(root, 'migration.json'))).toBe(true)

    const cfg = s.get(s.list()[0].id)
    expect(cfg?.name).toBe('旧问卷')
    expect(cfg?.link).toBe('https://old')
    expect(cfg?.questions[0].question).toBe('旧题干')
    // 老文件里已移除的字段（hasLogin / headless）只是被忽略，不影响迁移
    expect('hasLogin' in (cfg as object)).toBe(false)
    expect('headless' in (cfg as object)).toBe(false)

    // 幂等：再次调用不再迁移
    expect(s.migrateFromProjects()).toBeNull()
  })

  it('无可迁移内容时不动原目录，也不写迁移标记', () => {
    mkdirSync(join(root, 'projects'), { recursive: true })
    const s = open()
    expect(s.migrateFromProjects()).toBeNull()
    expect(existsSync(join(root, 'projects'))).toBe(true)
    expect(existsSync(join(root, 'migration.json'))).toBe(false)
  })
})

describe('HTML 源码', () => {
  it('单独存放，不进 config.json，也不进快照', () => {
    const s = open()
    const it = s.create('问卷')
    s.setHtml(it.id, '<form>hello</form>')
    s.createSnapshot(it.id, 'manual')

    const raw = readFileSync(join(root, 'tasks', it.id, 'config.json'), 'utf-8')
    expect(raw).not.toContain('form>hello')

    const snap = readFileSync(
      join(root, 'tasks', it.id, 'snapshots', readdirSync(join(root, 'tasks', it.id, 'snapshots'))[0]),
      'utf-8'
    )
    expect(snap).not.toContain('form>hello')

    expect(s.getHtml(it.id)).toBe('<form>hello</form>')
    expect(s.list()[0].hasHtml).toBe(true)
    s.setHtml(it.id, '')
    expect(s.getHtml(it.id)).toBeNull()
    expect(s.list()[0].hasHtml).toBe(false)
  })
})
