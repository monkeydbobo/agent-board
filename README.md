# Agent 看板（Agent Fleet Board）

一个 DeepSeek Harness 插件：把本机所有编码 Agent 的会话收进一张看板，给「大总管」Agent 提供巡检工具，并能在聊天里让多个 Agent 在独立 worktree 里协作。

```
┌──────────────────── DSH Web GUI ────────────────────┐
│  左侧栏「Agent 看板」→ 四列泳道 + 详情抽屉            │
│        ▲ SSE / JSON（同源，页面 token）              │
└────────┼────────────────────────────────────────────┘
         │ /agent-board/api/*
┌────────┼──────────── Host 插件 ──────────────────────┐
│  Board Service（任务/事件/状态/覆盖）                 │
│  Reconciler（3s：采集 → 归一 → 提交 → 广播）          │
│  Adapters：DSH · Codex · Claude · Cursor ·            │
│            LocalAgent · Grok Bot · Antigravity         │
└───────────────────────────────────────────────────────┘
```

每个 Provider 有本地默认图标：通过 dashboard-icons MCP 检索后固化为 `assets/icons/*.svg`，运行时不联网；来源与商标说明见 [`assets/icons/SOURCES.md`](assets/icons/SOURCES.md)。

## 目录

```
index.js                  Host 入口（注册服务、路由、工具）
client.js                 Client 入口（main 面板 + 侧栏图标）
src/host/
  board.js                合并、状态覆盖、SSE、持久化
  status.js               统一状态阶梯
  collab.js               多 Agent 协作（worktree + 实现/评审循环）
  routes.js               snapshot / stream / action + 页面 token
  tools.js                fleet_* 巡检 + collab_* 协作工具
  adapters/               每个 Agent 一个适配器
  util/                   文件尾随、进程探测、脱敏
test/parsers.test.js      node --test
docs/                    设计文档与插件详情页
```

## 开发

```bash
node --check index.js
node --check client.js
node --test test/*.test.js
```

没有构建步骤：`client.js` 直接使用 DSH 的 `window.__ModuleLoader__` 格式。

## 安装

任选其一：

1. **Plugins → Add plugin** 选择本目录（本地目录安装）。
2. 由 DSH 的 `plugin_manager` 执行 `install_bundle`，`target` 指向本目录。

安装后新开一个会话，左侧栏出现「Agent 看板」图标。

## 多 Agent 协作（chat 入口）

在任意 DSH 会话里直接说清楚任务，就能让多个本地 Agent 合作，例如：

- 「用 codex 和 claude 合作：在 `/Users/me/repo` 里加上 `hello()` 和测试，要求 `node --test` 通过。」
- 「让 codex 实现、claude 评审，最多两轮，base 用 `main`。」
- 「用 localagent 实现、claude 评审。」

我会调用 `collab_start`，在 `~/agent-workspaces/<id>` 里创建一个独立 git worktree：

1. `participants[0]`（默认 Codex）按任务实现，并写 `.agent-board/implementation-round-N.md`；
2. `participants[1]`（默认 Claude）只读评审 `git diff`，输出 `{"verdict":"approve|revise", ...}`；
3. `revise` 时把问题回传给实现者再来一轮，直到 approve 或达到 `maxRounds`；
4. 结束写 `.agent-board/result.json`，保留 worktree/分支，不自动合并、不 push。

v1 固定两个参与者：第一个实现、第二个评审（Codex / Claude Code / LocalAgent 任意组合）。看板的「协作」条会实时显示参与者、轮次、当前阶段和日志；详情里可以停止协作。

协作 worktree 从仓库 `HEAD`（或 `--base`）拉出；当前未提交的改动不会被带进去，先 commit 或另开 scratch。

也可以直接用 slash command（不经过模型）：

```text
/collab --agents=codex,claude --rounds=2 <任务>
/collab --agents=localagent,claude --scratch <任务>
```

在 git 仓库的会话里，`/collab` 自动用当前会话目录建 worktree；不在仓库里时退化为临时仓库（`--scratch` 强制）。

工具：`collab_start` / `collab_status` / `collab_list` / `collab_stop`。

边界：这是**监督者 + 共享工作区**的协作，不是 Agent 之间的 A2A 协议直连；默认同时只允许 1 个协作、2 轮，单步 15 分钟超时。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent-board/api/snapshot` | 当前快照（任务、Provider、协作、统计、最近事件） |
| GET | `/agent-board/api/health` | 插件健康信息（`/collab` 是否注册、协作数） |
| GET | `/agent-board/api/stream` | SSE，每次变化推一份快照 |
| GET | `/agent-board/api/icon/<provider>.svg` | Provider 默认图标（本地 SVG） |
| POST | `/agent-board/api/action` | `refresh` / `setMonitoring` / `setTaskStatus` / `clearTaskOverride` / `hideTask` |

只读请求要求 `Host` 是回环地址；写请求还要求同源 `Origin` 或页面注入的 `x-agent-board-token`。

## 本版本边界

- 监控是只读的；协作会启动本地 CLI 进程，但只在独立 worktree 里工作。
- 不自动合并、不 push、不改你的主工作区；协作结束保留分支和 `result.json`。
- 停止协作会终止当前 CLI 进程（SIGTERM，2 秒后 SIGKILL）。
- Cursor 会解析 IDE composer 与 CLI chat 的正文；结构变化或读不到时单个会话降级为元数据。
- Grok Bot 会解析本地对话缓存（`sand-client-persistence/*.blob`），但没有 CLI，不能派发；Grok 更早的云端会话不在本地。
- Antigravity 的 `antigravity-ide` 只是文件打开器，本地没有 transcript，只做应用/工作区元数据观测。
- DSH 只列当前进程里的活 Agent。
