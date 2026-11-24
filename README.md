# Agent 看板（Agent Fleet Board）

一个 DeepSeek Harness 插件：把本机所有编码 Agent 的会话收进一张看板，并给「大总管」Agent 提供只读的巡检工具。

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

## 目录

```
index.js                  Host 入口（注册服务、路由、工具）
client.js                 Client 入口（main 面板 + 侧栏图标）
src/host/
  board.js                合并、状态覆盖、SSE、持久化
  status.js               统一状态阶梯
  routes.js               snapshot / stream / action + 页面 token
  tools.js                fleet_status / fleet_task / fleet_refresh
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

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent-board/api/snapshot` | 当前快照（任务、Provider、统计、最近事件） |
| GET | `/agent-board/api/stream` | SSE，每次变化推一份快照 |
| POST | `/agent-board/api/action` | `refresh` / `setMonitoring` / `setTaskStatus` / `clearTaskOverride` / `hideTask` |

只读请求要求 `Host` 是回环地址；写请求还要求同源 `Origin` 或页面注入的 `x-agent-board-token`。

## 本版本边界

- 只读：不派发、不中断、不合并。
- Cursor 只做元数据级监控（`store.db` 的存在与时间）。
- Grok Bot / Antigravity 没有本机 CLI，只做进程 + 日志/工作区级观测。
- DSH 只列当前进程里的活 Agent。
