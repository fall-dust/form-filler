import { useState } from 'react'
import StepCard, { type StepStatus } from './StepCard'
import { pageStat } from '../pages'
import type { FillProgress, FillReport, NextButton, Question, TaskPage } from '../types'
import {
  buildPrompt,
  buildAnswerPrompt,
  parseImportedQuestions,
  parseImportedAnswers
} from '../prompt'
import { editorOf } from '../../../shared/contracts/registry'

interface Props {
  html: string
  setHtml: (v: string) => void
  onImport: (questions: Question[]) => void
  onImportAnswers: (answers: Record<string, string>) => void
  questions: Question[]
  answers: Record<string, string>
  setAnswer: (id: string, v: string) => void
  /** 启动浏览器（只打开、不抓取）：题目/答案还没生成时也能先把页面开起来 */
  onOpenBrowser: () => void
  /** 正在启动浏览器 */
  opening: boolean
  /** 启动可用（有目标链接、不在运行/抓取中） */
  canOpen: boolean
  /** 抓取浏览器当前页 HTML（必须先有浏览器窗口；主进程会等页面加载好再抓） */
  onGrabHtml: () => void
  /** 正在抓取中（含等待页面加载） */
  grabbing: boolean
  /** 抓取可用（有目标链接、已有浏览器窗口、不在运行/抓取中） */
  canGrab: boolean
  /** 浏览器窗口是否已打开（影响按钮文案与提示） */
  sessionOpen: boolean
  /**
   * 页面存档（多页问卷一页一条）：每页各自留着自己的 HTML / 题目 / 答案，
   * 切到哪一页就在那一页上工作 —— 翻回旧页直接沿用，不必重新生成题目。
   */
  pages: TaskPage[]
  /** 当前正在编辑 / 填写的那一页 */
  activePageId: string
  onSelectPage: (pageId: string) => void
  onRenamePage: (pageId: string, name: string) => void
  /** 删除一页（只剩一页时等价于清空该页），会先弹确认 */
  onDeletePage: (pageId: string, name: string) => void
  /** 识别到的「下一页」类按钮（只读识别，点它才翻页） */
  nextButtons: NextButton[]
  /** 翻页/识别进行中（'' = 空闲），用于禁用按钮 */
  nextBusy: string
  /** 只翻页（在浏览器里点这个按钮），翻完自动重新识别 */
  onClickNext: (b: NextButton) => void
  /** 翻页并抓取：新页会自动存成新的一页 */
  onNextAndGrab: (b: NextButton) => void
  /** 重新识别当前页面里的翻页按钮 */
  onDetectNext: () => void
  /**
   * 题目是上一版页面生成的（重新抓取或改过步骤 1 的 HTML）。
   * 对钩只代表「当前有效」—— 上游一变，第 2 步（以及下游的答案）就要退回待办。
   */
  questionsStale: boolean
  /** 答案对不上现有题目（题目换了，或答案是对着另一版题目生成的） */
  answersStale: boolean
  /** 「其实还是同一页」：保留现有题目，把收回的对钩复原 */
  onConfirmSameHtml: () => void
  running: boolean
  progress: FillProgress[]
  report: FillReport | null
  error: string
}

type SubmitOutcome = 'confirmed' | 'unconfirmed' | 'none'

/**
 * 提交结局三态：
 * - none：没提交（未开启自动提交 / 有未完成项被跳过 / 干跑）
 * - confirmed：点了提交，且观测到页面响应
 * - unconfirmed：点了提交，但没观测到响应 —— 须人工确认
 *
 * 兼容没有 submitConfirmed 字段的旧报告：那时只能按「有没有 submitNote」反推。
 */
function submitOutcome(r: FillReport | null | undefined): SubmitOutcome {
  if (!r?.submitted) return 'none'
  if (r.submitConfirmed === true) return 'confirmed'
  if (r.submitConfirmed === false) return 'unconfirmed'
  return r.submitNote ? 'unconfirmed' : 'confirmed'
}

/** 超长文本折叠/展开 */
function CollapsibleText({ text, max = 60 }: { text: string; max?: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  if (text.length <= max) return <>{text}</>
  return (
    <span>
      {expanded ? text : `${text.slice(0, max)}…`}
      <button className="link" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '收起' : '展开'}
      </button>
    </span>
  )
}

