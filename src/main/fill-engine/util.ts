/** 转义 CSS 属性选择器值中的反斜杠与双引号 */
export function cssEscape(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 点「停止」后抛出；调用方据此收尾（关掉迟到的启动结果等），界面显示为「已停止」。
 *
 * 放在 util 而不是 engine：闭环（agent.ts）每一轮之间也要抛它，
 * 而 engine.ts 反过来要 import agent.ts —— 放 engine 里就形成循环依赖了。
 */
export class FillStoppedError extends Error {
  constructor() {
    super('已停止：本次填写未完成')
    this.name = 'FillStoppedError'
  }
}
