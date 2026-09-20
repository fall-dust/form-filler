import { describe, it, expect } from 'vitest'
import {
  getLiveSession,
  setSession,
  closeSession,
  closeAllSessions,
  hasLiveSession,
  type FillSession
} from '../session'

/** 造一个够用的假会话（只实现 session.ts 用到的 browser/page 接口） */
function makeFake(opts: { connected?: boolean; closed?: boolean } = {}): {
  session: FillSession
  state: { connected: boolean; closed: boolean }
  fireDisconnect: () => void
} {
  const disconnects: Array<() => void> = []
  const state = { connected: opts.connected ?? true, closed: opts.closed ?? false }
  const browser = {
    isConnected: (): boolean => state.connected,
    close: async (): Promise<void> => {
      state.connected = false
      disconnects.forEach((f) => f())
    },
    on: (ev: string, fn: () => void): void => {
      if (ev === 'disconnected') disconnects.push(fn)
    }
  }
  const page = { isClosed: (): boolean => state.closed }
  const session = { browser, context: {}, page, link: 'https://x' } as unknown as FillSession
  return {
    session,
    state,
    fireDisconnect: (): void => {
      state.connected = false
      disconnects.forEach((f) => f())
    }
  }
}

describe('浏览器会话注册表（多页问卷「接着填」的复用凭据）', () => {
  it('登记后可查到存活会话；页面被关掉后判定失活并自动清理', () => {
    const { session, state } = makeFake()
    setSession('t1', session)
    expect(hasLiveSession('t1')).toBe(true)
    expect(getLiveSession('t1')).toBe(session)

    state.closed = true
    expect(getLiveSession('t1')).toBeNull()
    expect(hasLiveSession('t1')).toBe(false)
  })

  it('浏览器断开 → 触发 onGone 并从注册表移除', () => {
    const { session, fireDisconnect } = makeFake()
    let gone = 0
    setSession('t2', session, () => {
      gone++
    })
    fireDisconnect()
    expect(gone).toBe(1)
    expect(getLiveSession('t2')).toBeNull()
  })

  it('closeSession 关闭浏览器（触发 onGone）并移除登记；无登记时返回 false', async () => {
    const { session } = makeFake()
    let gone = 0
    setSession('t3', session, () => {
      gone++
    })
    expect(await closeSession('t3')).toBe(true)
    expect(gone).toBe(1)
    expect(getLiveSession('t3')).toBeNull()
    expect(await closeSession('t3')).toBe(false)
  })

  it('同一浏览器重复登记只挂一次监听（一次断开不会重复触发 onGone）', () => {
    const { session, fireDisconnect } = makeFake()
    let gone = 0
    setSession('t4', session, () => {
      gone++
    })
    // 复用同一个浏览器再登记（多页流程里每次运行都会走这一步）
    setSession('t4', session, () => {
      gone++
    })
    fireDisconnect()
    expect(gone).toBe(1)
  })

  it('closeAllSessions 关闭全部登记', async () => {
    setSession('a', makeFake().session)
    setSession('b', makeFake().session)
    await closeAllSessions()
    expect(getLiveSession('a')).toBeNull()
    expect(getLiveSession('b')).toBeNull()
  })
})
