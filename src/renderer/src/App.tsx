import { useCallback, useEffect, useState } from 'react'
import ConfigPanel from './components/ConfigPanel'
import RunPanel from './components/RunPanel'
import type { FillProgress, FillReport, Question } from './types'
import './App.css'

interface TabState {
  id: string
  name: string
  link: string
  hasLogin: boolean
  headless: boolean
  channel: string
  html: string
  projectName: string
  selectedProject: string
  questions: Question[]
  answers: Record<string, string>
  report: FillReport | null
  progress: FillProgress[]
  running: boolean
  error: string
}

interface ProjectData {
  link: string
  hasLogin: boolean
  headless: boolean
  channel: string
  questions: Question[]
  answers: Record<string, string>
}

let idSeq = 0
function genId(): string {
  idSeq += 1
  return `t${Date.now().toString(36)}${idSeq}`
}

// 任务序号（单调递增，避免关闭标签后序号重复/错乱）
let tabNumber = 1

function newTab(name: string): TabState {
  return {
    id: genId(),
    name,
    link: '',
    hasLogin: false,
    headless: false,
    channel: '',
    html: '',
    projectName: '',
    selectedProject: '',
    questions: [],
    answers: {},
    report: null,
    progress: [],
    running: false,
    error: ''
  }
}

function initAnswers(qs: Question[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const q of qs) m[q.id] = ''
  return m
}

type TabPatch = Partial<TabState> | ((t: TabState) => Partial<TabState>)