/** 手动通道：生成提示词 → 复制 → 粘贴 JSON → 导入 */
function ManualChannel({
  prompt,
  stale,
  onGenerate,
  generateLabel,
  copied,
  onCopy,
  importPlaceholder,
  importText,
  setImportText,
  onImport,
  error
}: {
  prompt: string
  /** 提示词生成后，底层数据（HTML/题目）已变更 */
  stale?: boolean
  onGenerate: () => void
  generateLabel: string
  copied: boolean
  onCopy: () => void
  importPlaceholder: string
  importText: string
  setImportText: (v: string) => void
  onImport: () => void
  error: string
}): JSX.Element {
  return (
    <div className="manual-channel">
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <button onClick={onGenerate} style={{ fontSize: 13 }}>
          {generateLabel}
        </button>
        {prompt && (
          <button onClick={onCopy} style={{ fontSize: 13 }}>
            {copied ? '已复制 ✓' : '复制'}
          </button>
        )}
        <span className="hint">复制给任意 AI，把返回的 JSON 贴到下方导入。</span>
      </div>
      {stale && (
        <div className="warn" style={{ marginBottom: 8 }}>
          ⚠ 表单内容已修改，下方提示词是旧版——请点「{generateLabel}」重新生成后再复制。
        </div>
      )}
      {prompt && <textarea readOnly value={prompt} style={{ minHeight: 180 }} />}
      <div style={{ marginTop: 10 }}>
        <label>粘贴 AI 返回的 JSON，导入</label>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={importPlaceholder}
        />
        <div className="row" style={{ marginTop: 8, alignItems: 'center', marginBottom: 0 }}>
          <button className="primary" style={{ fontSize: 13 }} onClick={onImport} disabled={!importText.trim()}>
            导入
          </button>
          {error && <span className="warn">{error}</span>}
        </div>
      </div>
    </div>
  )
}

