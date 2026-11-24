import { readIcon } from './icons.js'

/**
 * HTTP surface of the board.
 *
 * Reads are same-origin GETs; the only write path is one POST action endpoint.
 * The web server is loopback-only in the shipped composition, and these routes
 * add a Host/Origin fence of their own. A per-process page token is injected
 * into the index HTML so cross-site browser requests cannot drive actions.
 */

const LOOPBACK_HOST = /^(127(?:\.\d{1,3}){3}|localhost|\[::1\])(:\d+)?$/i
const LOOPBACK_ORIGIN = /^https?:\/\/(127(?:\.\d{1,3}){3}|localhost|\[::1\])(:\d+)?$/i
const MAX_BODY = 64 * 1024

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function originAllowed(origin) {
  return origin === undefined || origin === null || origin === '' || LOOPBACK_ORIGIN.test(String(origin))
}

/**
 * A Fetch `Request` may omit the Host header, so read routes rely on the
 * loopback bind plus the browser trust headers instead of Host.
 */
function resourceAllowed(request) {
  const origin = request.headers.get('origin')
  if (!originAllowed(origin)) return false
  const site = request.headers.get('sec-fetch-site')
  if (site === 'cross-site') return false
  return true
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('body too large')
      error.code = 'too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Inject the page token used by the dashboard's write path. */
function injectToken(html, token) {
  const script = `<script>window.__AGENT_BOARD_TOKEN__=${JSON.stringify(token)};</script>`
  if (typeof html === 'string' && html.includes('</head>')) {
    return html.replace('</head>', () => `${script}</head>`)
  }
  return `${script}${html ?? ''}`
}

/**
 * Register the four board routes plus the index token tap.
 * @returns {() => void} disposer
 */
export function registerRoutes(ctx, board) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('the web server service is not available')
  }
  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/agent-board/api/snapshot',
    resource: async (request) => {
      if (!resourceAllowed(request)) return json({ ok: false, error: 'forbidden' }, 403)
      return json(board.snapshot())
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/agent-board/api/stream',
    resource: async (request) => {
      if (!resourceAllowed(request)) return json({ ok: false, error: 'forbidden' }, 403)
      let unsubscribe = () => {}
      const stream = new ReadableStream({
        start(controller) {
          unsubscribe = board.subscribe(controller)
        },
        cancel() {
          unsubscribe()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        },
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/agent-board/api/health',
    resource: async (request) => {
      if (!resourceAllowed(request)) return json({ ok: false, error: 'forbidden' }, 403)
      let commandRegistered = false
      try {
        const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
        const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
        const agent = agents?.list?.()[0]
        if (commands?.find && agent) commandRegistered = Boolean(commands.find(agent, 'collab'))
      } catch {
        commandRegistered = false
      }
      return json({
        ok: true,
        commandRegistered,
        collabCount: board.collabs?.size ?? 0,
        revision: board.revision,
        monitoring: board.monitoring,
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/agent-board/api/action',
    handler: async (req, res) => {
      const headers = req.headers ?? {}
      const deny = (status, error) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error }))
      }
      if (!LOOPBACK_HOST.test(String(headers.host ?? ''))) return deny(403, 'forbidden-host')
      if (!originAllowed(headers.origin)) return deny(403, 'forbidden-origin')
      const token = String(headers['x-agent-board-token'] ?? '')
      const tokenOk = token !== '' && token === board.token
      const noBrowserOrigin = headers.origin === undefined
      if (!tokenOk && !noBrowserOrigin) return deny(401, 'missing-token')
      if (req.method !== 'POST') return deny(405, 'method-not-allowed')

      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return deny(error?.code === 'too-large' ? 413 : 400, 'invalid-body')
      }
      const name = String(body?.action ?? '')
      const payload = body?.payload ?? {}
      try {
        const result = await board.action(name, payload)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      } catch (error) {
        deny(500, `action-failed: ${error?.message ?? error}`)
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'prefix',
    path: '/agent-board/api/icon',
    resource: async (request) => {
      if (!resourceAllowed(request)) return json({ ok: false, error: 'forbidden' }, 403)
      const pathname = new URL(request.url).pathname
      const match = pathname.match(/^\/agent-board\/api\/icon\/([a-z-]+)\.svg$/)
      if (!match) return new Response('Not Found', { status: 404 })
      const data = await readIcon(match[1])
      if (!data) return new Response('Not Found', { status: 404 })
      return new Response(data, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
      })
    },
  }))

  if (typeof webServer.tapIndex === 'function') {
    disposers.push(webServer.tapIndex((html) => injectToken(html, board.token)))
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
