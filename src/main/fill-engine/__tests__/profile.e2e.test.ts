import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureSession, getLiveSession, closeSession } from '../session'

/**
 * 登录态持久化 —— 这是「有登录环节」开关的替代方案。
 *
 * 客户端为每个任务固定分配 `<userData>/profile/<taskId>` 作浏览器 profile 目录
 * （见 main/index.ts 的 profileDir），于是「登录一次」应当长期有效：
 * 关掉窗口（甚至关掉再开）都还带着 cookie，而不是每次都要人工过一遍登录。
 *
 * 用本地 http 服务模拟登录页，不依赖外网：
 * - `?set=1` 模拟登录动作：写下 cookie；
 * - 不带参数则是复查：把「有没有 cookie」写进标题，由测试读出来判断。
 *
 * ⚠️ cookie 必须带 `max-age`：**没有过期时间的 cookie 是「会话 cookie」，
 * Chromium 从不把它写进磁盘**（浏览会话一结束就丢）。真实站点的登录 cookie
 * 一般都有有效期，所以这里也照那样写 —— 用会话 cookie 测会得到假的「没持久化」。
 */
const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><title>未登录</title></head><body>
<script>
  if (location.search.includes('set=1')) document.cookie = 'ff_session=ok; path=/; max-age=86400';
  document.title = document.cookie.includes('ff_session=ok') ? '已登录' : '未登录';
</script>
</body></html>`

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const tempDirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ff-profile-'))
  tempDirs.push(d)
  return d
}

afterAll(() => {
  // Chromium 可能还攥着个别文件句柄（chrome_debug.log 之类），清理失败不能连累整个用例
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch {
      /* 临时目录，留待系统回收 */
    }
  }
})

describe('登录态持久化：登录一次，关掉浏览器重开仍在', () => {
  it('同一 profile 目录：登录后结束会话，重开时 cookie 还在', async () => {
    const dir = freshDir()
    const key = 'persist-login'
    try {
      // ① 登录（页面自己写 cookie）
      await ensureSession(key, `${origin}?set=1`, { headless: true, userDataDir: dir }, 200)
      const first = getLiveSession(key)
      expect(first).not.toBeNull()
      expect(await first!.page.title()).toBe('已登录')
      // profile 目录确实被 Chromium 用起来了（不是空目录混过去）
      expect(readdirSync(dir).length).toBeGreaterThan(0)

      // ② 结束会话 —— 浏览器进程真的退出（profile 目录锁随之释放）
      await closeSession(key)
      expect(getLiveSession(key)).toBeNull()

      // ③ 重开同一 profile：登录态必须从盘上回来，不需要重新登录
      await ensureSession(key, origin, { headless: true, userDataDir: dir }, 200)
      const second = getLiveSession(key)
      expect(await second!.page.title()).toBe('已登录')
      const names = (await second!.context.cookies(origin)).map((c) => c.name)
      expect(names).toContain('ff_session')
    } finally {
      await closeSession(key)
    }
  }, 180000)

  it('换个 profile 目录（= 另一个任务，或点过「清除登录态」）→ 需要重新登录', async () => {
    const key = 'fresh-profile'
    try {
      await ensureSession(key, origin, { headless: true, userDataDir: freshDir() }, 200)
      expect(await getLiveSession(key)!.page.title()).toBe('未登录')
    } finally {
      await closeSession(key)
    }
  }, 180000)
})
