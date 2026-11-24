/**
 * Agent Board — browser half.
 *
 * A self-contained dashboard registered into the DSH shell:
 *   - `main` panel (keyed by the sidebar entry id `agent-board`)
 *   - `sidebar.panellist` icon that opens it
 *
 * Data comes from the Host half over the same-origin HTTP/SSE routes; the
 * module never imports another DSH client package (React is the only require).
 */
window.__ModuleLoader__.load({
  id: '@local/agent-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = React

    const NS = 'agent-board'
    const API = {
      snapshot: '/agent-board/api/snapshot',
      stream: '/agent-board/api/stream',
      action: '/agent-board/api/action',
    }

    const PROVIDERS = ['dsh', 'codex', 'claude', 'cursor', 'grokbot', 'antigravity']
    const LANES = ['attention', 'running', 'idle', 'done']
    const STATUSES = ['running', 'attention', 'idle', 'done']

    const zh = {
      panel: 'Agent 看板',
      title: 'Agent 看板',
      subtitle: '统一监控本机的 DSH、Codex、Claude Code、Cursor、Grok Bot、Antigravity',
      refresh: '刷新',
      refreshing: '刷新中…',
      pause: '暂停监控',
      resume: '恢复监控',
      paused: '监控已暂停，下方是暂停前的快照。',
      connected: '实时',
      offline: '离线',
      connecting: '连接中',
      statsRunning: '运行中',
      statsAttention: '需要关注',
      statsIdle: '空闲',
      statsDone: '已结束',
      statsEvents: '今日事件',
      search: '搜索任务、目录或事件',
      all: '全部',
      laneAttention: '需要关注',
      laneRunning: '运行中',
      laneIdle: '空闲',
      laneDone: '已结束',
      laneEmpty: '暂无任务',
      emptyTitle: '还没有发现任何 Agent 会话',
      emptyHint: '看板会自动读取各 Agent 的本地会话记录，无需手动添加。',
      errorTitle: '读取失败',
      retry: '重试',
      overview: '概要',
      timeline: '时间线',
      workspace: '工作目录',
      session: '会话',
      started: '开始时间',
      lastActivity: '最后活动',
      model: '模型',
      branch: '分支',
      turns: '轮次',
      tokens: 'Token',
      source: '数据源',
      status: '状态',
      markDone: '标记为已结束',
      hide: '隐藏',
      restore: '恢复自动状态',
      noEvents: '还没有观察到事件',
      close: '关闭',
      manual: '手动状态',
      eventsUnit: '个事件',
      tasksUnit: '个任务',
      confirmDone: '把这个任务标记为已结束？看板仍会保留它的历史记录。',
      confirmHide: '隐藏这个任务？当它再次产生活动时会重新出现。',
      actionFailed: '操作失败',
      collabLabel: '协作',
      collabTitle: '进行中的协作',
      collabWaiting: '等待开始',
      collabRound: '轮次',
      collabPhase: '当前阶段',
      collabParticipants: '参与者',
      collabRepo: '仓库',
      collabVerdict: '评审结论',
      collabSummary: '评审摘要',
      collabError: '错误',
      collabPhases: '阶段',
      collabLog: '协作日志',
      collabStop: '停止协作',
      collabConfirmStop: '停止这次协作？当前 Agent 进程会被终止，工作区会保留。',
      'collab.running': '运行中',
      'collab.done': '已完成',
      'collab.failed': '失败',
      'collab.stopped': '已停止',
      'collab.queued': '排队中',
      'provider.dsh': 'DSH',
      'provider.codex': 'Codex',
      'provider.claude': 'Claude Code',
      'provider.cursor': 'Cursor',
      'provider.grokbot': 'Grok Bot',
      'provider.antigravity': 'Antigravity',
      'status.running': '运行中',
      'status.attention': '需要关注',
      'status.idle': '空闲',
      'status.done': '已结束',
      'status.offline': '离线',
      'reason.active-turn': '正在执行',
      'reason.recent-activity': '刚刚有活动',
      'reason.stalled': '长时间无活动',
      'reason.error': '出现错误',
      'reason.quiet': '安静中',
      'reason.ended': '已结束',
      'reason.idle': '空闲',
      'reason.manual': '手动设置',
      'kind.run.started': '开始',
      'kind.run.turn': '输入',
      'kind.run.tool': '工具',
      'kind.run.message': '输出',
      'kind.run.idle': '空闲',
      'kind.run.error': '错误',
      'kind.run.heartbeat': '心跳',
      'kind.session.meta': '元数据',
      'time.now': '刚刚',
    }

    const en = {
      panel: 'Agent board',
      title: 'Agent board',
      subtitle: 'One view of DSH, Codex, Claude Code, Cursor, Grok Bot, and Antigravity on this Mac',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      pause: 'Pause',
      resume: 'Resume',
      paused: 'Monitoring is paused; this snapshot predates the pause.',
      connected: 'Live',
      offline: 'Offline',
      connecting: 'Connecting',
      statsRunning: 'Running',
      statsAttention: 'Needs attention',
      statsIdle: 'Idle',
      statsDone: 'Finished',
      statsEvents: 'Events today',
      search: 'Search tasks, folders, or events',
      all: 'All',
      laneAttention: 'Needs attention',
      laneRunning: 'Running',
      laneIdle: 'Idle',
      laneDone: 'Finished',
      laneEmpty: 'No tasks',
      emptyTitle: 'No agent sessions discovered yet',
      emptyHint: 'The board reads each agent’s local session store automatically; nothing to add by hand.',
      errorTitle: 'Could not read the board',
      retry: 'Retry',
      overview: 'Overview',
      timeline: 'Timeline',
      workspace: 'Workspace',
      session: 'Session',
      started: 'Started',
      lastActivity: 'Last activity',
      model: 'Model',
      branch: 'Branch',
      turns: 'Turns',
      tokens: 'Tokens',
      source: 'Source',
      status: 'Status',
      markDone: 'Mark finished',
      hide: 'Hide',
      restore: 'Restore automatic status',
      noEvents: 'No events observed yet',
      close: 'Close',
      manual: 'Manual status',
      eventsUnit: 'events',
      tasksUnit: 'tasks',
      confirmDone: 'Mark this task as finished? History stays on the board.',
      confirmHide: 'Hide this task? It reappears when new activity arrives.',
      actionFailed: 'Action failed',
      collabLabel: 'Collab',
      collabTitle: 'Collaborations',
      collabWaiting: 'waiting to start',
      collabRound: 'Round',
      collabPhase: 'Phase',
      collabParticipants: 'Participants',
      collabRepo: 'Repository',
      collabVerdict: 'Verdict',
      collabSummary: 'Review summary',
      collabError: 'Error',
      collabPhases: 'Phases',
      collabLog: 'Collaboration log',
      collabStop: 'Stop collaboration',
      collabConfirmStop: 'Stop this collaboration? The current agent process is terminated; the worktree is kept.',
      'collab.running': 'running',
      'collab.done': 'done',
      'collab.failed': 'failed',
      'collab.stopped': 'stopped',
      'collab.queued': 'queued',
      'provider.dsh': 'DSH',
      'provider.codex': 'Codex',
      'provider.claude': 'Claude Code',
      'provider.cursor': 'Cursor',
      'provider.grokbot': 'Grok Bot',
      'provider.antigravity': 'Antigravity',
      'status.running': 'Running',
      'status.attention': 'Attention',
      'status.idle': 'Idle',
      'status.done': 'Finished',
      'status.offline': 'Offline',
      'reason.active-turn': 'Working',
      'reason.recent-activity': 'Recent activity',
      'reason.stalled': 'No activity for a while',
      'reason.error': 'Error',
      'reason.quiet': 'Quiet',
      'reason.ended': 'Ended',
      'reason.idle': 'Idle',
      'reason.manual': 'Manual',
      'kind.run.started': 'Start',
      'kind.run.turn': 'Prompt',
      'kind.run.tool': 'Tool',
      'kind.run.message': 'Output',
      'kind.run.idle': 'Idle',
      'kind.run.error': 'Error',
      'kind.run.heartbeat': 'Heartbeat',
      'kind.session.meta': 'Metadata',
      'time.now': 'now',
    }

    const CSS = `
.ab-root{--ab-running:var(--dsw-alias-brand-primary);--ab-attention:var(--dsw-alias-state-warn-primary);--ab-idle:var(--dsw-alias-state-idle-primary);--ab-done:var(--dsw-alias-state-success-primary);--ab-error:var(--dsw-alias-state-error-primary);position:relative;display:flex;flex-direction:column;height:100%;min-height:480px;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.45 inherit}
.ab-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ab-brand{display:flex;align-items:center;gap:10px;min-width:0}
.ab-brand h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.ab-brand p{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ab-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.ab-conn{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ab-conn i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:inline-block}
.ab-conn.is-on i{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ab-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ab-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ab-btn:disabled{opacity:.55;cursor:default}
.ab-btn.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.ab-body{display:flex;flex-direction:column;min-height:0;flex:1}
.ab-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:12px 18px 0}
.ab-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;min-width:0}
.ab-stat b{display:block;font-size:18px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.ab-stat span{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ab-stat[data-tone=running] b{color:var(--ab-running)}
.ab-stat[data-tone=attention] b{color:var(--ab-attention)}
.ab-stat[data-tone=done] b{color:var(--ab-done)}
.ab-providers{display:flex;gap:8px;overflow-x:auto;padding:10px 18px 0;scrollbar-width:thin}
.ab-provider{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.ab-provider:hover{border-color:var(--dsw-alias-border-l2)}
.ab-provider[data-active=true]{border-color:var(--ab-running);background:color-mix(in srgb,var(--ab-running) 10%,var(--dsw-alias-bg-layer-1))}
.ab-provider-name{font-weight:500}
.ab-provider-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ab-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto;background:var(--ab-idle)}
.ab-dot[data-status=running]{background:var(--ab-running);box-shadow:0 0 0 3px color-mix(in srgb,var(--ab-running) 16%,transparent)}
.ab-dot[data-status=attention]{background:var(--ab-attention)}
.ab-dot[data-status=done]{background:var(--ab-done)}
.ab-dot[data-status=offline]{background:var(--dsw-alias-border-l2)}
.ab-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;border-radius:5px;background:#fff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.10);overflow:hidden;padding:2px;box-sizing:border-box}
.ab-icon img{width:100%;height:100%;display:block;object-fit:contain}
.ab-icon[data-missing="1"]{background:var(--dsw-alias-bg-layer-2);padding:0}
.ab-icon[data-missing="1"]::after{content:attr(data-letter);font-size:9px;font-weight:700;color:var(--dsw-alias-label-secondary)}
.ab-toolbar{display:flex;align-items:center;gap:8px;padding:10px 18px;flex-wrap:wrap}
.ab-search{flex:1 1 220px;min-width:160px;max-width:380px}
.ab-search input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 9px;font:inherit;font-size:12px;outline:none}
.ab-search input:focus{border-color:var(--ab-running)}
.ab-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.ab-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 9px;cursor:pointer}
.ab-seg button[data-active=true]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-weight:500}
.ab-banner{margin:0 18px 10px;border:1px solid var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);border-radius:6px;padding:7px 10px;font-size:12px}
.ab-error{margin:0 18px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;padding:8px 10px;display:flex;gap:10px;align-items:center;font-size:12px}
.ab-error button{margin-left:auto}
.ab-lanes{flex:1;min-height:0;display:grid;grid-template-columns:repeat(4,minmax(230px,1fr));gap:10px;padding:0 18px 16px;overflow-x:auto;overflow-y:hidden}
.ab-lane{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.ab-lane-head{display:flex;align-items:center;gap:7px;padding:9px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:600;flex:0 0 auto}
.ab-lane-head .ab-count{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ab-lane-body{display:flex;flex-direction:column;gap:7px;padding:9px;overflow-y:auto;min-height:0;scrollbar-width:thin}
.ab-lane-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px;padding:10px 2px}
.ab-card{display:flex;flex-direction:column;gap:5px;text-align:left;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:8px;padding:9px 10px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer}
.ab-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ab-card:focus-visible{outline:2px solid var(--ab-running);outline-offset:1px}
.ab-card-top{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ab-card-top .ab-prov{color:var(--dsw-alias-label-primary);font-weight:500}
.ab-card-top .ab-ago{margin-left:auto;font-variant-numeric:tabular-nums}
.ab-card-title{font-size:12.5px;font-weight:550;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.ab-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ab-card-event{font-size:11px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.ab-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-secondary);padding:30px;text-align:center}
.ab-empty b{color:var(--dsw-alias-label-primary);font-size:13px}
.ab-drawer{position:absolute;inset:0;z-index:30;display:flex;justify-content:flex-end}
.ab-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.28)}
.ab-panel{position:relative;width:min(540px,94%);height:100%;background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;box-shadow:-12px 0 30px rgba(0,0,0,.18)}
.ab-panel-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ab-panel-head h2{margin:0;font-size:14px;font-weight:600;line-height:1.35;word-break:break-word}
.ab-panel-head .ab-meta{display:flex;align-items:center;gap:8px;margin-top:5px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.ab-x{margin-left:auto;flex:0 0 auto;appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:26px;height:26px;cursor:pointer;line-height:1}
.ab-x:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ab-panel-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:16px}
.ab-section-title{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0 0 6px}
.ab-grid{display:grid;grid-template-columns:96px minmax(0,1fr);gap:4px 10px;font-size:12px}
.ab-grid dt{color:var(--dsw-alias-label-secondary)}
.ab-grid dd{margin:0;word-break:break-all;font-variant-numeric:tabular-nums}
.ab-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.ab-timeline li{display:grid;grid-template-columns:40px 60px minmax(0,1fr);gap:7px;font-size:11.5px;align-items:baseline}
.ab-timeline time{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ab-kind{color:var(--dsw-alias-label-secondary);font-size:10.5px;text-transform:uppercase;letter-spacing:.03em}
.ab-timeline p{margin:0;word-break:break-word}
.ab-timeline li[data-sev=error] p{color:var(--ab-error)}
.ab-timeline li[data-sev=warn] p{color:var(--ab-attention)}
.ab-panel-foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.ab-panel-foot .ab-btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent)}
.ab-note{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}
.ab-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ab-collabs{margin:10px 18px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;flex:0 0 auto}
.ab-collabs-head{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:600}
.ab-collabs-head .ab-count{margin-left:auto;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ab-collab-list{display:flex;gap:8px;overflow-x:auto;padding:9px;scrollbar-width:thin}
.ab-collab{display:flex;flex-direction:column;gap:4px;flex:0 0 280px;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:8px;padding:8px 10px;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.ab-collab:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.ab-collab:focus-visible{outline:2px solid var(--ab-running);outline-offset:1px}
.ab-collab-phases{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.ab-collab-phases li{display:grid;grid-template-columns:64px 92px minmax(0,1fr);gap:7px;font-size:11.5px;align-items:baseline}
.ab-collab-phases .ab-phase-actor{color:var(--dsw-alias-label-secondary);font-size:10.5px;text-transform:uppercase;letter-spacing:.03em}
.ab-collab-phases p{margin:0;word-break:break-word}
.ab-collab-phases li[data-status=failed] p{color:var(--ab-error)}
@media (max-width:900px){
  .ab-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ab-lanes{grid-auto-flow:column;grid-auto-columns:260px;grid-template-columns:none;padding-bottom:12px}
  .ab-panel{width:100%}
  .ab-brand p{display:none}
}
`

    const styles = {
      root: { minWidth: 0 },
    }

    function token() {
      return (typeof window !== 'undefined' && window.__AGENT_BOARD_TOKEN__) || ''
    }

    async function postAction(action, payload) {
      const headers = { 'content-type': 'application/json' }
      const value = token()
      if (value) headers['x-agent-board-token'] = value
      const response = await fetch(API.action, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, payload }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      return body
    }

    function timeAgo(value, t) {
      const ms = Date.parse(value ?? '')
      if (!Number.isFinite(ms)) return '—'
      const delta = Math.max(0, Date.now() - ms)
      if (delta < 60_000) return t('time.now')
      if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m`
      if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`
      return `${Math.round(delta / 86_400_000)}d`
    }

    function basename(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split('/').filter(Boolean)
      return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/')
    }

    function providerLabel(t, id) {
      const key = `provider.${id}`
      const value = t(key)
      return value === key ? id : value
    }

    function useBoard() {
      const [state, setState] = useState({ data: null, loading: true, error: '', connected: false, pending: false })
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        setState((prev) => ({ ...prev, pending: true }))
        try {
          const response = await fetch(API.snapshot, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (!alive.current) return
          setState((prev) => ({ ...prev, data, loading: false, error: '', pending: false }))
        } catch (error) {
          if (!alive.current) return
          setState((prev) => ({ ...prev, loading: false, pending: false, error: String(error?.message ?? error) }))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        let source
        try {
          source = new EventSource(API.stream)
          source.onopen = () => {
            if (alive.current) setState((prev) => ({ ...prev, connected: true }))
          }
          source.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data)
              if (message?.type !== 'snapshot' || !alive.current) return
              setState((prev) => ({ ...prev, data: message.data, loading: false, connected: true, error: '' }))
            } catch {
              /* ignore malformed frame */
            }
          }
          source.onerror = () => {
            if (alive.current) setState((prev) => ({ ...prev, connected: false }))
          }
        } catch {
          source = undefined
        }
        const poll = setInterval(() => {
          if (!source || source.readyState !== 1) refresh()
        }, 5000)
        return () => {
          alive.current = false
          clearInterval(poll)
          try {
            source?.close()
          } catch {
            /* already closed */
          }
        }
      }, [refresh])

      return { ...state, refresh }
    }

    function StatusDot(props) {
      return h('i', { className: 'ab-dot', 'data-status': props.status ?? 'offline', 'aria-hidden': true })
    }

    function ProviderIcon(props) {
      const id = String(props?.id ?? '')
      const size = props?.size ?? 16
      const letter = (id.charAt(0) || '?').toUpperCase()
      return h('span', {
        className: 'ab-icon',
        style: { width: `${size}px`, height: `${size}px` },
        'data-letter': letter,
        'aria-hidden': true,
      }, h('img', {
        src: `/agent-board/api/icon/${id}.svg`,
        alt: '',
        draggable: false,
        loading: 'lazy',
        onError: (event) => {
          const image = event.currentTarget
          const parent = image.parentElement
          if (parent) parent.dataset.missing = '1'
          image.style.display = 'none'
        },
      }))
    }

    function BoardIcon(props) {
      const size = props?.size ?? 20
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 17.5, cy: 17.5, r: 3.2, fill: 'currentColor', opacity: 0.85 }),
      )
    }

    function Stat(props) {
      return h('div', { className: 'ab-stat', 'data-tone': props.tone ?? '' },
        h('b', null, String(props.value)),
        h('span', null, props.label),
      )
    }

    function TaskCard(props) {
      const { task, t } = props
      const last = task.events && task.events.length > 0 ? task.events[task.events.length - 1] : null
      return h('button', {
        type: 'button',
        className: 'ab-card',
        onClick: () => props.onOpen(task.id),
        title: task.title,
      },
        h('span', { className: 'ab-card-top' },
          h(StatusDot, { status: task.status }),
          h(ProviderIcon, { id: task.provider, size: 14 }),
          h('span', { className: 'ab-prov' }, providerLabel(t, task.provider)),
          h('span', { className: 'ab-ago' }, timeAgo(task.lastActivity, t)),
        ),
        h('span', { className: 'ab-card-title' }, task.title),
        task.workspace ? h('span', { className: 'ab-card-sub', title: task.workspace }, basename(task.workspace)) : null,
        h('span', { className: 'ab-card-event' }, last ? last.summary : t('noEvents')),
      )
    }

    function collabDot(status) {
      if (status === 'running') return 'running'
      if (status === 'failed') return 'attention'
      if (status === 'done') return 'done'
      return 'idle'
    }

    function CollabCard(props) {
      const { run, t, onOpen } = props
      const last = run.log && run.log.length > 0 ? run.log[run.log.length - 1] : null
      return h('button', {
        type: 'button',
        className: 'ab-collab',
        onClick: () => onOpen(run.id),
        title: run.title,
      },
        h('span', { className: 'ab-card-top' },
          h(StatusDot, { status: collabDot(run.status) }),
          h('span', { className: 'ab-prov' }, t('collabLabel')),
          h('span', { className: 'ab-ago' }, timeAgo(run.updatedAt, t)),
        ),
        h('span', { className: 'ab-card-title' }, run.title),
        h('span', { className: 'ab-card-sub' }, `${run.participants.join(' → ')} · ${t('collabRound')} ${run.round}/${run.maxRounds}`),
        h('span', { className: 'ab-card-event' }, last ? last.text : t('collabWaiting')),
      )
    }

    function CollabDrawer(props) {
      const { run, t, onClose, onAction, busy, error } = props
      const dialogRef = useRef(null)
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      useEffect(() => {
        dialogRef.current?.focus?.()
      }, [run.id])

      const rows = [
        [t('status'), t(`collab.${run.status}`) === `collab.${run.status}` ? run.status : t(`collab.${run.status}`)],
        [t('collabParticipants'), run.participants.join(' → ')],
        [t('collabRound'), `${run.round}/${run.maxRounds}`],
        [t('collabPhase'), run.currentPhase || '—'],
        [t('workspace'), run.workspace || '—'],
        [t('branch'), run.branch || '—'],
      ]
      if (run.repo) rows.push([t('collabRepo'), run.repo])
      if (run.verdict) rows.push([t('collabVerdict'), run.verdict])
      if (run.review?.summary) rows.push([t('collabSummary'), run.review.summary])
      if (run.error) rows.push([t('collabError'), run.error])

      return h('div', { className: 'ab-drawer' },
        h('div', { className: 'ab-backdrop', onClick: onClose, 'aria-hidden': true }),
        h('aside', {
          className: 'ab-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': run.title,
          tabIndex: -1,
          ref: dialogRef,
        },
          h('div', { className: 'ab-panel-head' },
            h('div', { style: { minWidth: 0 } },
              h('h2', null, run.title),
              h('div', { className: 'ab-meta' },
                h(StatusDot, { status: collabDot(run.status) }),
                h('span', null, t('collabLabel')),
                h('span', null, timeAgo(run.updatedAt, t)),
              ),
            ),
            h('button', { type: 'button', className: 'ab-x', onClick: onClose, 'aria-label': t('close') }, '✕'),
          ),
          h('div', { className: 'ab-panel-body' },
            error ? h('div', { className: 'ab-banner' }, `${t('actionFailed')}: ${error}`) : null,
            h('section', null,
              h('h3', { className: 'ab-section-title' }, t('overview')),
              h('dl', { className: 'ab-grid' },
                rows.map(([key, value], index) => [
                  h('dt', { key: `ck${index}` }, key),
                  h('dd', { key: `cv${index}`, title: String(value) }, String(value)),
                ]),
              ),
            ),
            h('section', null,
              h('h3', { className: 'ab-section-title' }, `${t('collabPhases')} · ${run.phases.length}`),
              run.phases.length === 0
                ? h('p', { className: 'ab-note' }, t('collabWaiting'))
                : h('ul', { className: 'ab-collab-phases' },
                    run.phases.map((phase) => h('li', { key: String(phase.index), 'data-status': phase.status },
                      h('time', null, timeAgo(phase.startedAt, t)),
                      h('span', { className: 'ab-phase-actor' }, `${phase.role} · ${phase.actor}`),
                      h('p', null, phase.summary || '—'),
                    )),
                  ),
            ),
            h('section', null,
              h('h3', { className: 'ab-section-title' }, t('collabLog')),
              run.log.length === 0
                ? h('p', { className: 'ab-note' }, t('collabWaiting'))
                : h('ul', { className: 'ab-timeline' },
                    run.log.slice().reverse().map((entry, index) => h('li', {
                      key: `${entry.at ?? ''}-${index}`,
                      'data-sev': entry.severity ?? 'info',
                    },
                      h('time', null, timeAgo(entry.at, t)),
                      h('span', { className: 'ab-kind' }, entry.actor),
                      h('p', null, entry.text),
                    )),
                  ),
            ),
          ),
          h('div', { className: 'ab-panel-foot' },
            run.status === 'running' || run.status === 'queued'
              ? h('button', {
                  type: 'button',
                  className: 'ab-btn is-danger',
                  disabled: busy,
                  onClick: () => {
                    if (window.confirm(t('collabConfirmStop'))) onAction('stopCollab', { id: run.id })
                  },
                }, t('collabStop'))
              : null,
            h('button', { type: 'button', className: 'ab-btn', onClick: onClose }, t('close')),
          ),
        ),
      )
    }

    function Drawer(props) {
      const { task, t, onClose, onAction, busy, error } = props
      const dialogRef = useRef(null)
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      useEffect(() => {
        dialogRef.current?.focus?.()
      }, [task.id])

      const meta = task.meta ?? {}
      const rows = [
        [t('status'), `${t(`status.${task.status}`)} · ${t(`reason.${task.statusReason}`) === `reason.${task.statusReason}` ? task.statusReason : t(`reason.${task.statusReason}`)}`],
        [t('workspace'), task.workspace || '—'],
        [t('session'), task.sessionRef || '—'],
        [t('started'), task.startedAt ? new Date(task.startedAt).toLocaleString() : '—'],
        [t('lastActivity'), task.lastActivity ? new Date(task.lastActivity).toLocaleString() : '—'],
      ]
      if (meta.model) rows.push([t('model'), String(meta.model)])
      if (meta.branch) rows.push([t('branch'), String(meta.branch)])
      if (meta.turns !== undefined) rows.push([t('turns'), String(meta.turns)])
      if (meta.tokens) rows.push([t('tokens'), `${meta.tokens.input ?? 0} / ${meta.tokens.output ?? 0}`])
      const source = meta.file || meta.db || meta.log || meta.dir || meta.storage
      if (source) rows.push([t('source'), String(source)])

      return h('div', { className: 'ab-drawer' },
        h('div', { className: 'ab-backdrop', onClick: onClose, 'aria-hidden': true }),
        h('aside', {
          className: 'ab-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': task.title,
          tabIndex: -1,
          ref: dialogRef,
        },
          h('div', { className: 'ab-panel-head' },
            h('div', { style: { minWidth: 0 } },
              h('h2', null, task.title),
              h('div', { className: 'ab-meta' },
                h(StatusDot, { status: task.status }),
                h(ProviderIcon, { id: task.provider, size: 15 }),
                h('span', null, providerLabel(t, task.provider)),
                h('span', null, timeAgo(task.lastActivity, t)),
                task.manual ? h('span', null, `· ${t('manual')}`) : null,
              ),
            ),
            h('button', { type: 'button', className: 'ab-x', onClick: onClose, 'aria-label': t('close') }, '✕'),
          ),
          h('div', { className: 'ab-panel-body' },
            error ? h('div', { className: 'ab-banner' }, `${t('actionFailed')}: ${error}`) : null,
            h('section', null,
              h('h3', { className: 'ab-section-title' }, t('overview')),
              h('dl', { className: 'ab-grid' },
                rows.map(([key, value], index) => [
                  h('dt', { key: `k${index}` }, key),
                  h('dd', { key: `v${index}`, title: String(value) }, String(value)),
                ]),
              ),
            ),
            h('section', null,
              h('h3', { className: 'ab-section-title' }, `${t('timeline')} · ${task.events.length} ${t('eventsUnit')}`),
              task.events.length === 0
                ? h('p', { className: 'ab-note' }, t('noEvents'))
                : h('ul', { className: 'ab-timeline' },
                    task.events.slice().reverse().map((event, index) => h('li', {
                      key: `${event.at ?? ''}-${index}`,
                      'data-sev': event.severity ?? 'info',
                    },
                      h('time', null, timeAgo(event.at, t)),
                      h('span', { className: 'ab-kind' }, t(`kind.${event.kind}`) === `kind.${event.kind}` ? event.kind : t(`kind.${event.kind}`)),
                      h('p', null, event.summary),
                    )),
                  ),
            ),
          ),
          h('div', { className: 'ab-panel-foot' },
            task.manual
              ? h('button', {
                  type: 'button',
                  className: 'ab-btn',
                  disabled: busy,
                  onClick: () => onAction('clearTaskOverride', { taskId: task.id }),
                }, t('restore'))
              : h('button', {
                  type: 'button',
                  className: 'ab-btn',
                  disabled: busy,
                  onClick: () => {
                    if (window.confirm(t('confirmDone'))) onAction('setTaskStatus', { taskId: task.id, status: 'done' })
                  },
                }, t('markDone')),
            h('button', {
              type: 'button',
              className: 'ab-btn is-danger',
              disabled: busy,
              onClick: () => {
                if (window.confirm(t('confirmHide'))) onAction('hideTask', { taskId: task.id })
              },
            }, t('hide')),
          ),
        ),
      )
    }

    function BoardPage() {
      const ctx = BoardPage.ctx
      const t = ctx.locale.bind(NS)
      const [localeRevision, setLocaleRevision] = useState(0)
      useEffect(() => ctx.locale.subscribe(() => setLocaleRevision((value) => value + 1)), [ctx])
      void localeRevision

      const { data, loading, error, connected, pending, refresh } = useBoard()
      const [query, setQuery] = useState('')
      const [statusFilter, setStatusFilter] = useState('all')
      const [providerFilter, setProviderFilter] = useState('all')
      const [selectedId, setSelectedId] = useState(null)
      const [selectedCollabId, setSelectedCollabId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState('')

      const onAction = useCallback(async (action, payload) => {
        setBusy(true)
        setActionError('')
        try {
          await postAction(action, payload)
          await refresh()
          if (action === 'hideTask') setSelectedId(null)
        } catch (actionFailure) {
          setActionError(String(actionFailure?.message ?? actionFailure))
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const tasks = data?.tasks ?? []
      const normalizedQuery = query.trim().toLowerCase()
      const filtered = useMemo(() => tasks.filter((task) => {
        if (statusFilter !== 'all' && task.status !== statusFilter) return false
        if (providerFilter !== 'all' && task.provider !== providerFilter) return false
        if (normalizedQuery === '') return true
        const last = task.events[task.events.length - 1]?.summary ?? ''
        return `${task.title} ${task.workspace} ${last} ${task.provider}`.toLowerCase().includes(normalizedQuery)
      }), [tasks, statusFilter, providerFilter, normalizedQuery])

      const lanes = useMemo(() => {
        const map = { attention: [], running: [], idle: [], done: [] }
        for (const task of filtered) {
          if (map[task.status]) map[task.status].push(task)
        }
        return map
      }, [filtered])

      const selected = selectedId === null ? null : tasks.find((task) => task.id === selectedId) ?? null
      const collabs = data?.collabs ?? []
      const selectedCollab = selectedCollabId === null ? null : collabs.find((run) => run.id === selectedCollabId) ?? null
      const openTask = (id) => {
        setSelectedId(id)
        setSelectedCollabId(null)
      }
      const openCollab = (id) => {
        setSelectedCollabId(id)
        setSelectedId(null)
      }
      const stats = data?.stats ?? { total: 0, running: 0, attention: 0, idle: 0, done: 0, eventsToday: 0 }

      const toggleMonitoring = async () => {
        if (!data) return
        await onAction('setMonitoring', { enabled: !data.monitoring })
      }

      return h('div', { className: 'ab-root', style: styles.root },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('header', { className: 'ab-header' },
          h('div', { className: 'ab-brand' },
            h(BoardIcon, { size: 22 }),
            h('div', { style: { minWidth: 0 } },
              h('h1', null, t('title')),
              h('p', null, t('subtitle')),
            ),
          ),
          h('div', { className: 'ab-head-actions' },
            h('span', { className: `ab-conn${connected ? ' is-on' : ''}` }, h('i'), connected ? t('connected') : t('offline')),
            h('button', { type: 'button', className: 'ab-btn', onClick: refresh, disabled: pending }, pending ? t('refreshing') : t('refresh')),
            h('button', {
              type: 'button',
              className: `ab-btn${data && !data.monitoring ? ' is-warn' : ''}`,
              onClick: toggleMonitoring,
              disabled: busy || !data,
            }, data && !data.monitoring ? t('resume') : t('pause')),
          ),
        ),
        h('div', { className: 'ab-body' },
          h('div', { className: 'ab-stats' },
            h(Stat, { value: stats.running, label: t('statsRunning'), tone: 'running' }),
            h(Stat, { value: stats.attention, label: t('statsAttention'), tone: 'attention' }),
            h(Stat, { value: stats.idle, label: t('statsIdle') }),
            h(Stat, { value: stats.done, label: t('statsDone'), tone: 'done' }),
            h(Stat, { value: stats.eventsToday ?? 0, label: t('statsEvents') }),
          ),
          h('div', { className: 'ab-providers', role: 'group', 'aria-label': t('all') },
            (data?.providers ?? []).map((provider) => h('button', {
              key: provider.id,
              type: 'button',
              className: 'ab-provider',
              'data-status': provider.status,
              'data-active': providerFilter === provider.id,
              title: provider.note || provider.status,
              onClick: () => setProviderFilter((current) => (current === provider.id ? 'all' : provider.id)),
            },
              h(StatusDot, { status: provider.status }),
              h(ProviderIcon, { id: provider.id, size: 16 }),
              h('span', { className: 'ab-provider-name' }, providerLabel(t, provider.id)),
              h('span', { className: 'ab-provider-count' }, `${provider.runningCount}/${provider.taskCount}`),
            )),
          ),
          collabs.length > 0 ? h('section', { className: 'ab-collabs' },
            h('div', { className: 'ab-collabs-head' },
              h('span', null, t('collabTitle')),
              h('span', { className: 'ab-count' }, String(collabs.length)),
            ),
            h('div', { className: 'ab-collab-list' },
              collabs.map((run) => h(CollabCard, { key: run.id, run, t, onOpen: openCollab })),
            ),
          ) : null,
          h('div', { className: 'ab-toolbar' },
            h('label', { className: 'ab-search' },
              h('span', { className: 'ab-sr' }, t('search')),
              h('input', {
                type: 'search',
                value: query,
                placeholder: t('search'),
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h('div', { className: 'ab-seg', role: 'group' },
              h('button', { type: 'button', 'data-active': statusFilter === 'all', onClick: () => setStatusFilter('all') }, t('all')),
              STATUSES.map((status) => h('button', {
                key: status,
                type: 'button',
                'data-active': statusFilter === status,
                onClick: () => setStatusFilter(status),
              }, t(`status.${status}`))),
            ),
          ),
          data && !data.monitoring ? h('div', { className: 'ab-banner' }, t('paused')) : null,
          error ? h('div', { className: 'ab-error' },
            h('span', null, `${t('errorTitle')}: ${error}`),
            h('button', { type: 'button', className: 'ab-btn', onClick: refresh }, t('retry')),
          ) : null,
          loading && !data
            ? h('div', { className: 'ab-empty' }, h('b', null, t('connecting')), h('span', null, t('subtitle')))
            : tasks.length === 0
              ? h('div', { className: 'ab-empty' }, h(BoardIcon, { size: 34 }), h('b', null, t('emptyTitle')), h('span', null, t('emptyHint')))
              : h('div', { className: 'ab-lanes' },
                  LANES.map((lane) => h('section', { key: lane, className: 'ab-lane' },
                    h('div', { className: 'ab-lane-head' },
                      h(StatusDot, { status: lane }),
                      h('span', null, t(`lane${lane.charAt(0).toUpperCase()}${lane.slice(1)}`)),
                      h('span', { className: 'ab-count' }, String(lanes[lane].length)),
                    ),
                    h('div', { className: 'ab-lane-body' },
                      lanes[lane].length === 0
                        ? h('div', { className: 'ab-lane-empty' }, t('laneEmpty'))
                        : lanes[lane].map((task) => h(TaskCard, { key: task.id, task, t, onOpen: openTask })),
                    ),
                  )),
                ),
        ),
        selected ? h(Drawer, {
          key: selected.id,
          task: selected,
          t,
          onClose: () => setSelectedId(null),
          onAction,
          busy,
          error: actionError,
        }) : selectedCollab ? h(CollabDrawer, {
          key: selectedCollab.id,
          run: selectedCollab,
          t,
          onClose: () => setSelectedCollabId(null),
          onAction,
          busy,
          error: actionError,
        }) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-board: dictionaries')
        BoardPage.ctx = ctx
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'agent-board',
          locale: NS,
        }, BoardPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'agent-board',
          order: 20,
          locale: NS,
          label: () => ctx.locale.bind(NS)('panel'),
        }, function AgentBoardIcon() {
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, h(BoardIcon, { size: 18 }))
        }))
      },
    }
  },
})
