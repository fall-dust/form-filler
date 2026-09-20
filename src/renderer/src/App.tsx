import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SideNote } from './components/SideNote'
import TaskFlow from './components/TaskFlow'
import TaskManager from './components/TaskManager'
import { fingerprint, freshnessOf, questionsFingerprint } from './freshness'
import { carryAnswers, pageTitle, routeGrab } from './pages'
import type {
  ExportOutcome,
  FillProgress,
  FillReport,
  ImportOutcome,
  NextButton,
  Question,
  SaveStateEvent,
  StartupNotice,
  TaskConfig,
  TaskIndexItem,
  TaskStoreSettings
} from './types'
import './App.css'

/** 每个任务的运行态（只在内存，不持久化） */
interface TabRuntime {
  progress: FillProgress[]
  report: FillReport | null
  running: boolean
  error: string
}

const EMPTY_RUNTIME: TabRuntime = { progress: [], report: null, running: false, error: '' }

/** 浏览器会话状态（多页问卷「接着填」：复用同一窗口，在其当前页继续填） */
interface SessionStatus {
  open: boolean
  url?: string
}

interface Toast {
  text: string
  /** 可撤销的软删除 */
  undo?: { id: string; name: string }
}

interface ConfirmState {
  title: string
  body: string
  okText: string
  danger?: boolean
  onOk: () => void
}

interface InfoState {
  title: string
  body: string
}

function initAnswers(qs: Question[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const q of qs) m[q.id] = ''
  return m
}

/** 空任务（无题目、无答案、无 HTML）删除时不进历史任务，避免垃圾堆积 */
function isBlankTask(it: TaskIndexItem): boolean {
  return it.questionCount === 0 && it.answerCount === 0 && !it.hasHtml
}

