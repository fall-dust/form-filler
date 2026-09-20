/**
 * 内容指纹的**唯一**实现（FNV1a32）。
 *
 * 为什么单独成文件：这套算法原先在两个进程里各写了一遍 —— 渲染层 `freshness.ts#fingerprint`
 * 与主进程 `snapshot.ts#fnv1a`。更要紧的是**两遍的输出格式并不相同**：
 *   · freshness：`"1234-1a2b3c4d"`（长度-哈希）
 *   · snapshot ：`"1a2b3c4d"`（纯哈希）
 *
 * 这些字符串是**存量数据的一部分**（任务里的 `questionsFor`/`answersFor`/`fp`/`sig`、
 * 站点记忆里的题目签名都拿它当键）。所以合并时只收敛**算法**，两种格式各自保留 ——
 * 改格式＝让所有老任务的对钩与记忆全部失效，这是绝对不划算的。
 *
 * 纯函数、零依赖，可被任意进程 import（含渲染层）。
 */

/** FNV1a32，返回 8 位十六进制（不含长度前缀） */
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 「长度-FNV1a32」内容指纹：`长度`是碰撞检测的第一道保险（同哈希不同长度一眼可见）。
 * 同步、廉价（几十 KB 的 HTML 也就几毫秒）。
 */
export function contentFingerprint(text: string): string {
  return `${text.length}-${fnv1a32(text)}`
}
