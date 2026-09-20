/**
 * 答案归一化的**唯一**实现。
 *
 * 原先两份各写一遍：渲染层 `prompt.ts#parseImportedAnswers`（粘贴 AI 返回的答案 JSON）
 * 与主进程 `tasks/sanitize.ts#sanitizeAnswers`（导入文件的最后一道防线）。
 * 两处规则必须一致 —— 否则「粘贴导入」与「文件导入」会得到不同的答案表，
 * 而这种不一致极难被用户察觉（只在多选/空值上表现不同）。
 *
 * 规则（与两份旧实现逐字等价）：
 *   · 数组 → 逗号连接（多选答案的既有约定，引擎侧按逗号切分）
 *   · null / undefined → 空串
 *   · 其余 → String(v)
 * 输入不是对象（含数组、null、字符串）时返回空表 —— 由调用方决定这是「错」还是「空」。
 */
export function normalizeAnswers(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map((x) => String(x)).join(',')
    else if (v === null || v === undefined) out[k] = ''
    else out[k] = String(v)
  }
  return out
}