function AnswerCell({
  q,
  value,
  setAnswer
}: {
  q: Question
  value: string
  setAnswer: (id: string, v: string) => void
}): JSX.Element {
  // 编辑器形态由**能力注册表**派生（原先是一串题型 if；新增题型时界面默认给文本框，
  // 用户只能手打选项文字）。登记表在 shared/contracts/registry.ts。
  const editor = editorOf(q.type)
  const isChoice = editor === 'optionSelect'
  if (isChoice && q.options.length > 0) {
    return (
      <select value={value} onChange={(e) => setAnswer(q.id, e.target.value)}>
        <option value="">（未选）</option>
        {q.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (editor === 'multiText') {
    return (
      <input
        type="text"
        value={value}
        placeholder="多选用逗号分隔"
        onChange={(e) => setAnswer(q.id, e.target.value)}
      />
    )
  }
  const placeholder = isChoice ? '输入选项文字，如：B、@Pointcut' : ''
  return (
    <input type="text" value={value} placeholder={placeholder} onChange={(e) => setAnswer(q.id, e.target.value)} />
  )
}

const Q_IMPORT_PLACEHOLDER =
  '[{"id":"q1","question":"…","type":"radio","options":["A、…"],"selectors":[{"css":"input[name=\\"q1\\"]"}]}]'
const A_IMPORT_PLACEHOLDER = '{"q1":"B、@Pointcut","q5":["自动填表","断点续填"]}'

export default function TaskFlow(props: Props): JSX.Element {
  const {
    html,
    setHtml,
    onImport,
    onImportAnswers,
    questions,
    answers,
    setAnswer,
    onOpenBrowser,
    opening,
    canOpen,
    onGrabHtml,
    grabbing,
    canGrab,
    sessionOpen,
    pages,
    activePageId,
    onSelectPage,
    onRenamePage,
    onDeletePage,
    nextButtons,
    nextBusy,
    onClickNext,
    onNextAndGrab,
    onDetectNext,
    questionsStale,
    answersStale,
    onConfirmSameHtml,
    running,
    progress,
    report,
    error
  } = props

  // ---- 步骤 1：HTML（粘贴后自动折叠成摘要） ----
  const [htmlPinned, setHtmlPinned] = useState(false)
  const htmlOpen = htmlPinned || !html.trim()

  // ---- 页面存档条：改名用（双击进入编辑） ----
  const [pageRenaming, setPageRenaming] = useState('')
  const [pageName, setPageName] = useState('')

  const commitPageName = (pageId: string): void => {
    // Enter 提交后输入框会卸载，blur 可能紧接着再来一次 —— 用「还在改名中」当护栏，避免重复改名
    if (pageRenaming !== pageId) return
    if (pageName.trim()) onRenamePage(pageId, pageName)
    setPageRenaming('')
  }

  // 步骤卡开合：null = 跟随流程自动开合，true/false = 用户手动指定
  const [qCardPinned, setQCardPinned] = useState<boolean | null>(null)
  const [aCardPinned, setACardPinned] = useState<boolean | null>(null)
  const [tCardPinned, setTCardPinned] = useState<boolean | null>(null)

  // ---- 步骤 2/3 手动通道状态 ----
  // 提示词只是「生成那一刻数据的快照」：HTML/题目一变就过期。
  // 记录生成时的数据指纹，过期就在手动通道里提示重新生成。
  const [qPrompt, setQPrompt] = useState('')
  const [qPromptFor, setQPromptFor] = useState('')
  const qPromptStale = !!qPrompt && qPromptFor !== html
  const [qCopied, setQCopied] = useState(false)
  const [qImportText, setQImportText] = useState('')
  const [qError, setQError] = useState('')
  const [qChannelOpen, setQChannelOpen] = useState(false)

  const [goal, setGoal] = useState('')
  const [aPrompt, setAPrompt] = useState('')
  const [aPromptFor, setAPromptFor] = useState('')
  const questionsKey = questions.map((q) => q.id).join(',')
  const aPromptStale = !!aPrompt && aPromptFor !== questionsKey
  const [aCopied, setACopied] = useState(false)
  const [aImportText, setAImportText] = useState('')
  const [aError, setAError] = useState('')
  const [aChannelOpen, setAChannelOpen] = useState(false)

  // ---- 运行结果展示 ----
  const [logOpen, setLogOpen] = useState(false)
  const [shots, setShots] = useState<Record<string, string>>({})
  const [shotsOpen, setShotsOpen] = useState(false)
  const [loadedShots, setLoadedShots] = useState(false)

  const copyText = async (text: string, mark: () => void): Promise<void> => {
    if (await window.api.copyText(text)) {
      mark()
      setTimeout(mark, 1500)
    }
  }

  const doImportQuestions = (): void => {
    const r = parseImportedQuestions(qImportText)
    if (r.error) setQError(r.error)
    else {
      setQError('')
      handleImport(r.questions!)
    }
  }
  const doImportAnswers = (): void => {
    const r = parseImportedAnswers(aImportText)
    if (r.error) setAError(r.error)
    else {
      setAError('')
      handleImportAnswers(r.answers!)
    }
  }

  // 导入题目后：折叠步骤 2，自动展开步骤 3/4，让焦点落到答案流程
  const handleImport = (qs: Question[]): void => {
    onImport(qs)
    setQCardPinned(false)
    setACardPinned(null)
    setTCardPinned(null)
  }
  // 导入答案后：折叠步骤 3，焦点落到校对表格
  const handleImportAnswers = (ans: Record<string, string>): void => {
    onImportAnswers(ans)
    setACardPinned(false)
  }

  // ---- 步骤 4：表格行内状态 ----
  const statusById = new Map(progress.map((p) => [p.id, p]))
  /** 提交结局三态（含旧报告兼容：无 submitConfirmed 字段时按 submitNote 反推） */
  const outcome = submitOutcome(report)
  // 进度事件按顺序到达：最后一题完成后，正在填写的是下一题。
  // 'filling' 是「开始填」事件不算结果，要滤掉再数，否则会数错当前题。
  const completed = progress.filter((p) => p.status !== 'filling')
  const fillingId = running && completed.length < questions.length ? questions[completed.length]?.id : undefined
  const answeredCount = questions.filter((q) => (answers[q.id] ?? '').trim()).length

  /** 一道题的一行 */
  const renderRow = (q: Question): JSX.Element => {
    const p = statusById.get(q.id)
    return (
      <tr key={q.id} className={q.id === fillingId ? 'row-filling' : ''}>
        <td className="mono">{q.id}</td>
        <td>{q.question || '（未识别）'}</td>
        <td>{q.type}</td>
        <td>
          {q.type === 'matrix'
            ? `${q.matrixRows?.join('、')} × ${q.options.join(' / ')}`
            : q.options.join(' / ')}
        </td>
        <td className="answer">
          <AnswerCell q={q} value={answers[q.id] ?? ''} setAnswer={setAnswer} />
        </td>
        <td>
          {p ? (
            p.status === 'filling' ? (
              <span className="badge running">填写中…</span>
            ) : (
              <span className={`badge ${p.status}`}>{p.status}</span>
            )
          ) : q.id === fillingId ? (
            <span className="badge running">填写中…</span>
          ) : (
            <span className="hint">—</span>
          )}
        </td>
      </tr>
    )
  }

  // 失败截图懒加载（展开时读一次）
  const toggleShots = async (): Promise<void> => {
    const next = !shotsOpen
    setShotsOpen(next)
    if (next && !loadedShots && report?.screenshots?.length) {
      const map: Record<string, string> = {}
      for (const p of report.screenshots) {
        const url = (await window.api.readScreenshot(p)) as string | null
        if (url) map[p] = url
      }
      setShots(map)
      setLoadedShots(true)
    }
  }

  // ---- 步骤对钩：代表「当前有效」，而不是「历史上做过」 ----
  // 上游一变（重新抓取 / 改了 HTML / 换了题目），下游的对钩就收回；数据不删，只退回待办。
  const hasAnyAnswer = Object.values(answers).some((v) => v.trim() !== '')
  const allAnswered = questions.length > 0 && answeredCount === questions.length
  const step1Status: StepStatus = html.trim() ? 'done' : 'active'
  const step2Status: StepStatus = questionsStale
    ? 'active'
    : questions.length > 0
      ? 'done'
      : html.trim()
        ? 'active'
        : 'idle'
  const step3Status: StepStatus =
    questions.length === 0 ? 'idle' : hasAnyAnswer && !answersStale ? 'done' : 'active'
  const step4Status: StepStatus =
    questions.length === 0 ? 'idle' : allAnswered && !answersStale ? 'done' : 'active'

  return (
    <div>
      {/*
        上游变了 → 下游对钩收回的提示。
        挂在流程顶部而不是塞进步骤卡里：步骤卡默认是折叠的，对钩没了必须让人一眼看到原因和补救办法。
      */}
      {(questionsStale || answersStale) && (
        <div className="stale-banner">
          <div className="stale-head">
            ⚠ {questionsStale ? '表单 HTML 已更换：题目对不上当前页面' : '题目已更换：答案对不上了'}
          </div>
          <div>
            {questionsStale
              ? `第 2 步的 ${questions.length} 道题（以及第 3/4 步的答案）是上一版页面生成的，已按「待重做」收回对钩。`
              : '第 3 步的答案是对着另一版题目生成的，已收回对钩。'}
            重新生成后对钩就会回来（旧数据没删，也留在「历史版本」里）。
          </div>
          <div className="row">
            {questionsStale && (
              <button
                className="link"
                onClick={onConfirmSameHtml}
                title="确认当前 HTML 与生成题目时是同一页（只是时间戳、随机前缀之类的细微差异）：把对钩复原，不重新生成"
              >
                其实还是同一页（保留现有题目）
              </button>
            )}
          </div>
        </div>
      )}

      {/* 步骤 1：表单 HTML */}
      <StepCard
        step={1}
        title="表单 HTML"
        status={step1Status}
        summary={
          html.trim()
            ? `已抓取 ${html.length.toLocaleString('en-US')} 字符${
                pages.length > 1
                  ? ` · 第 ${Math.max(1, pages.findIndex((p) => p.id === activePageId) + 1)}/${pages.length} 页`
                  : ''
              }`
            : null
        }
        open={htmlOpen}
        onToggle={setHtmlPinned}
      >
        <label>表单 HTML（用于生成提示词）</label>
        {/*
          页面存档条：多页问卷一页一条。抓取时按内容自动落到对应页（routeGrab），
          所以「翻到第 3 页再抓」不会覆盖第 1、2 页，回到旧页也能直接沿用它的题目。
        */}
        {pages.length > 0 && (
          <div className="page-bar">
            <span className="page-bar-label">页面存档</span>
            {pages.map((p, i) => (
              <span
                key={p.id}
                className={`page-chip ${p.id === activePageId ? 'active' : ''}`}
                title={`${p.name}${p.url ? ` · ${p.url}` : ''} · ${pageStat(p)}（双击改名）`}
                onClick={() => onSelectPage(p.id)}
              >
                <span className="page-no">{i + 1}</span>
                {pageRenaming === p.id ? (
                  <input
                    className="page-rename"
                    autoFocus
                    value={pageName}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setPageName(e.target.value)}
                    onBlur={() => commitPageName(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitPageName(p.id)
                      if (e.key === 'Escape') setPageRenaming('')
                    }}
                  />
                ) : (
                  <span
                    className="page-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setPageRenaming(p.id)
                      setPageName(p.name)
                    }}
                  >
                    {p.name}
                  </span>
                )}
                <span className="page-stat">{pageStat(p)}</span>
                <button
                  className="close"
                  title={pages.length <= 1 ? '清空这一页' : '删除这一页'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeletePage(p.id, p.name)
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <span className="hint">
              抓取按内容自动落页：见过的页只更新 HTML，题目与答案继续沿用（不必再花 AI 额度）
            </span>
          </div>
        )}
        <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
          <button
            onClick={onOpenBrowser}
            disabled={!canOpen}
            style={{ fontSize: 13 }}
            title="按左栏「目标链接」打开浏览器（只打开、不抓取）：可以先登录、先翻页、先看清结构"
          >
            {opening ? '启动中…' : sessionOpen ? '浏览器已打开（置前）' : '启动浏览器'}
          </button>
          <button
            onClick={onGrabHtml}
            disabled={!canGrab}
            style={{ fontSize: 13 }}
            title={
              sessionOpen
                ? '把浏览器里当前页面的 HTML 抓回来；会先等页面加载好，并按内容落到对应的页（见过的页不会重复建页）'
                : '先在浏览器里打开目标页面并翻到要采集的那一页，再点它抓取（不会自行打开浏览器）'
            }
          >
            {grabbing ? '抓取中…' : '抓取当前页 HTML'}
          </button>
          <span className="hint">
            先「启动浏览器」（可先登录 / 翻页）→ 等页面显示出来 → 点「抓取当前页 HTML」；也可以手工粘贴。
          </span>
        </div>
        {/*
          识别到的「下一页」按钮：只读识别、显示出来；**点它才翻页**（程序不会自己翻页，
          也不会去点提交/完成类按钮 —— 那些在识别阶段就被排除了）。
        */}
        {sessionOpen && (
          <div className="next-row">
            <span className="page-bar-label">翻页按钮</span>
            {nextBusy === 'detect' ? (
              <span className="hint" style={{ margin: 0 }}>
                识别中…
              </span>
            ) : nextButtons.length === 0 ? (
              <span className="hint" style={{ margin: 0 }}>
                没识别到「下一页」类按钮（可在浏览器里手动翻页，或点「重新识别」）
              </span>
            ) : (
              nextButtons.map((b) => (
                <button
                  key={`${b.frameUrl}|${b.selector}`}
                  className="page-chip next-chip"
                  disabled={nextBusy !== ''}
                  title={
                    b.disabled
                      ? '这个按钮当前是禁用状态（通常是本页还有必答项没填）'
                      : `在浏览器里点它翻页（置信度 ${b.score}${b.frameUrl ? ' · 位于子框架内' : ''}）`
                  }
                  onClick={() => onClickNext(b)}
                >
                  {b.text}
                  {b.disabled ? '（不可用）' : ''}
                </button>
              ))
            )}
            {nextButtons.length > 0 && (
              <button
                className="primary"
                style={{ fontSize: 13 }}
                disabled={nextBusy !== '' || nextButtons[0].disabled}
                title="在浏览器里点这个按钮翻页，等新页面长好后抓取 —— 新页会自动存成新的一页"
                onClick={() => onNextAndGrab(nextButtons[0])}
              >
                {nextBusy === 'next-grab' ? '翻页并抓取中…' : `翻「${nextButtons[0].text}」并抓取为新页`}
              </button>
            )}
            <button
              className="link"
              disabled={nextBusy !== ''}
              title="重新扫一遍当前页面：你自己翻过页、或填完必答项之后，按钮会变"
              onClick={onDetectNext}
            >
              重新识别
            </button>
          </div>
        )}
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          placeholder="<form> … </form>（点上方按钮可自动抓取）"
          style={{ minHeight: 160 }}
        />
      </StepCard>

      {/* 步骤 2：生成题目 */}
      <StepCard
        step={2}
        title="生成题目"
        status={step2Status}
        summary={
          questions.length > 0
            ? questionsStale
              ? `已导入 ${questions.length} 题 · 对应上一版页面，待重新生成`
              : `已导入 ${questions.length} 题`
            : '粘贴 HTML 后生成提示词并导入题目'
        }
        open={qCardPinned ?? (questions.length === 0 || questionsStale)}
        onToggle={setQCardPinned}
      >
        {questionsStale && (
          <div className="stale-note">
            这 {questions.length} 道题是上一版页面生成的，与当前 HTML 对不上 ——
            重新生成题目（对钩会回来），或确认「其实还是同一页」保留它们。
          </div>
        )}
        <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
          <button
            className="primary"
            style={{ fontSize: 13 }}
            onClick={() => setQChannelOpen(!qChannelOpen)}
          >
            生成提示词 {qChannelOpen ? '▴' : '▾'}
          </button>
          <span className="hint">生成提示词 → 复制给任意 AI → 把返回的 JSON 贴回来导入。</span>
        </div>
        {qChannelOpen && (
          <ManualChannel
            prompt={qPrompt}
            stale={qPromptStale}
            onGenerate={() => {
              setQPrompt(buildPrompt(html))
              setQPromptFor(html)
              setQCopied(false)
            }}
            generateLabel="生成提示词（元素/题型）"
            copied={qCopied}
            onCopy={() => void copyText(qPrompt, () => setQCopied(true))}
            importPlaceholder={Q_IMPORT_PLACEHOLDER}
            importText={qImportText}
            setImportText={setQImportText}
            onImport={doImportQuestions}
            error={qError}
          />
        )}
      </StepCard>

      {/* 步骤 3：生成答案 */}
      <StepCard
        step={3}
        title="生成答案"
        status={step3Status}
        summary={
          answersStale
            ? '答案对应的是上一版题目，待重新生成'
            : hasAnyAnswer
              ? '已导入答案（可在下方修改）'
              : '根据题目生成作答内容'
        }
        open={aCardPinned ?? questions.length > 0}
        onToggle={setACardPinned}
      >
        {questions.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            先完成步骤 2，导入题目后才能生成答案。
          </p>
        ) : (
          <>
            {answersStale && (
              <div className="stale-note">
                这组答案对不上现在的题目（题目换过，或答案是对着另一版题目生成的）——
                请重新生成答案，或在第 4 步逐题核对后手动改。
              </div>
            )}
            <label>作答目标 / 情境（可选）</label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="如：这是考试，请给出正确答案；或：作为满意的客户作答"
            />
            <div className="row" style={{ alignItems: 'center', marginBottom: 8, marginTop: 8 }}>
              <button
                className="primary"
                style={{ fontSize: 13 }}
                onClick={() => setAChannelOpen(!aChannelOpen)}
              >
                生成提示词 {aChannelOpen ? '▴' : '▾'}
              </button>
              <span className="hint">将根据 {questions.length} 道题生成。</span>
            </div>
            {aChannelOpen && (
              <ManualChannel
                prompt={aPrompt}
                stale={aPromptStale}
                onGenerate={() => {
                  setAPrompt(buildAnswerPrompt(questions, goal))
                  setAPromptFor(questionsKey)
                  setACopied(false)
                }}
                generateLabel="生成答案提示词"
                copied={aCopied}
                onCopy={() => void copyText(aPrompt, () => setACopied(true))}
                importPlaceholder={A_IMPORT_PLACEHOLDER}
                importText={aImportText}
                setImportText={setAImportText}
                onImport={doImportAnswers}
                error={aError}
              />
            )}
          </>
        )}
      </StepCard>

      {/* 步骤 4：校对题目与答案 + 运行结果 */}
      <StepCard
        step={4}
        title="校对题目与答案"
        status={step4Status}
        summary={
          questions.length > 0
            ? answersStale
              ? `${answeredCount}/${questions.length} 题已作答 · 内容已变更，待重做`
              : `${answeredCount}/${questions.length} 题已作答`
            : null
        }
        open={tCardPinned ?? questions.length > 0}
        onToggle={setTCardPinned}
      >
        {questions.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            导入题目后，在这里逐题核对并修改答案。
          </p>
        ) : (
          <>
            {answersStale && (
              <div className="stale-note">
                题目或页面已变更：下表答案与上次运行结果对应的都是旧页面 ——
                请先回第 2/3 步重新生成，或逐题核对后再运行。
              </div>
            )}
            {error && <div className="error-banner">填写失败：{error}</div>}
            {report && (
              <div className="summary">
                <div className={report.summary.failed > 0 ? 'sum-bad' : ''}>
                  总题数 <b>{report.summary.total}</b>
                </div>
                <div>
                  已填 <b>{report.summary.filled}</b>
                </div>
                <div>
                  未命中 <b>{report.summary.missing}</b>
                </div>
                <div>
                  失败 <b>{report.summary.failed}</b>
                </div>
                {outcome !== 'none' && (
                  <div
                    className={outcome === 'confirmed' ? 'sum-ok' : 'sum-warn'}
                    title={
                      outcome === 'confirmed'
                        ? '已点击提交，且检测到页面响应（submit 事件 / 网络请求 / 页面跳转 / 按钮变禁用）'
                        : '已点击提交，但未检测到任何页面响应，请人工确认是否提交成功'
                    }
                  >
                    {outcome === 'confirmed' ? '已自动提交 ✓' : '已点击提交（结果未确认）'}
                  </div>
                )}
                {report.submitError && <div className="sum-bad">未提交：{report.submitError}</div>}
                {report.submitNote && <div className="sum-warn">{report.submitNote}</div>}
                {report.reusedSession && (
                  <div title="本次在原浏览器窗口的当前页面接着填写，未重新打开、未重新导航">
                    已在原窗口接着填（当前页）
                  </div>
                )}
              </div>
            )}
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>题干</th>
                  <th>题型</th>
                  <th>选项</th>
                  <th>答案</th>
                  <th>填写状态</th>
                </tr>
              </thead>
              <tbody>{questions.map(renderRow)}</tbody>
            </table>
            <p className="hint" style={{ marginTop: 8 }}>
              点底部「开始填写」运行；填完浏览器保持打开，由你人工核对并自行提交。多页表单：用步骤 1
              的「启动浏览器」打开页面（可先登录）→ 填完本页后点识别到的「下一页」按钮（或自己翻页）
              →「抓取当前页 HTML」取本页 → 生成题目/答案 → 再「开始填写」，会在同一窗口接着当前页填。
              每一页各自存档（上方「页面存档」可切换）：翻回旧页直接沿用它的题目，不必重新生成。
            </p>

            {progress.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <button className="link" onClick={() => setLogOpen(!logOpen)}>
                  {logOpen ? '收起运行日志' : `运行日志（${progress.length} 条）`}
                </button>
                {logOpen && (
                  <ul className="run-log">
                    {progress.map((p) => (
                      <li key={`${p.index}-${p.id}`}>
                        <span className={`badge ${p.status}`}>{p.status}</span>{' '}
                        <span className="mono">{p.id}</span>{' '}
                        {p.answer ? <span>{p.answer}</span> : null}{' '}
                        {p.message ? <CollapsibleText text={p.message} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {report?.screenshots && report.screenshots.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button className="link" onClick={() => void toggleShots()}>
                  {shotsOpen ? '收起失败截图' : `失败截图（${report.screenshots.length} 张）`}
                </button>
                {shotsOpen &&
                  report.screenshots.map((s) => (
                    <div key={s} style={{ marginBottom: 12 }}>
                      {shots[s] ? (
                        <img src={shots[s]} alt={s} style={{ maxWidth: '100%', border: '1px solid #d0d7de', borderRadius: 6 }} />
                      ) : (
                        <span className="mono">{s}</span>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </StepCard>
    </div>
  )
}
