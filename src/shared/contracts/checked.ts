/**
 * 「已选中」判定的**唯一**知识源。
 *
 * 背景：自定义 UI 库（问卷网 `ws-*`、TDesign `t-*`、Element `el-*`、antd `ant-*`）
 * 把选中态放在**控件容器**的 class 上，原生 input 未必同步。这条知识原先在三个地方
 * 各写了一份（`verify.ts#CHECKED_CLS`、`snapshot.ts#collectInPage` 内联、
 * `tools.ts#stateInPage` 内联）—— 站点换一套类名就要三处同时改，漏一处就会出现
 * 「浏览器里明明已勾选、程序却回读为未选中」从而反复重填、最终判失败。
 *
 * 为什么导出的是**正则源码字符串**而不是 RegExp 对象：`collectInPage` / `stateInPage`
 * 会被 `toString()` 注入浏览器上下文执行，**不能引用本模块的任何标识符**，
 * 唯一的知识传递方式是「可序列化的参数」。故这里给源码，注入函数自己 `new RegExp(...)`。
 */

/**
 * 组件容器「选中」类名。覆盖：问卷网 `is-checked`、TDesign `t-is-checked`、
 * Element/antd `is-selected`/`ant-radio-checked`/`ant-checkbox-checked`。
 *
 * ⚠️ 改动这里会同时影响 verify（回读校验）、snapshot（快照状态）、tools（工具运行时回读）
 * 三处，这正是本文件存在的意义。
 */
export const CHECKED_CLASS_SOURCE =
  '(?:^|[\\s-])(is-checked|is-selected|ant-radio-checked|ant-checkbox-checked|t-is-checked)(?:$|[\\s-])'

/** 取正则对象（需要多次复用时用它；一次性场景直接用 CHECKED_CLASS_SOURCE 即可） */
export function checkedClassRegExp(): RegExp {
  return new RegExp(CHECKED_CLASS_SOURCE)
}

/**
 * 开关（switch）当前是否处于打开态。
 *
 * **自包含**：会被 `toString()` 注入页面执行，不能引用本模块标识符，也不能用对象展开
 * （低 target 编译会引入 helper，源码就不再自包含）。故只接收可序列化的参数。
 *
 * 读取顺序（与原先 fillers/verify 里的两份实现逐字一致）：
 *   1. `aria-checked` 显式给出 true/false → 直接采信
 *   2. 自身或**父级**容器 class 含 `is-checked` / `ant-switch-checked` → 视为打开
 *   3. 原生 input → 读 `checked`
 *
 * 注意第 2 步刻意用 `includes`（子串）而不是正则：某些站点把 `is-checked` 当成
 * 复合类名的一部分（如 `xxxis-checked`），用词边界正则会漏判 —— 这里是行为兼容点。
 */
export function switchStateInPage(node: Element): boolean {
  const n = node as HTMLElement
  const aria = n.getAttribute('aria-checked')
  if (aria === 'true') return true
  if (aria === 'false') return false
  const own = typeof n.className === 'string' ? n.className : ''
  const parent =
    n.parentElement && typeof n.parentElement.className === 'string' ? n.parentElement.className : ''
  const cls = `${own} ${parent}`
  if (cls.includes('is-checked') || cls.includes('ant-switch-checked')) return true
  if (n instanceof HTMLInputElement) return n.checked
  return false
}
