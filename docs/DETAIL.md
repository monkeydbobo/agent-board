# Agent 看板

把本机所有编码 Agent 的会话收进一张板：DSH、Codex、Claude Code、Cursor、LocalAgent、Grok Bot、Antigravity。

## 它会做什么

- 从每个 Agent 自己的本地会话存储里增量读取（Codex rollout、Claude 项目 JSONL、LocalAgent 会话 JSONL、Cursor composer / chat 正文、Grok 本地对话缓存、Antigravity 应用/工作区元数据，以及 DSH 自己的活 Agent 列表）。
- 把会话归一成一个任务：状态（运行中 / 需要关注 / 空闲 / 已结束）、工作目录、最后活动时间、最近事件。
- 在 DSH 左侧栏放一个「Agent 看板」入口，打开后是四列泳道 + 详情抽屉，数据通过 SSE 实时刷新。
- 给任意 Agent 三个只读工具：`fleet_status`、`fleet_task`、`fleet_refresh`，大总管可以直接问「现在什么情况」。

## 怎么用

1. 安装后在左侧栏点击看板图标。
2. 顶部七个 Agent 卡片显示各自状态；点击可只看某个 Agent。
3. 点击任务卡打开详情：概要、时间线、数据源路径。
4. 「暂停监控」保留当前快照并停止轮询；「恢复监控」继续。
5. 需要让大总管汇总时，在当前会话里直接调用 `fleet_status`。

## 图标

每个 Provider 在卡片和详情里有一个本地默认图标。图标通过 dashboard-icons MCP 检索后固化为 `assets/icons/*.svg`，运行时不联网；来源与商标说明见 `assets/icons/SOURCES.md`。

## 能力边界

- **只读**：本版本不派发任务、不中断 Agent、不合并代码。
- **Cursor**：IDE composer 与 CLI chat 都会解析会话内容（标题、工作区、模型、用户/助手消息、工具调用）。数据库结构变化、文件被占用或读不到时，单个会话会降级为元数据，不会让看板报错。
- **Grok Bot**：解析本地 `sand-client-persistence/*.blob` 对话缓存；没有 CLI，不能派发；更早的云端会话不在本地。
- **Antigravity**：`antigravity-ide` 只是文件打开器，本地没有 transcript，只显示版本、workspace 数量和运行状态。
- **DSH**：直接读取当前 Harness 进程里的活 Agent；历史 DSH 会话的标题与详细事件不在本版本展开。
- 手动状态与隐藏记录保存在 `~/.dsh/agent-board/state.json`；其余数据都是派生缓存。
