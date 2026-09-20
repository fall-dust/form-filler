/**
 * HTML → 摘要的**唯一**实现（两种摘要，用途不同，刻意并存）。
 *
 * 原先它们分别藏在两个文件里，且各自是私有的：
 *   · `renderer/src/prompt.ts#htmlExcerpt` —— 给模型/人读的正文摘要（命名提示词用）
 *   · `renderer/src/pages.ts#pageSignature` 里的中间产物 —— 当**结构签名**的输入
 *
 * 为什么不当成同一件事合并：一个服务于「读懂页面在说什么」（保留文字、丢标签），
 * 一个服务于「判断还是不是同一页」（丢属性、压长数字、甚至连空白都压掉）。
 * 强行统一会让两边互相牵制。所以这里收的是**位置**：两种摘要都在本文件，
 * 谁要用哪种一目了然，也避免再出现第三份「顺手写的摘要」。
 */

/**
 * 正文摘要：剥掉 script/style/noscript 与全部标签，压掉空白，截断。
 * 用于「让模型知道这是张什么表」—— 所以保留可读文字，不做结构压缩。
 */
export function htmlExcerpt(html: string, max = 1200): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 结构文本：剥 script/style/注释 → **丢掉标签的全部属性** → 去标签 → 压空白 → 长数字压成 `#`。
 *
 * 丢属性是刻意的：腾讯问卷这类站点给每个选项的 `name` 都带一截随机前缀，
 * 属性一动指纹就变；而「是不是同一页」只该由结构与文字决定。
 * 4 位以上的数字（时间戳/随机序号）在每次渲染时都不一样，同样必须忽略。
 *
 * ⚠️ 本函数的输出是**存量指纹的输入**（存进任务的 `sig` 字段）：
 * 任何一处改动都会让所有老任务的「同一页」判定失效，改前务必先想清楚。
 */
export function structureText(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // 只保留标签名，属性一律丢掉（`<input name="a-b-c" class="x">` → `<input>`）
      .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g, '<$1>')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&[a-zA-Z#0-9]{1,8};/g, ' ')
      .replace(/\s+/g, '')
      .replace(/\d{4,}/g, '#')
  )
}
