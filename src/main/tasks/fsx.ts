/**
 * 文件系统小工具：原子写、可区分「缺失 / 损坏」的读取、目录操作。
 * 全部使用同步 API —— 同步写天然串行，不存在并发写乱序的问题，
 * 也让 before-quit 的 flush 能可靠完成。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'

export const TMP_SUFFIX = '.tmp'

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true })
}

const RENAME_RETRIES = 5
const RENAME_BASE_DELAY_MS = 25

/**
 * Windows 上 rename 是「替换式」，目标文件被其他进程（杀毒实时扫描、搜索索引、
 * 资源管理器缩略图）短暂持有句柄时会抛 EPERM/EBUSY/EACCES —— 通常几毫秒后就消失。
 * 这类错误不该冒泡成「保存失败」让用户看到，退避重试即可自愈；其余错误原样抛出。
 */
function isTransientRenameError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/** 同步小睡（Atomics.wait 到点即返，不空转烧 CPU）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 带退避重试的 rename：只对瞬时占用类错误重试，其余立即抛出。
 * rename 可注入 —— 只为测试能造出「先抛 EPERM 再成功」的序列，生产路径一律用 renameSync。
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (f: string, t: string) => void = renameSync,
  sleep: (ms: number) => void = sleepSync
): void {
  let lastErr: unknown
  for (let i = 0; i < RENAME_RETRIES; i++) {
    try {
      rename(from, to)
      return
    } catch (e) {
      lastErr = e
      if (!isTransientRenameError(e)) throw e
      sleep(RENAME_BASE_DELAY_MS * (i + 1))
    }
  }
  throw lastErr
}

/** 原子写 JSON：写临时文件再 rename 覆盖（Windows 上 rename 走 REPLACE_EXISTING）。 */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(dirname(file))
  const tmp = `${file}${TMP_SUFFIX}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameWithRetry(tmp, file)
}

export function writeTextAtomic(file: string, text: string): void {
  ensureDir(dirname(file))
  const tmp = `${file}${TMP_SUFFIX}`
  writeFileSync(tmp, text, 'utf-8')
  renameWithRetry(tmp, file)
}

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupt'; error: string }

/** 读取 JSON，明确区分「不存在」与「存在但损坏」——后者要触发快照恢复/改名保留。 */
export function readJson<T>(file: string): ReadResult<T> {
  if (!existsSync(file)) return { ok: false, reason: 'missing' }
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf-8')) as T }
  } catch (e) {
    return { ok: false, reason: 'corrupt', error: e instanceof Error ? e.message : String(e) }
  }
}

export function readText(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

export function removeDir(p: string): void {
  rmSync(p, { recursive: true, force: true })
}

export function removeFile(p: string): void {
  rmSync(p, { force: true })
}

/** 同卷移动目录（回收站软删除用；原子且不复制数据） */
export function moveDir(from: string, to: string): void {
  ensureDir(dirname(to))
  if (existsSync(to)) throw new Error(`目标已存在：${to}`)
  renameSync(from, to)
}

/** 单文件改名（损坏文件留证：config.json → config.corrupt-<ts>.json） */
export function moveFile(from: string, to: string): void {
  ensureDir(dirname(to))
  renameWithRetry(from, to)
}

/** 列出目录下的直接子目录名（目录不存在返回空数组） */
export function listDirs(p: string): string[] {
  if (!existsSync(p)) return []
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function listFiles(p: string): string[] {
  if (!existsSync(p)) return []
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function mtimeIso(p: string): string {
  try {
    return statSync(p).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

export function fileSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/**
 * 崩溃残留清理：某文件同时存在 `.tmp` 与正式文件时删掉 `.tmp`（tmp 是不完整写入）；
 * 只有 `.tmp` 而正式文件缺失时，把它提升为正式文件（尽可能救回内容）。
 * 返回处理过的文件数。
 */
export function recoverFromTmp(dir: string, baseName: string): number {
  const dest = join(dir, baseName)
  const tmp = `${dest}${TMP_SUFFIX}`
  if (!existsSync(tmp)) return 0
  if (existsSync(dest)) {
    removeFile(tmp)
    return 1
  }
  renameWithRetry(tmp, dest)
  return 1
}
