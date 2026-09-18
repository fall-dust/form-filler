# 表单填写器 · Windows 客户端

Electron + React + Playwright 的表单自动填写客户端，核心是「粘贴 HTML → 生成提示词 → 问 AI 拿到题目/答案配置 → 一键填写」。详见 [客户端方案.md](客户端方案.md)（设计）；[需求文档.md](需求文档.md) 为最初 Python CLI 需求，已废弃。

## 使用流程

> 顶部标签页支持**多任务并发**：`＋` 新建任务、`×` 关闭，每个标签独立配置（链接/HTML/题目/答案/项目名各自独立）；多个任务可同时「开始填写」，各自弹出独立浏览器窗口并行跑。「清空」按钮一键重置当前任务。

1. **粘贴 HTML**：在「配置」页把表单 HTML 粘进文本框。
2. **生成题目提示词**：点「生成提示词（元素/题型）」→ 复制 → 拿去问任意 AI。
3. **导入题目**：把 AI 返回的 JSON 贴回「导入题目」，得到题目表格（题干/题型/选项）。
4. **（可选）生成答案提示词**：填「作答目标/情境」→ 点「生成答案提示词」→ 问 AI → 贴回「导入答案」。
5. **填/校答案**：题目表格里逐题填或选答案（也可直接用 AI 导入的答案）。
6. **运行**：切到「运行」页点「开始填写」，浏览器弹出并逐题填写；填完保持打开，你人工核对后手动提交。

## 环境要求

- Node.js ≥ 20（开发环境已用 v26 验证）
- Windows 10/11

## 安装

```bash
npm install
```

> 首次需下载 Electron 二进制（约 100MB）。若只想先跑填写引擎的单测，可 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` 跳过。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（HMR，启动 Electron 窗口） |
| `npm run test` | 运行填写引擎单元 + 端到端测试 |
| `npm run typecheck:node` | 类型检查 main + preload |
| `npm run typecheck:web` | 类型检查 renderer |
| `npm run build` | 构建 main/preload/renderer 到 `out/` |
| `npm run dist` | 打包安装包 + portable exe（electron-builder） |

## 目录结构

```
src/
├── main/                 # Electron 主进程（Node）
│   ├── index.ts          # 窗口创建 + IPC 注册
│   └── fill-engine/      # 填写引擎（Playwright）
│       ├── engine.ts     # 编排：启动/导航/逐题填写/报告
│       ├── locator.ts    # 回退链定位（css/xpath/text）
│       ├── fillers.ts    # 九类题型填写 + 运行时动态读选项
│       ├── similarity.ts # difflib 式文本相似度
│       ├── state.ts      # 断点续填状态
│       ├── report.ts     # 报告 + 失败截图
│       ├── util.ts       # cssEscape 等小工具
│       └── __tests__/    # 单元 + 端到端测试
├── preload/              # contextBridge 白名单 API
└── renderer/             # React UI
    └── src/
        ├── prompt.ts     # 提示词模板（元素/题型 + 答案）+ 导入校验
        └── components/   # PromptGenerator 等
samples/
└── form_sample.html      # 九类题型样例（供填写引擎 e2e 测试）
```

## 当前进度

- ✅ **M0 骨架**：Electron 主/渲染进程 + IPC + 安全基线，`npm run dev` 可启动。
- ⚠️ **M1 智能解析**（已移除）：原 cheerio 启发式解析对真实 HTML 不可靠，改由「提示词生成器 + LLM」产出结构化配置。
- ✅ **M2 填写引擎**：Playwright 回退链定位 + 九类题型填写 + 进度事件 + 失败截图 + 断点续填 + 报告；端到端测试真实填写并回读 DOM 校验通过。
- ✅ **M3 UI 整合**：配置页（粘贴 HTML → 生成提示词 → 导入题目/答案）+ 运行页（进度/报告/停止）+ 登录弹窗。
- ✅ **M4 打包**：electron-builder 产出 NSIS 安装包 + portable 单文件 exe；chromium 随包分发到 `resources/browsers/`。

## 近期增强

- AI 提示词生成器：粘贴 HTML 生成「元素/题型」提示词 → 导入题目；再生成「答案」提示词 → 导入答案。
- 多任务标签页：`＋` 新建 / `×` 关闭，各标签独立配置，可并发运行（各开一个浏览器窗口）。
- 清空当前配置：一键重置当前任务的链接/题目/答案。
- 多套配置：`userData/projects/<名>/project.json` 保存/加载/删除。
- 报告页：失败截图内嵌预览；运行日志持久显示；超长报错可展开/收缩。
- 元素定位健壮：单选/多选多级点选回退（普通 check → force → 点 label → JS 派发 click），兼容 Element UI 等隐藏原生 input。
- 浏览器瘦身：配置 `channel: msedge/chrome` 复用系统浏览器，可省去随包 chromium（约 200MB）。
- 运行失败提示：界面显示红色错误横幅（不再是「无响应」），并把错误写入 `userData/output/error.log`。

## 打包产物

`npm run dist` 产出（在 `dist/`）：

| 文件 | 说明 |
|------|------|
| `表单填写器 Setup 0.1.0.exe` | NSIS 安装包 |
| `表单填写器 0.1.0.exe` | portable 单文件版 |
| `win-unpacked/` | 免安装解压即用的完整目录 |

> 打包时 `scripts/bundle-browsers.mjs` 会把 Playwright 的 chromium 复制进 `browsers/`，随包分发；打包后引擎用 `executablePath` 指向 `resources/browsers/chromium/chrome-win64/chrome.exe`。
>
> 国内网络下打包若下载 electron-builder 二进制超时，加镜像：
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npx electron-builder`

> Playwright 的 driver 子进程需在 asar 外运行，`electron-builder.yml` 已用 `asarUnpack` 把 `playwright`/`playwright-core` 解到 `app.asar.unpacked/`；否则打包后「开始填写」会因 driver 启动失败而无响应。
>
> 运行失败排查：界面会显示红色错误横幅，错误同时写入 `userData/output/error.log`（`%APPDATA%\表单填写器\output\error.log`）。

> 运行 e2e 前需先 `npx playwright install chromium`。
