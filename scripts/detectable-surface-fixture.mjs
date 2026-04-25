import http from 'node:http'

function probeHtml(title) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root { color-scheme: light; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      body { margin: 0; min-height: 1200px; background: #f8fafc; color: #0f172a; }
      main { width: 760px; margin: 40px auto; display: grid; gap: 18px; }
      button, input, textarea { font: inherit; padding: 10px 12px; border: 1px solid #94a3b8; border-radius: 10px; }
      button { width: 220px; background: #0f766e; color: #fff; border: 0; }
      #report { white-space: pre-wrap; overflow-wrap: anywhere; padding: 18px; border-radius: 16px; background: #020617; color: #d1fae5; }
    </style>
  </head>
  <body>
    <main>
      <h1>detectable-surface-ready</h1>
      <p>本页用于检测 browser MCP 只读工具是否留下页面 JS 可观察信号。</p>
      <button id="surface-button" type="button">候选人详情入口</button>
      <input id="surface-input" name="candidateSearch" placeholder="搜索候选人" value="李青" />
      <textarea id="surface-message" name="message" placeholder="输入沟通内容"></textarea>
      <pre id="report">REPORT_START{"status":"initializing"}REPORT_END</pre>
    </main>
    <script>
      (() => {
        const reportNode = document.getElementById('report')
        const startedAt = performance.now()
        const eventCounters = {}
        const untrustedEventCounters = {}
        const lifecycle = {
          visibilitychange: 0,
          focus: 0,
          blur: 0,
          pagehide: 0,
          pageshow: 0
        }
        const mutationSummary = {
          addedNodes: 0,
          removedNodes: 0,
          attributes: 0,
          characterData: 0
        }
        const postMessages = []

        function isReportNode(node) {
          return node === reportNode
            || node.parentNode === reportNode
            || reportNode.contains(node)
        }

        function shouldIgnoreMutation(record) {
          if (isReportNode(record.target)) return true
          for (const node of record.addedNodes) {
            if (isReportNode(node)) return true
          }
          for (const node of record.removedNodes) {
            if (isReportNode(node)) return true
          }
          return false
        }

        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (shouldIgnoreMutation(record)) continue
            mutationSummary.addedNodes += record.addedNodes.length
            mutationSummary.removedNodes += record.removedNodes.length
            if (record.type === 'attributes') mutationSummary.attributes += 1
            if (record.type === 'characterData') mutationSummary.characterData += 1
          }
        })
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        })

        for (const type of [
          'click',
          'dblclick',
          'mousedown',
          'mouseup',
          'mousemove',
          'mouseover',
          'pointerdown',
          'pointerup',
          'keydown',
          'keyup',
          'input',
          'change',
          'focusin',
          'focusout'
        ]) {
          eventCounters[type] = 0
          untrustedEventCounters[type] = 0
          document.addEventListener(type, (event) => {
            eventCounters[type] += 1
            if (event.isTrusted === false) untrustedEventCounters[type] += 1
          }, true)
        }

        document.addEventListener('visibilitychange', () => { lifecycle.visibilitychange += 1 })
        window.addEventListener('focus', () => { lifecycle.focus += 1 })
        window.addEventListener('blur', () => { lifecycle.blur += 1 })
        window.addEventListener('pagehide', () => { lifecycle.pagehide += 1 })
        window.addEventListener('pageshow', () => { lifecycle.pageshow += 1 })
        window.addEventListener('message', (event) => {
          postMessages.push({
            origin: event.origin,
            type: typeof event.data,
            sample: typeof event.data === 'string' ? event.data.slice(0, 80) : ''
          })
        })

        function readChromeRuntimeId() {
          try {
            return window.chrome && window.chrome.runtime ? window.chrome.runtime.id ?? null : null
          } catch (error) {
            return { threw: String(error) }
          }
        }

        function readResources() {
          const values = []
          for (const node of document.querySelectorAll('[src], [href]')) {
            const value = node.getAttribute('src') || node.getAttribute('href')
            if (value && value.startsWith('chrome-extension://')) values.push(value)
          }
          return values
        }

        function buildReport() {
          const globalLeaks = Object.keys(window).filter((key) => /mcp|vyodels|browser_mcp/i.test(key))
          const untrustedTotal = Object.values(untrustedEventCounters).reduce((sum, value) => sum + value, 0)
          const extensionResources = readResources()
          const chromeRuntimeId = readChromeRuntimeId()
          const failureSignals = []
          if (navigator.webdriver === true) failureSignals.push('navigator.webdriver=true')
          if (chromeRuntimeId) failureSignals.push('chrome.runtime.id visible')
          if (globalLeaks.length) failureSignals.push('browser_mcp global leak')
          if (untrustedTotal > 0) failureSignals.push('untrusted DOM event observed')
          if (extensionResources.length) failureSignals.push('chrome-extension resource visible')
          if (mutationSummary.addedNodes || mutationSummary.removedNodes || mutationSummary.attributes || mutationSummary.characterData) {
            failureSignals.push('unexpected DOM mutation observed')
          }
          if (postMessages.length) failureSignals.push('postMessage observed')

          return {
            title: document.title,
            url: location.href,
            elapsedMs: Math.round(performance.now() - startedAt),
            readyState: document.readyState,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            navigatorWebdriver: navigator.webdriver === undefined ? null : navigator.webdriver,
            chromeRuntimeId,
            globalLeaks,
            extensionResources,
            eventCounters,
            untrustedEventCounters,
            mutationSummary,
            lifecycle,
            postMessages,
            activeElement: document.activeElement ? {
              tag: document.activeElement.tagName.toLowerCase(),
              id: document.activeElement.id || ''
            } : null,
            failureSignals
          }
        }

        function render() {
          reportNode.textContent = 'REPORT_START' + JSON.stringify(buildReport()) + 'REPORT_END'
        }

        render()
        setInterval(render, 250)
      })()
    </script>
  </body>
</html>`
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

export async function createDetectableSurfaceServer() {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' || url.pathname === '/probe') {
      sendHtml(res, probeHtml('browser MCP 可感知性检测页'))
      return
    }
    if (url.pathname === '/secondary') {
      sendHtml(res, probeHtml('browser MCP 次级标签页'))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    routes: {
      probe: `${origin}/probe`,
      secondary: `${origin}/secondary`,
    },
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