export default function App(): JSX.Element {
  const [tasks, setTasks] = useState<TaskIndexItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [cfg, setCfg] = useState<TaskConfig | null>(null)
  const [html, setHtml] = useState('')

  const [runtime, setRuntime] = useState<Record<string, TabRuntime>>({})
  // 断点续填是「本次运行」的选择，不落盘（与 autoSubmit 这类任务级设置不同）
  const [onlyMissing, setOnlyMissing] = useState(false)
  // 浏览器会话状态按任务缓存（多页问卷「接着填」复用同一窗口）
  const [sessions, setSessions] = useState<Record<string, SessionStatus>>({})
  const [sessionBusy, setSessionBusy] = useState('')
  /**
   * 每个任务「识别到的翻页按钮」缓存。识别是只读的，点它翻页则由用户明确点击触发
   * —— 程序绝不自己翻页，更不会去点提交/完成类按钮（识别阶段已排除）。
   */
  const [nextButtons, setNextButtons] = useState<Record<string, NextButton[]>>({})
  const [nextBusy, setNextBusy] = useState('')
  const [save, setSave] = useState<SaveStateEvent | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [info, setInfo] = useState<InfoState | null>(null)

  const [managerOpen, setManagerOpen] = useState(false)
  const [storeSettings, setStoreSettings] = useState<TaskStoreSettings | null>(null)

  const [editingId, setEditingId] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const skipRenameCommit = useRef(false)
  const dragFrom = useRef<number | null>(null)

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const htmlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 防抖待写盘的 HTML 连同目标任务 id 一起记录：即使中途切换任务，补写也只落到原任务
  const pendingHtml = useRef<{ id: string; html: string } | null>(null)

  const rt = runtime[activeId] ?? EMPTY_RUNTIME
  const session = sessions[activeId] ?? { open: false }
  const nextCands = nextButtons[activeId] ?? []
  const busy = sessionBusy !== '' || nextBusy !== '' || rt.running
  /**
   * 启动浏览器：只要有目标链接就行 —— 题目/答案还没生成也能先把页面开起来
   * （提前登录、提前翻页、提前看清结构），不必等 HTML/题目就绪。
   */
  const canOpen = !!cfg && cfg.link.trim() !== '' && !busy
  /**
   * 抓取：**必须先有浏览器窗口**，不会自行打开 —— 页面还没打开就抓只会抓到空壳。
   * 真正点击时主进程还会再等页面加载好（未就绪则如实报错，不抓空壳）。
   */
  const canGrab = canOpen && session.open

  /**
   * 步骤对钩的「有效性」：上游内容一变，下游对钩就收回。
   * 判定是纯函数（freshness.ts），这里只负责把「当前 HTML 指纹 / 题目指纹」喂进去。
   */
  const htmlFp = useMemo(() => fingerprint(html), [html])
  const fresh = useMemo(
    () =>
      freshnessOf({
        htmlFp,
        hasHtml: html.trim() !== '',
        questions: cfg?.questions ?? [],
        hasAnswers: Object.values(cfg?.answers ?? {}).some((v) => v.trim() !== ''),
        questionsFor: cfg?.questionsFor,
        answersFor: cfg?.answersFor
      }),
    [htmlFp, html, cfg?.questions, cfg?.answers, cfg?.questionsFor, cfg?.answersFor]
  )

  const showToast = useCallback((next: Toast, ms = 3000): void => {
    setToast(next)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    // 可撤销的删除多留一会儿，给足反应时间
    toastTimer.current = setTimeout(() => setToast(null), next.undo ? 8000 : ms)
  }, [])

  const refreshTasks = useCallback(async (): Promise<TaskIndexItem[]> => {
    const list = (await window.api.tasksList()) as TaskIndexItem[]
    setTasks(list)
    return list
  }, [])

  // ---- 启动：载入任务列表（首次运行为空则建一个），并读取启动期提示 ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let list = (await window.api.tasksList()) as TaskIndexItem[]
      if (list.length === 0) {
        const created = (await window.api.tasksCreate()) as TaskIndexItem
        list = [created]
      }
      if (cancelled) return
      setTasks(list)
      setActiveId(list[0].id)

      const notice = (await window.api.startupNotice()) as StartupNotice | null
      if (cancelled || !notice) return
      if (notice.migrated) {
        const m = notice.migrated
        const extra = m.backupDir ? `原目录已备份为 ${m.backupDir}。` : ''
        const skipped = m.skipped.length ? `（${m.skipped.length} 个无法读取已跳过）` : ''
        setInfo({
          title: '已迁移旧配置',
          body: `已把 ${m.count} 个旧的「项目」配置迁移为任务${skipped}。${extra}`
        })
      } else if (notice.trashCleaned > 0) {
        showToast({ text: `已清理 ${notice.trashCleaned} 个超过保留期的历史任务` }, 4000)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showToast])

  // ---- 切换任务时按需加载完整配置与 HTML ----
  useEffect(() => {
    let cancelled = false
    if (!activeId) {
      setCfg(null)
      setHtml('')
      return
    }
    void (async () => {
      const c = (await window.api.tasksGet(activeId)) as TaskConfig | null
      const h = (await window.api.tasksGetHtml(activeId)) as string | null
      if (cancelled) return
      const raw = h ?? ''
      // 旧任务没有指纹记录：按「当前 HTML / 当前题目就是它的来源」回填一次。
      // 不回填的话，之后抓新页时无从判断题目是不是上一版页面生成的，对钩就永远收不回来。
      const filled: Partial<TaskConfig> = {}
      if (c && c.questions.length > 0 && !c.questionsFor && raw.trim()) {
        filled.questionsFor = fingerprint(raw)
      }
      if (
        c &&
        c.questions.length > 0 &&
        !c.answersFor &&
        Object.values(c.answers).some((v) => v.trim() !== '')
      ) {
        filled.answersFor = questionsFingerprint(c.questions)
      }
      if (c && Object.keys(filled).length > 0) {
        void window.api.tasksPatch(c.id, filled)
        setCfg({ ...c, ...filled })
      } else {
        setCfg(c)
      }
      setHtml(raw)
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  // ---- 保存态指示灯 ----
  useEffect(() => window.api.onTasksState((raw) => setSave(raw as SaveStateEvent)), [])

  // ---- 索引变更（落盘 / 导入 / 迁移）→ 刷新列表；无变化时不触发渲染 ----
  useEffect(() => {
    return window.api.onTasksChanged(() => {
      void (async () => {
        const list = (await window.api.tasksList()) as TaskIndexItem[]
        setTasks((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list))
      })()
    })
  }, [])

  // ---- 填写进度：按 runId（= 任务 id）路由 ----
  useEffect(() => {
    const offProgress = window.api.onFillProgress((raw) => {
      const p = raw as FillProgress & { runId: string }
      setRuntime((prev) => {
        const cur = prev[p.runId] ?? EMPTY_RUNTIME
        return { ...prev, [p.runId]: { ...cur, progress: [...cur.progress, p] } }
      })
    })
    return offProgress
  }, [])

  useEffect(() => {
    void (async () => {
      setStoreSettings((await window.api.tasksSettingsGet()) as TaskStoreSettings)
    })()
  }, [])

  // ---- 浏览器会话：订阅主进程推送（打开/结束），切任务时再查询一次兜底 ----
  useEffect(() => {
    return window.api.onFillSession((p) => {
      setSessions((prev) => ({ ...prev, [p.taskId]: { open: p.open, url: p.url } }))
    })
  }, [])

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    void (async () => {
      try {
        const s = (await window.api.fillSessionStatus(activeId)) as SessionStatus
        if (!cancelled) setSessions((prev) => ({ ...prev, [activeId]: s }))
      } catch {
        /* 查询失败按「未打开」处理 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  // ---- 编辑：本地立即反馈，主进程防抖写盘（无需「保存」按钮） ----
  const patch = useCallback(
    (p: Partial<TaskConfig>): void => {
      if (!activeId) return
      setCfg((prev) => (prev ? { ...prev, ...p } : prev))
      void window.api.tasksPatch(activeId, p)
    },
    [activeId]
  )

  /** HTML 体积大，本地再防抖一次，避免每次按键都写盘 */
  const onHtmlChange = useCallback(
    (v: string): void => {
      setHtml(v)
      if (!activeId) return
      if (htmlTimer.current) clearTimeout(htmlTimer.current)
      pendingHtml.current = { id: activeId, html: v }
      htmlTimer.current = setTimeout(() => {
        const p = pendingHtml.current
        pendingHtml.current = null
        htmlTimer.current = null
        if (p) void window.api.tasksSetHtml(p.id, p.html)
      }, 800)
    },
    [activeId]
  )

  // 持久化兜底：窗口失焦 / 刷新关闭前，把防抖中还没写盘的 HTML 立刻补写，
  // 避免「粘贴完 800ms 内关窗」丢最后一次输入。pendingHtml 自带任务 id，不会写错任务。
  useEffect(() => {
    const flushHtml = (): void => {
      if (!pendingHtml.current) return
      const p = pendingHtml.current
      pendingHtml.current = null
      if (htmlTimer.current) {
        clearTimeout(htmlTimer.current)
        htmlTimer.current = null
      }
      void window.api.tasksSetHtml(p.id, p.html)
    }
    window.addEventListener('blur', flushHtml)
    window.addEventListener('beforeunload', flushHtml)
    return () => {
      window.removeEventListener('blur', flushHtml)
      window.removeEventListener('beforeunload', flushHtml)
    }
  }, [])

  const handleImport = (qs: Question[]): void => {
    // 多页问卷常有重复题（每页都问一次满意度）：把**上一页**里题干与选项完全一致的题的答案带过来，
    // 省一次生成。只认完全一样的题 —— 不确定的一律空着，宁可多填一次也不能张冠李戴。
    const pages = cfg?.pages ?? []
    const idx = pages.findIndex((p) => p.id === cfg?.activePageId)
    const prevPage = idx > 0 ? pages[idx - 1] : null
    const carried = carryAnswers(prevPage, qs)
    const carriedCount = Object.keys(carried).length
    // 记下这版题目对应的 HTML 指纹；答案被重置，对应的答案指纹一并清掉
    patch({
      questions: qs,
      answers: { ...initAnswers(qs), ...carried },
      questionsFor: htmlFp,
      answersFor: carriedCount > 0 ? questionsFingerprint(qs) : undefined
    })
    setRuntime((prev) => ({ ...prev, [activeId]: EMPTY_RUNTIME }))
    void window.api.tasksSnapshotCreate(activeId, 'key-action')
    void refreshTasks()
    if (carriedCount > 0) {
      showToast({ text: `已带入上一页 ${carriedCount} 道同题的作答（可在第 4 步修改）` }, 6000)
    }
  }

  const handleImportAnswers = (ans: Record<string, string>): void => {
    if (!cfg) return
    const answers = { ...cfg.answers, ...ans }
    // 记下这组答案对应的题目指纹：题目一换，答案的对钩就自动收回
    patch({ answers, answersFor: questionsFingerprint(cfg.questions) })
    void window.api.tasksSnapshotCreate(activeId, 'key-action')
  }

  /**
   * 「其实还是同一页」：把题目的指纹重新盖到当前 HTML 上，已收回的对钩随之复原。
   * 给「页面内容有细微变动（时间戳/随机前缀等）但题目仍然适用」留的活口 ——
   * 不重新生成，但也意味着这是**你自己下的判断**。
   */
  const confirmSameHtml = (): void => {
    if (!activeId || !cfg) return
    patch({ questionsFor: htmlFp })
    showToast({ text: '已记为「同一页」：保留现有题目与答案' }, 4000)
  }

  const handleRun = async (): Promise<void> => {
    if (!activeId || !cfg) return
    const id = activeId
    setRuntime((prev) => ({
      ...prev,
      [id]: { progress: [], report: null, running: true, error: '' }
    }))
    const answerMap: Record<string, string | string[]> = {}
    for (const q of cfg.questions) {
      const raw = cfg.answers[q.id] ?? ''
      answerMap[q.id] =
        q.type === 'checkbox' ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : raw
    }
    try {
      const rep = (await window.api.fillRun(
        {
          config: {
            link: cfg.link,
            autoSubmit: cfg.autoSubmit,
            waitTimeout: 10000,
            waitAfterLoad: 1000,
            outputDir: 'output',
            // 断点续填的状态文件按任务隔离（相对路径由主进程归一到 userData）
            ...(onlyMissing ? { statePath: `state/${id}.json` } : {}),
            ...(cfg.channel ? { channel: cfg.channel } : {})
          },
          questions: cfg.questions,
          answers: answerMap,
          ...(onlyMissing ? { onlyMissing: true } : {})
        },
        id
      )) as FillReport
      setRuntime((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? EMPTY_RUNTIME), report: rep, running: false }
      }))
    } catch (e) {
      setRuntime((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? EMPTY_RUNTIME),
          running: false,
          error: e instanceof Error ? e.message : String(e)
        }
      }))
    }
  }

  const handleStop = async (): Promise<void> => {
    if (activeId) await window.api.fillStop(activeId)
  }

  /**
   * 抓取成功后按**页面标题**给任务起个名字 —— 纯本地解析，不联网、不调用任何模型。
   * 只有任务名还是「程序自动生成」的时候才改 —— 用户亲手改过的名字绝不动。
   * 解析不出标题：静默跳过，绝不打断抓取主流程。
   */
  const autoNameTask = async (id: string, html: string, nameAuto: boolean): Promise<void> => {
    if (!nameAuto) return
    const name = pageTitle(html)
    if (!name) return
    await window.api.tasksRename(id, name, true)
    await refreshTasks()
    setCfg((prev) => (prev && prev.id === id ? { ...prev, name, nameAuto: true } : prev))
    showToast({ text: `已按页面标题命名为「${name}」（可随时在左栏改）` }, 5000)
  }

  /**
   * 启动浏览器：**只打开目标页面，不抓取**。
   * 题目/答案还没生成也能用 —— 先开页面去登录、翻页、看清结构，再决定抓哪一页。
   */
  const doOpenBrowser = async (): Promise<void> => {
    if (!activeId || !cfg) return
    const id = activeId
    setSessionBusy('open')
    try {
      const r = (await window.api.fillSessionOpen(id, {
        link: cfg.link,
        ...(cfg.channel ? { channel: cfg.channel } : {})
      })) as { ok: boolean; opened?: boolean; url?: string; error?: string }
      if (!r.ok) {
        showToast({ text: `启动浏览器失败：${r.error ?? '未知原因'}` }, 7000)
        return
      }
      setSessions((prev) => ({ ...prev, [id]: { open: true, url: r.url } }))
      // 顺手识别一次「下一页」：刚打开就能在界面上看到翻页按钮，不必先抓一次
      const btn = await detectNext(id)
      showToast(
        {
          text: `${r.opened ? '浏览器已打开' : '浏览器窗口已在前台'}：${
            btn.length > 0
              ? `识别到翻页按钮「${btn[0].text}」（在步骤 1 里可直接点它翻页并存成新页）`
              : '需要登录就先登录；多页问卷翻到要采集的那页后点「抓取当前页 HTML」'
          }`
        },
        8000
      )
    } catch (e) {
      showToast({ text: `启动浏览器失败：${e instanceof Error ? e.message : String(e)}` }, 7000)
    } finally {
      setSessionBusy('')
    }
  }

  /**
   * 识别存活页面里的「下一页」按钮（**只读**，不点任何东西），并缓存给界面显示。
   * 识别失败（页面已关、evaluate 超时）一律返回空列表，绝不打断主流程。
   */
  const detectNext = useCallback(async (id: string): Promise<NextButton[]> => {
    try {
      const r = (await window.api.fillSessionNext(id)) as { ok: boolean; next?: NextButton[] }
      const list = r?.ok ? (r.next ?? []) : []
      setNextButtons((prev) => ({ ...prev, [id]: list }))
      return list
    } catch {
      return []
    }
  }, [])

  /**
   * 把防抖中还没落盘的手工编辑立刻写回**当前页**。
   * 切页 / 抓取落页 / 删页之前必须先做 —— 否则「改完 HTML 立刻切页」会丢掉最后那一下输入，
   * 而且迟到的写盘会落到**切换后**的那一页上（写到别的页去）。
   */
  const flushPendingHtml = useCallback(async (): Promise<void> => {
    const p = pendingHtml.current
    if (htmlTimer.current) {
      clearTimeout(htmlTimer.current)
      htmlTimer.current = null
    }
    pendingHtml.current = null
    if (p) await window.api.tasksSetHtml(p.id, p.html)
  }, [])

  /** 新的页面存档生效：清掉防抖残留（内容已在切换前 flush 过），再用该页的内容刷新界面 */
  const applyPageCfg = useCallback(async (id: string, next: TaskConfig): Promise<void> => {
    if (htmlTimer.current) {
      clearTimeout(htmlTimer.current)
      htmlTimer.current = null
    }
    pendingHtml.current = null
    setCfg(next)
    const h = (await window.api.tasksGetHtml(id)) as string | null
    setHtml(h ?? '')
  }, [])
  /**
   * 抓取浏览器当前页 HTML。
   *
   * **必须先有浏览器窗口**（不会自行打开）：页面没打开就抓只会抓到空壳。
   * 主进程会先等页面真正加载好（因此可能要等几秒），未就绪就如实报错。
   * 抓回来后按内容**落到对应的页**（routeGrab）：见过的页只更新 HTML 与指纹，
   * 题目/答案照旧沿用（这就是多页问卷不必反复重来的关键）；没见过的才存为新页。
   * 覆盖前的那一份由主进程自动存进「历史版本」；抓完顺手按页面标题给任务命名。
   */
  const doGrabHtml = async (): Promise<void> => {
    if (!activeId || !cfg) return
    const id = activeId
    setSessionBusy('grab')
    try {
      await flushPendingHtml()
      const r = (await window.api.fillSessionGrab(id, { link: cfg.link })) as {
        ok: boolean
        html?: string
        url?: string
        frames?: number
        archived?: boolean
        next?: NextButton[]
        error?: string
      }
      if (!r.ok || !r.html) {
        showToast({ text: `抓取失败：${r.error ?? '未知原因'}` }, 7000)
        return
      }
      // 抓取时主进程顺带识别了一次翻页按钮
      if (r.next) setNextButtons((prev) => ({ ...prev, [id]: r.next as NextButton[] }))

      const pages = cfg.pages ?? []
      const { route, fp, sig } = routeGrab({ html: r.html, pages, activePageId: cfg.activePageId })
      const target = pages.find((p) => p.id === (route.kind === 'new-page' ? '' : route.pageId))
      const title = pageTitle(r.html)
      const capturedAt = new Date().toISOString()
      let next: TaskConfig | null = null

      if (route.kind === 'new-page') {
        next = (await window.api.tasksPageCreate(id, {
          html: r.html,
          url: r.url ?? '',
          fp,
          sig,
          ...(title ? { name: title } : {})
        })) as TaskConfig | null
      } else {
        // 已有的页：更新 HTML 与指纹（页名若还是自动起的，就跟着页面标题走）
        const patchPage: Record<string, unknown> = { fp, sig, capturedAt, url: r.url ?? '' }
        if (title && target?.nameAuto !== false) patchPage.name = title
        // 「结构上是同一页」= 只是重新渲染过：把题目的指纹重盖到新 HTML 上，
        // 题目与答案继续有效，不重新生成、不花额度。
        if (route.kind === 'same-page' && (target?.questions.length ?? 0) > 0) {
          patchPage.questionsFor = fp
        }
        next = (await window.api.tasksPagePatch(id, route.pageId, patchPage)) as TaskConfig | null
        await window.api.tasksPageSetHtml(id, route.pageId, r.html)
        if (cfg.activePageId !== route.pageId) {
          next = (await window.api.tasksPageSelect(id, route.pageId)) as TaskConfig | null
        }
      }
      if (next) await applyPageCfg(id, next)
      else onHtmlChange(r.html)

      const frames = `${r.frames ?? 1} 个 frame`
      const archived = r.archived ? '上一份内容已存进「历史版本」可回滚' : ''
      const msg =
        route.kind === 'refresh'
          ? `已更新这一页的 HTML（与上次一字不差）：题目与答案继续有效`
          : route.kind === 'same-page'
            ? `已按页面结构判定为同一页并更新 HTML（${frames}）：题目与答案继续沿用，不必重新生成`
            : route.kind === 'fill'
              ? `已抓取本页 HTML（${frames}）`
              : `已存为新页「${title || '新页'}」：这一页的题目与答案单独保存，翻回来也不会丢`
      showToast(
        {
          text: [
            msg,
            archived,
            // 界面跟着浏览器里的实际页面走：抓到哪一页就切到哪一页（免得「看着 A 页却在填 B 页」）
            route.kind !== 'new-page' && cfg.activePageId !== route.pageId
              ? `已切到「${
                  next?.pages?.find((p) => p.id === route.pageId)?.name ?? target?.name ?? '对应页'
                }」（浏览器里现在就是这一页）`
              : '',
            route.kind === 'fill' || route.kind === 'new-page' ? '接着先生成题目' : ''
          ]
            .filter(Boolean)
            .join('；')
        },
        9000
      )
      // 命名是「锦上添花」，不阻塞抓取结果；失败静默
      void autoNameTask(id, r.html, cfg.nameAuto !== false)
    } catch (e) {
      showToast({ text: `抓取失败：${e instanceof Error ? e.message : String(e)}` }, 7000)
    } finally {
      setSessionBusy('')
    }
  }

  /**
   * 点界面上识别到的「下一页」按钮 → 在浏览器里翻页 → 重新识别（新页的按钮可能不同）。
   * 仅在用户明确点击时调用；程序不会自己翻页。
   */
  const doClickNext = async (target: NextButton): Promise<void> => {
    if (!activeId) return
    const id = activeId
    setNextBusy('click')
    try {
      const r = (await window.api.fillSessionClickNext(id, {
        selector: target.selector,
        text: target.text,
        frameUrl: target.frameUrl
      })) as { ok: boolean; strategy?: string; url?: string; ready?: boolean; readyHint?: string; error?: string }
      if (!r.ok) {
        showToast({ text: `翻页失败：${r.error ?? '未知原因'}` }, 7000)
        return
      }
      if (r.url) setSessions((prev) => ({ ...prev, [id]: { open: true, url: r.url } }))
      const list = await detectNext(id)
      showToast(
        {
          text: r.ready === false
            ? `已点「${target.text}」，但新页面还没长好（${r.readyHint ?? ''}）——稍等一下再抓取`
            : `已点「${target.text}」翻页：${
                list.length > 0 ? `识别到新按钮「${list[0].text}」` : '可直接点「抓取当前页 HTML」'
              }`
        },
        7000
      )
    } catch (e) {
      showToast({ text: `翻页失败：${e instanceof Error ? e.message : String(e)}` }, 7000)
    } finally {
      setNextBusy('')
    }
  }

  /**
   * 「翻页并抓取」：点按钮 → 等新页长好 → 抓取并按内容落页（新页会存成新的一页）。
   * 这是多页问卷最常用的一个动作：一次点击就把下一页收进档。
   */
  const doNextAndGrab = async (target: NextButton): Promise<void> => {
    if (!activeId) return
    setNextBusy('next-grab')
    try {
      const r = (await window.api.fillSessionClickNext(activeId, {
        selector: target.selector,
        text: target.text,
        frameUrl: target.frameUrl
      })) as { ok: boolean; url?: string; ready?: boolean; readyHint?: string; error?: string }
      if (!r.ok) {
        showToast({ text: `翻页失败：${r.error ?? '未知原因'}` }, 7000)
        return
      }
      if (r.ready === false) {
        showToast({ text: `已翻页，但新页面还没长好（${r.readyHint ?? ''}）：先别抓，稍等再点「抓取当前页 HTML」` }, 8000)
        return
      }
      if (r.url) setSessions((prev) => ({ ...prev, [activeId]: { open: true, url: r.url } }))
    } catch (e) {
      showToast({ text: `翻页失败：${e instanceof Error ? e.message : String(e)}` }, 7000)
      return
    } finally {
      setNextBusy('')
    }
    // 翻页成功后就走正常抓取：落页、存档、识别按钮都在那条路上
    await doGrabHtml()
  }

  /** 切换当前页：顶层题目/答案换成该页的，对钩按该页自己的指纹判定 */
  const doSelectPage = async (pageId: string): Promise<void> => {
    if (!activeId || pageId === cfg?.activePageId) return
    await flushPendingHtml()
    const next = (await window.api.tasksPageSelect(activeId, pageId)) as TaskConfig | null
    if (next) {
      await applyPageCfg(activeId, next)
      // 旧报告是另一页跑出来的，清掉免得看串
      setRuntime((prev) => ({ ...prev, [activeId]: EMPTY_RUNTIME }))
    }
  }

  const doRenamePage = async (pageId: string, name: string): Promise<void> => {
    if (!activeId || !name.trim()) return
    const next = (await window.api.tasksPagePatch(activeId, pageId, {
      name: name.trim(),
      nameAuto: false
    })) as TaskConfig | null
    if (next) setCfg(next)
  }

  const doDeletePage = (pageId: string, name: string): void => {
    if (!activeId) return
    const id = activeId
    const only = (cfg?.pages?.length ?? 0) <= 1
    setConfirm({
      title: only ? '清空这一页' : '删除这一页',
      body: only
        ? `将清空「${name}」的 HTML、题目与答案（任务至少保留一页）。清空前会自动留一份历史版本，可回滚。`
        : `将删除「${name}」这一页的 HTML、题目与答案，其余页不受影响。删除前会自动留一份历史版本，可回滚。`,
      okText: only ? '清空这一页' : '删除这一页',
      danger: true,
      onOk: () => {
        void (async () => {
          await flushPendingHtml()
          const next = (await window.api.tasksPageDelete(id, pageId)) as TaskConfig | null
          if (next) {
            await applyPageCfg(id, next)
            setRuntime((prev) => ({ ...prev, [id]: EMPTY_RUNTIME }))
          }
          showToast({ text: `已${only ? '清空' : '删除'}「${name}」（可在历史版本回滚）` }, 5000)
        })()
      }
    })
  }

  /** 结束会话：关闭该任务的浏览器窗口，下次运行重新打开（从头开始） */
  const doCloseSession = async (): Promise<void> => {
    if (!activeId) return
    const id = activeId
    setSessionBusy('close')
    try {
      await window.api.fillSessionClose(id)
      setSessions((prev) => ({ ...prev, [id]: { open: false } }))
      setNextButtons((prev) => ({ ...prev, [id]: [] }))
    } finally {
      setSessionBusy('')
    }
  }

  /**
   * 清除登录态：关掉该任务的浏览器窗口，并删掉它保存的登录信息（profile 里的 cookie）。
   * 登录态默认长期保留，只有换账号或登录态坏了才需要清。
   */
  const doResetLogin = (): void => {
    if (!activeId) return
    const id = activeId
    setConfirm({
      title: '清除登录态',
      body: '将关闭该任务的浏览器窗口，并删掉它保存的登录信息（cookie）。下次打开需要重新登录；链接、题目、答案都不受影响。',
      okText: '清除登录态',
      danger: true,
      onOk: () => {
        void (async () => {
          setSessionBusy('reset')
          try {
            const r = (await window.api.fillSessionResetProfile(id)) as {
              ok: boolean
              error?: string
            }
            setSessions((prev) => ({ ...prev, [id]: { open: false } }))
            showToast(
              {
                text: r.ok ? '已清除登录态：下次打开浏览器需要重新登录。' : (r.error ?? '清除失败')
              },
              6000
            )
          } finally {
            setSessionBusy('')
          }
        })()
      }
    })
  }

  // ---- 任务生命周期 ----
  const addTask = async (): Promise<void> => {
    const t = (await window.api.tasksCreate()) as TaskIndexItem
    await refreshTasks()
    setActiveId(t.id)
  }

  const commitRename = async (): Promise<void> => {
    if (skipRenameCommit.current) {
      skipRenameCommit.current = false
      setEditingId('')
      return
    }
    const id = editingId
    const name = renameValue.trim()
    setEditingId('')
    if (!id || !name) return
    await window.api.tasksRename(id, name)
    await refreshTasks()
  }

  const removeTask = async (id: string): Promise<void> => {
    const it = tasks.find((t) => t.id === id)
    if (!it) return
    const blank = isBlankTask(it)
    await window.api.tasksTrash(id)
    if (blank) await window.api.trashPurge(id)
    const list = await refreshTasks()
    if (id === activeId) setActiveId(list[0]?.id ?? '')
    showToast(
      blank
        ? { text: '已删除空任务' }
        : { text: `已删除「${it.name}」`, undo: { id, name: it.name } }
    )
  }

  const undoRemove = async (): Promise<void> => {
    if (!toast?.undo) return
    const { id } = toast.undo
    setToast(null)
    const restored = (await window.api.trashRestore(id)) as TaskIndexItem | null
    await refreshTasks()
    if (restored) setActiveId(restored.id)
  }

  const handleReorder = async (from: number, to: number): Promise<void> => {
    const ids = tasks.map((t) => t.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    const map = new Map(tasks.map((t) => [t.id, t]))
    setTasks(ids.map((id, i) => ({ ...map.get(id)!, order: i })))
    await window.api.tasksReorder(ids)
  }

  const doRename = async (id: string, name: string): Promise<void> => {
    await window.api.tasksRename(id, name)
    await refreshTasks()
  }

  const doDuplicate = async (id: string): Promise<void> => {
    const copy = (await window.api.tasksDuplicate(id)) as TaskIndexItem | null
    await refreshTasks()
    if (copy) {
      setActiveId(copy.id)
      showToast({ text: `已复制为「${copy.name}」` })
    }
  }

  const doResetContent = (id: string, name: string): void => {
    setConfirm({
      title: '清空任务内容',
      body: `将清空「${name}」的链接、HTML、题目与答案，任务本身和名字保留。清空前会自动留一份历史版本，可随时回滚。`,
      okText: '清空内容',
      danger: true,
      onOk: () => {
        void (async () => {
          // 取消尚未落盘的 HTML 防抖写入，否则旧内容会在 800ms 后被写回去
          if (htmlTimer.current) {
            clearTimeout(htmlTimer.current)
            htmlTimer.current = null
          }
          pendingHtml.current = null
          const next = (await window.api.tasksReset(id)) as TaskConfig | null
          if (next && id === activeId) {
            setCfg(next)
            setHtml('')
            setRuntime((prev) => ({ ...prev, [id]: EMPTY_RUNTIME }))
          }
          await refreshTasks()
          showToast({ text: '已清空内容（可在任务管理的历史版本中回滚）' }, 5000)
        })()
      }
    })
  }

  const doRollback = async (id: string, ts: string): Promise<void> => {
    const next = (await window.api.tasksRollback(id, ts)) as TaskConfig | null
    if (next && id === activeId) {
      setCfg(next)
      // 快照若带 HTML（「抓取前」的存档），回滚会连页面一起还原 —— 这里把最新 HTML 读回界面
      if (htmlTimer.current) {
        clearTimeout(htmlTimer.current)
        htmlTimer.current = null
      }
      pendingHtml.current = null
      const h = (await window.api.tasksGetHtml(id)) as string | null
      setHtml(h ?? '')
      // 旧报告对应的是回滚前那份页面，清掉免得跟新内容看串
      setRuntime((prev) => ({ ...prev, [id]: EMPTY_RUNTIME }))
    }
    await refreshTasks()
    showToast({ text: '已回滚到所选版本（存档里若含页面 HTML 也已一并还原）' }, 5000)
  }

  const doExport = async (ids: string[] | 'all'): Promise<void> => {
    try {
      const r = (await window.api.tasksExport(ids, false)) as ExportOutcome
      if (r?.message) showToast({ text: r.message }, 4000)
      else if (!r?.canceled && r?.path) showToast({ text: `已导出到 ${r.path}` }, 6000)
    } catch (e) {
      setInfo({ title: '导出失败', body: e instanceof Error ? e.message : String(e) })
    }
  }

  const doImport = async (): Promise<void> => {
    try {
      const r = (await window.api.tasksImport()) as ImportOutcome
      if (r.canceled) return
      const list = await refreshTasks()
      if (r.imported.length > 0 && !list.some((t) => t.id === activeId)) {
        setActiveId(list[0]?.id ?? '')
      }
      if (r.failed.length > 0) {
        setInfo({
          title: `已导入 ${r.imported.length} 个任务，${r.failed.length} 个失败`,
          body: r.failed.map((f) => `${f.name}：${f.reason}`).join('\n')
        })
      } else {
        showToast({ text: `已导入 ${r.imported.length} 个任务` }, 4000)
      }
    } catch (e) {
      setInfo({ title: '导入失败', body: e instanceof Error ? e.message : String(e) })
    }
  }

  const restoreFromTrash = async (id: string): Promise<void> => {
    const restored = (await window.api.trashRestore(id)) as TaskIndexItem | null
    const list = await refreshTasks()
    if (restored) {
      setActiveId(restored.id)
      showToast({ text: `已恢复「${restored.name}」` }, 4000)
    } else if (list.length > 0 && !list.some((t) => t.id === activeId)) {
      setActiveId(list[0].id)
    }
  }

  const saveLabel =
    save?.state === 'saving' ? '保存中…' : save?.state === 'error' ? '保存失败，点击重试' : '已自动保存'

  // 底部状态文案
  const last = rt.progress[rt.progress.length - 1]
  const statusText = rt.running
    ? last
      ? `正在填写 ${Math.min(last.index, last.total)}/${last.total}…`
      : '正在启动浏览器…'
    : rt.report
      ? `上次填写：已填 ${rt.report.summary.filled}/${rt.report.summary.total}`
      : (cfg?.questions.length ?? 0) > 0
        ? `${cfg?.questions.length} 题待填写`
        : '先完成左侧目标设置与右侧步骤 1-3'

  return (
    <div className="app">
      <header className="app-header">
        <h1>表单填写器</h1>
        <div className="header-actions">
          <button
            className={`save-pill ${save?.state ?? 'saved'}`}
            title={save?.message ?? '改动会自动保存到本机，无需手动保存'}
            onClick={() => {
              if (save?.state === 'error') {
                void window.api.tasksFlush()
                showToast({ text: '已重试保存' })
              }
            }}
          >
            {saveLabel}
          </button>
          <button title="任务列表、历史版本与历史任务" onClick={() => setManagerOpen(true)}>
            任务管理
          </button>
        </div>
      </header>

      {/* 任务标签栏 = 任务列表（双击重命名、拖拽排序、× 软删除） */}
      <div className="tabbar">
        {tasks.map((t, idx) => (
          <div
            key={t.id}
            className={`task-tab ${t.id === activeId ? 'active' : ''}`}
            draggable={editingId !== t.id}
            onClick={() => t.id !== activeId && setActiveId(t.id)}
            onDragStart={() => {
              dragFrom.current = idx
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragFrom.current
              dragFrom.current = null
              if (from === null || from === idx) return
              void handleReorder(from, idx)
            }}
          >
            {editingId === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') {
                    skipRenameCommit.current = true
                    setEditingId('')
                  }
                }}
              />
            ) : (
              <span
                title="双击重命名"
                onDoubleClick={() => {
                  setEditingId(t.id)
                  setRenameValue(t.name)
                }}
              >
                {t.name}
              </span>
            )}
            {runtime[t.id]?.running && <span className="dot" title="运行中" />}
            <button
              className="close"
              title="删除任务（可从历史任务恢复）"
              onClick={(e) => {
                e.stopPropagation()
                void removeTask(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="add-tab" title="新建任务" onClick={() => void addTask()}>
          ＋
        </button>
      </div>

      <div className="layout-body">
        {/* 左栏：低频的目标设置；改动全部自动保存 */}
        <aside className="sidebar">
          <p className="side-title">目标设置</p>
          <label>目标链接</label>
          <input
            type="text"
            value={cfg?.link ?? ''}
            onChange={(e) => patch({ link: e.target.value })}
            placeholder="https://example.com/form"
            disabled={!cfg}
          />
          <label style={{ marginTop: 8 }}>浏览器</label>
          <select
            value={cfg?.channel ?? ''}
            onChange={(e) => patch({ channel: e.target.value })}
            disabled={!cfg}
          >
            <option value="">随包 Chromium（默认）</option>
            <option value="msedge">系统 Edge（瘦身）</option>
            <option value="chrome">系统 Chrome（瘦身）</option>
          </select>
          <label
            className="check check-danger"
            title="⚠️ 默认关闭：填完后浏览器保持打开，人工核对后手动提交。开启后若全部题目填写成功，将自动点击提交按钮（存在未完成项时不会提交）"
          >
            <input
              type="checkbox"
              checked={cfg?.autoSubmit ?? false}
              onChange={(e) => patch({ autoSubmit: e.target.checked })}
              disabled={!cfg}
            />
            填完自动提交
          </label>

          <label
            className="check"
            title="断点续填：只重填上次没成功的题（上次已填好的题不再重复操作）。中途断了再跑最有用"
          >
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
              disabled={!cfg}
            />
            只填未完成项（续填）
          </label>

          <p className="side-title" style={{ marginTop: 16 }}>浏览器会话</p>
          <div className="session-line">
            <span className={session.open ? 'dot dot-ok' : 'dot dot-idle'} />
            {session.open ? (
              <span className="mono session-url" title={session.url ?? ''}>
                {session.url || '已打开'}
              </span>
            ) : (
              <span className="hint" style={{ margin: 0 }}>未打开（在右侧步骤 1 点「启动浏览器」）</span>
            )}
          </div>
          <div className="side-row">
            <button
              style={{ fontSize: 13, flex: 1 }}
              onClick={() => void doCloseSession()}
              disabled={!cfg || !session.open || sessionBusy !== ''}
              title="关闭该任务的浏览器窗口（登录态会保留）；下次「开始填写」会重新打开并回到目标链接（从头开始）"
            >
              {sessionBusy === 'close' ? '关闭中…' : '结束会话'}
            </button>
            <button
              style={{ fontSize: 13, flex: 1 }}
              onClick={() => doResetLogin()}
              disabled={!cfg || sessionBusy !== ''}
              title="只有换账号或登录态坏了才需要：关掉窗口并删掉该任务保存的登录信息（cookie）。登录态默认长期有效，不用每次都登"
            >
              {sessionBusy === 'reset' ? '清除中…' : '清除登录态'}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            这里只管会话；「启动浏览器」「抓取当前页 HTML」在右侧步骤 1。
          </p>
          <SideNote title="说明：会话 · 多页填写 · 登录态">
            <p>
              多页表单：填完本页 → 在浏览器里点「下一页」（或点步骤 1 里识别到的翻页按钮）→「抓取当前页 HTML」，
              每一页各自存档，翻回旧页直接沿用它的题目与答案。覆盖前的那一份会自动存进「任务管理 → 历史版本」
              （连页面一起），想回到上一页随时回滚。
            </p>
            <p>
              <b>登录一次长期有效</b>：在这个窗口里登录过后，关掉窗口、点「结束会话」、甚至改过目标链接，
              下次打开都还带着登录信息（按任务单独存在本机，不随导出外传）。要换账号才点「清除登录态」。
            </p>
          </SideNote>

          <p className="side-title" style={{ marginTop: 16 }}>任务操作</p>
          <div className="side-row">
            <button
              style={{ fontSize: 13, flex: 1 }}
              onClick={() => activeId && void doDuplicate(activeId)}
              disabled={!cfg}
            >
              复制任务
            </button>
            <button
              style={{ fontSize: 13, flex: 1 }}
              onClick={() => activeId && void doExport([activeId])}
              disabled={!cfg}
            >
              导出
            </button>
          </div>
          <div className="side-row">
            <button
              style={{ fontSize: 13, flex: 1 }}
              onClick={() => void doImport()}
            >
              导入配置
            </button>
            <button
              className="danger"
              style={{ fontSize: 13, flex: 1 }}
              onClick={() => activeId && cfg && doResetContent(activeId, cfg.name)}
              disabled={!cfg}
            >
              清空内容
            </button>
          </div>
          <SideNote title="说明：保存 · 重命名 · 删除与清空">
            <p>
              改动会自动保存到本机，无需手动保存；「×」删除后可从历史任务恢复。重命名：<b>双击上方标签页</b>。
              名字默认是「任务 N」——<b>抓取页面后会按页面标题自动命名</b>；你自己动手改过之后，就不会再被自动改名了。
            </p>
            <p>删除与清空都不可怕：删除进「历史任务」可撤销，清空前会自动留历史版本。</p>
          </SideNote>
        </aside>

        {/* 右主区：步骤流水线 */}
        <main className="main-flow">
          {!cfg ? (
            <div className="step-card">
              <div className="step-body">
                <p className="hint" style={{ margin: 0 }}>
                  暂无任务。新建一个任务开始配置。
                </p>
              </div>
            </div>
          ) : (
            <TaskFlow
              key={cfg.id}
              html={html}
              setHtml={onHtmlChange}
              onImport={handleImport}
              onImportAnswers={handleImportAnswers}
              questions={cfg.questions}
              answers={cfg.answers}
              setAnswer={(id, v) => patch({ answers: { ...cfg.answers, [id]: v } })}
              onOpenBrowser={() => void doOpenBrowser()}
              opening={sessionBusy === 'open'}
              canOpen={canOpen}
              onGrabHtml={() => void doGrabHtml()}
              grabbing={sessionBusy === 'grab'}
              canGrab={canGrab}
              sessionOpen={session.open}
              pages={cfg.pages ?? []}
              activePageId={cfg.activePageId ?? ''}
              onSelectPage={(pageId) => void doSelectPage(pageId)}
              onRenamePage={(pageId, name) => void doRenamePage(pageId, name)}
              onDeletePage={doDeletePage}
              nextButtons={nextCands}
              nextBusy={nextBusy}
              onClickNext={(b) => void doClickNext(b)}
              onNextAndGrab={(b) => void doNextAndGrab(b)}
              onDetectNext={() => void detectNext(activeId)}
              questionsStale={fresh.questionsStale}
              answersStale={fresh.answersStale}
              onConfirmSameHtml={confirmSameHtml}
              running={rt.running}
              progress={rt.progress}
              report={rt.report}
              error={rt.error}
            />
          )}
        </main>
      </div>

      {/* 底部常驻操作条 */}
      <footer className="action-bar">
        <button
          className="primary"
          onClick={() => void handleRun()}
          disabled={rt.running || (cfg?.questions.length ?? 0) === 0 || !(cfg?.link ?? '').trim()}
        >
          开始填写
        </button>
        <button className="danger" onClick={() => void handleStop()} disabled={!rt.running}>
          停止
        </button>
        <span className="hint">{statusText}</span>
        <span style={{ flex: 1 }} />
        <span className="hint">
          {cfg?.autoSubmit
            ? '填完将自动点击提交（仅当全部题目填写成功；点不到响应会提示你人工确认）'
            : '填完人工核对后手动提交（左栏可开启「填完自动提交」）'}
        </span>
      </footer>

      {managerOpen && (
        <TaskManager
          tasks={tasks}
          activeId={activeId}
          settings={storeSettings}
          onClose={() => setManagerOpen(false)}
          onSelect={(id) => {
            setActiveId(id)
            setManagerOpen(false)
          }}
          onCreate={addTask}
          onRename={doRename}
          onDuplicate={doDuplicate}
          onTrash={removeTask}
          onResetContent={doResetContent}
          onExport={doExport}
          onExportAll={() => doExport('all')}
          onImport={doImport}
          onRestore={restoreFromTrash}
          onPurgeTrash={async (id) => {
            await window.api.trashPurge(id)
            await refreshTasks()
            showToast({ text: '已彻底删除' })
          }}
          onEmptyTrash={async () => {
            const n = (await window.api.trashEmpty()) as number
            await refreshTasks()
            showToast({ text: `已清空历史任务（${n} 项）` }, 4000)
          }}
          onRollback={doRollback}
          onSaveSettings={async (p) => {
            const next = (await window.api.tasksSettingsSave(p)) as TaskStoreSettings
            setStoreSettings(next)
          }}
        />
      )}

      {/* 撤销 toast */}
      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.undo && (
            <button className="link" onClick={() => void undoRemove()}>
              撤销
            </button>
          )}
        </div>
      )}

      {/* 确认弹窗（不可逆操作） */}
      {confirm && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{confirm.title}</h2>
            <p>{confirm.body}</p>
            <div className="row" style={{ marginBottom: 0 }}>
              <button
                className={confirm.danger ? 'danger' : 'primary'}
                onClick={() => {
                  confirm.onOk()
                  setConfirm(null)
                }}
              >
                {confirm.okText}
              </button>
              <button onClick={() => setConfirm(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {info && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{info.title}</h2>
            <pre className="mono modal-body">{info.body}</pre>
            <div className="row" style={{ marginBottom: 0 }}>
              <button className="primary" onClick={() => setInfo(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