export default function App(): JSX.Element {
  const [tabs, setTabs] = useState<TabState[]>(() => [newTab('任务 1')])
  const [activeId, setActiveId] = useState('')
  const [view, setView] = useState<'config' | 'run'>('config')

  const [projects, setProjects] = useState<string[]>([])

  const [loginPrompt, setLoginPrompt] = useState<{ runId: string; url: string } | null>(null)
  const [loginValue, setLoginValue] = useState('')

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0]!

  const updateTab = (id: string, patch: TabPatch): void => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t))
    )
  }
  const updateActive = (patch: TabPatch): void => updateTab(activeTab.id, patch)

  const refreshProjects = useCallback(async () => {
    setProjects((await window.api.projectsList()) as string[])
  }, [])
  useEffect(() => {
    refreshProjects()
  }, [refreshProjects])

  // 进度/登录事件按 runId 路由到对应标签页
  useEffect(() => {
    const offProgress = window.api.onFillProgress((raw) => {
      const p = raw as FillProgress & { runId: string }
      setTabs((prev) =>
        prev.map((t) => (t.id === p.runId ? { ...t, progress: [...t.progress, p] } : t))
      )
    })
    const offLogin = window.api.onFillNeedLogin((runId, url) => {
      setLoginPrompt({ runId, url })
      setLoginValue('')
    })
    return () => {
      offProgress()
      offLogin()
    }
  }, [])

  const handleImport = (qs: Question[]): void => {
    updateActive({ questions: qs, answers: initAnswers(qs), report: null, progress: [] })
  }
  const handleImportAnswers = (ans: Record<string, string>): void => {
    updateActive((t) => ({ answers: { ...t.answers, ...ans } }))
  }

  const handleRun = async (tabId: string): Promise<void> => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    updateTab(tabId, { running: true, progress: [], report: null, error: '' })
    const answerMap: Record<string, string | string[]> = {}
    for (const q of tab.questions) {
      const raw = tab.answers[q.id] ?? ''
      answerMap[q.id] =
        q.type === 'checkbox' ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : raw
    }
    try {
      const rep = (await window.api.fillRun(
        {
          config: {
            link: tab.link,
            hasLogin: tab.hasLogin,
            headless: tab.headless,
            waitTimeout: 10000,
            waitAfterLoad: 1000,
            outputDir: 'output',
            ...(tab.channel ? { channel: tab.channel } : {})
          },
          questions: tab.questions,
          answers: answerMap
        },
        tabId
      )) as FillReport
      updateTab(tabId, { report: rep })
    } catch (e) {
      updateTab(tabId, { error: e instanceof Error ? e.message : String(e) })
    } finally {
      updateTab(tabId, { running: false })
    }
  }

  const handleStop = async (tabId: string): Promise<void> => {
    await window.api.fillStop(tabId)
  }

  const handleLoginSubmit = async (useNew: boolean): Promise<void> => {
    if (!loginPrompt) return
    const next = useNew && loginValue.trim() ? loginValue.trim() : null
    await window.api.fillLoginLink(loginPrompt.runId, next)
    setLoginPrompt(null)
    setLoginValue('')
  }

  const addTab = (): void => {
    tabNumber += 1
    const t = newTab(`任务 ${tabNumber}`)
    setTabs((prev) => [...prev, t])
    setActiveId(t.id)
    setView('config')
  }
  const closeTab = (id: string): void => {
    if (tabs.length <= 1) return
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (id === activeTab.id) setActiveId(next[Math.max(0, idx - 1)].id)
  }
  const clearActive = (): void => {
    updateActive({
      link: '',
      hasLogin: false,
      headless: false,
      channel: '',
      html: '',
      questions: [],
      answers: {},
      report: null,
      progress: [],
      error: ''
    })
  }

  const handleSaveProject = async (): Promise<void> => {
    const name = activeTab.projectName.trim()
    if (!name) return
    const data: ProjectData = {
      link: activeTab.link,
      hasLogin: activeTab.hasLogin,
      headless: activeTab.headless,
      channel: activeTab.channel,
      questions: activeTab.questions,
      answers: activeTab.answers
    }
    await window.api.projectsSave(name, data)
    await refreshProjects()
    updateActive({ selectedProject: name })
  }
  const handleLoadSelected = async (): Promise<void> => {
    const name = activeTab.selectedProject
    if (!name) return
    const data = (await window.api.projectsLoad(name)) as ProjectData | null
    if (!data) return
    updateActive({
      link: data.link ?? '',
      hasLogin: !!data.hasLogin,
      headless: !!data.headless,
      channel: data.channel ?? '',
      questions: data.questions ?? [],
      answers: data.answers ?? {},
      report: null,
      progress: [],
      projectName: name
    })
    setView('config')
  }
  const handleDeleteSelected = async (): Promise<void> => {
    const name = activeTab.selectedProject
    if (!name) return
    await window.api.projectsDelete(name)
    await refreshProjects()
    updateActive({ selectedProject: '' })
  }

  return (
    <div className="app">
      <h1>表单填写器</h1>

      {/* 任务标签页（多任务并发） */}
      <div className="tabbar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`task-tab ${t.id === activeTab.id ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
          >
            <span>{t.name}</span>
            {t.running && <span className="dot" title="运行中" />}
            {tabs.length > 1 && (
              <button
                className="close"
                title="关闭任务"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="add-tab" title="新建任务" onClick={addTab}>
          ＋
        </button>
      </div>

      {/* 项目栏（作用于当前任务） */}
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div style={{ flex: 2 }}>
          <label>项目名</label>
          <input
            type="text"
            value={activeTab.projectName}
            onChange={(e) => updateActive({ projectName: e.target.value })}
            placeholder="给当前配置起个名"
          />
        </div>
        <button className="primary" onClick={handleSaveProject} disabled={!activeTab.projectName.trim()}>
          保存
        </button>
        <div style={{ flex: 2 }}>
          <label>已存项目</label>
          <select value={activeTab.selectedProject} onChange={(e) => updateActive({ selectedProject: e.target.value })}>
            <option value="">— 选择项目 —</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <button onClick={handleLoadSelected} disabled={!activeTab.selectedProject}>
          加载
        </button>
        <button className="danger" onClick={handleDeleteSelected} disabled={!activeTab.selectedProject}>
          删除
        </button>
        <button onClick={clearActive}>清空</button>
      </div>

      <div className="tabs">
        <button
          className={`tab ${view === 'config' ? 'active' : ''}`}
          onClick={() => setView('config')}
        >
          配置
        </button>
        <button
          className={`tab ${view === 'run' ? 'active' : ''}`}
          onClick={() => setView('run')}
        >
          运行
        </button>
      </div>

      {view === 'config' ? (
        <ConfigPanel
          key={activeTab.id}
          link={activeTab.link}
          setLink={(v) => updateActive({ link: v })}
          hasLogin={activeTab.hasLogin}
          setHasLogin={(v) => updateActive({ hasLogin: v })}
          headless={activeTab.headless}
          setHeadless={(v) => updateActive({ headless: v })}
          channel={activeTab.channel}
          setChannel={(v) => updateActive({ channel: v })}
          html={activeTab.html}
          setHtml={(v) => updateActive({ html: v })}
          onImport={handleImport}
          onImportAnswers={handleImportAnswers}
          questions={activeTab.questions}
          answers={activeTab.answers}
          setAnswer={(id, v) => updateActive((t) => ({ answers: { ...t.answers, [id]: v } }))}
        />
      ) : (
        <RunPanel
          key={activeTab.id}
          running={activeTab.running}
          progress={activeTab.progress}
          report={activeTab.report}
          error={activeTab.error}
          onRun={() => handleRun(activeTab.id)}
          onStop={() => handleStop(activeTab.id)}
        />
      )}

      {loginPrompt !== null && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>需要登录</h2>
            <p>请在浏览器中完成登录，然后把登录后的新链接粘贴到下面（留空则沿用当前链接）。</p>
            <p className="mono">当前链接：{loginPrompt.url}</p>
            <div className="row">
              <input
                type="text"
                value={loginValue}
                onChange={(e) => setLoginValue(e.target.value)}
                placeholder="粘贴新链接（可选）"
              />
            </div>
            <div className="row">
              <button className="primary" onClick={() => handleLoginSubmit(true)}>
                确认新链接
              </button>
              <button onClick={() => handleLoginSubmit(false)}>沿用原链接</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
