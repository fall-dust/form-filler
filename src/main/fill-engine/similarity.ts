/**
 * 文本相似度（对齐需求文档 §2 的「difflib 模糊匹配」）。
 * 用 LCS 比例近似 difflib.SequenceMatcher.ratio()：2 * LCS / (lenA + lenB)。
 */

/** 最长公共子序列长度（DP，仅对短文本，性能可接受） */
function lcsLength(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return 0
  const dp = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    let prev = 0
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[n]
}

/** 0~1 相似度；完全相等=1，包含关系=0.9，否则 LCS 比例 */
export function similarity(a: string, b: string): number {
  const x = a.trim()
  const y = b.trim()
  if (!x && !y) return 1
  if (!x || !y) return 0
  const A = x.toLowerCase()
  const B = y.toLowerCase()
  if (A === B) return 1
  if (A.includes(B) || B.includes(A)) return 0.9
  return (2 * lcsLength(A, B)) / (A.length + B.length)
}

/** 在候选中返回最佳匹配的索引；低于阈值返回 -1 */
export function bestMatch(
  text: string,
  candidates: string[],
  threshold = 0.6
): number {
  let bestIdx = -1
  let bestScore = -1
  for (let i = 0; i < candidates.length; i++) {
    const s = similarity(text, candidates[i])
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return bestScore >= threshold ? bestIdx : -1
}
