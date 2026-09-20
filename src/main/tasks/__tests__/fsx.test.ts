import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readJson,
  recoverFromTmp,
  renameWithRetry,
  TMP_SUFFIX,
  writeJsonAtomic,
  writeTextAtomic
} from '../fsx'

/**
 * Windows 上 rename 会被杀毒实时扫描 / 搜索索引 / 缩略图进程短暂占用而抛
 * EPERM/EBUSY/EACCES。这些错误必须退避重试自愈（否则用户会看到莫名其妙的「保存失败」），
 * 而 ENOENT 这类真错误必须立刻抛出，不能被重试掩盖。
 */

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  e.code = code
  return e
}

describe('renameWithRetry：只对瞬时占用类错误退避重试', () => {
  it('连续两次 EPERM 后成功：重试生效，最终不抛错', () => {
    const rename = vi
      .fn<(f: string, t: string) => void>()
      .mockImplementationOnce(() => {
        throw errno('EPERM')
      })
      .mockImplementationOnce(() => {
        throw errno('EBUSY')
      })
      .mockImplementationOnce(() => undefined)
    const sleep = vi.fn<(ms: number) => void>()

    renameWithRetry('a', 'b', rename, sleep)

    expect(rename).toHaveBeenCalledTimes(3)
    // 退避是递增的（25ms → 50ms），不是死循环空转
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([25, 50])
  })

  it('EACCES 也在重试范围内', () => {
    const rename = vi
      .fn<(f: string, t: string) => void>()
      .mockImplementationOnce(() => {
        throw errno('EACCES')
      })
      .mockImplementationOnce(() => undefined)
    renameWithRetry('a', 'b', rename, vi.fn())
    expect(rename).toHaveBeenCalledTimes(2)
  })

  it('ENOENT（真错误）立即抛出，不重试也不小睡', () => {
    const rename = vi.fn<(f: string, t: string) => void>().mockImplementation(() => {
      throw errno('ENOENT')
    })
    const sleep = vi.fn<(ms: number) => void>()

    expect(() => renameWithRetry('a', 'b', rename, sleep)).toThrow(/ENOENT/)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('一直失败时重试到上限后把最后一次错误抛出（不无限重试）', () => {
    const rename = vi.fn<(f: string, t: string) => void>().mockImplementation(() => {
      throw errno('EPERM')
    })
    const sleep = vi.fn<(ms: number) => void>()

    expect(() => renameWithRetry('a', 'b', rename, sleep)).toThrow(/EPERM/)
    expect(rename).toHaveBeenCalledTimes(5)
  })
})

describe('原子写与崩溃残留恢复', () => {
  it('writeJsonAtomic / writeTextAtomic 内容正确且不留 .tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-fsx-'))
    try {
      const j = join(dir, 'config.json')
      const t = join(dir, 'page.html')
      writeJsonAtomic(j, { a: 1 })
      writeTextAtomic(t, '<form></form>')

      expect(readJson<{ a: number }>(j)).toEqual({ ok: true, data: { a: 1 } })
      expect(readFileSync(t, 'utf-8')).toBe('<form></form>')
      expect(() => readFileSync(`${j}${TMP_SUFFIX}`, 'utf-8')).toThrow()
      expect(() => readFileSync(`${t}${TMP_SUFFIX}`, 'utf-8')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只有 .tmp 时提升为正式文件；两者都在时丢弃 .tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-fsx-'))
    try {
      const dest = join(dir, 'config.json')
      const tmp = `${dest}${TMP_SUFFIX}`

      // 场景一：崩溃时只写了 tmp（正式文件还没出现）→ 救回内容
      writeFileSync(tmp, '{"rescued":true}')
      expect(recoverFromTmp(dir, 'config.json')).toBe(1)
      expect(readJson<{ rescued: boolean }>(dest)).toEqual({ ok: true, data: { rescued: true } })

      // 场景二：两者都在 → tmp 是不完整写入，丢弃
      writeFileSync(dest, '{"good":true}')
      writeFileSync(tmp, '{"half')
      expect(recoverFromTmp(dir, 'config.json')).toBe(1)
      expect(readJson<{ good: boolean }>(dest)).toEqual({ ok: true, data: { good: true } })

      // 没有 tmp 时不动任何东西
      expect(recoverFromTmp(dir, 'config.json')).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
