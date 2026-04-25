import http from 'node:http'

export const FIXTURE_SCROLL_Y = 640

export const COMPLEX_LAYOUT = {
  toolbar: { top: 24, left: 32, width: 176, height: 44 },
  articleButton: { top: 980, left: 120, width: 176, height: 44 },
  libraryFrame: { top: 1160, left: 80, width: 520, height: 220, border: 4 },
  externalFrame: { top: 1408, left: 120, width: 360, height: 140, border: 3 },
  libraryFrameButton: { top: 36, left: 28, width: 172, height: 40 },
  nestedFrame: { top: 120, left: 180, width: 280, height: 120 },
  nestedFrameLink: { top: 20, left: 30, width: 152, height: 32 },
  shadowHost: { top: 1280, left: 120, width: 260, height: 96 },
  shadowCard: { border: 2, paddingTop: 18, paddingLeft: 24 },
  shadowButton: { top: 18, left: 24, width: 168, height: 38 },
  modal: { top: 72, left: 220, width: 520, height: 420 },
  modalClose: { top: 24, left: 456, width: 40, height: 40 },
  modalFrame: { top: 96, left: 40, width: 440, height: 96 },
  modalFrameButton: { top: 24, left: 24, width: 156, height: 36 },
  modalComposer: { top: 208, left: 40, width: 440, height: 52 },
  modalUploadInput: { top: 276, left: 40, width: 156, height: 36 },
  modalViewOfflineLink: { top: 276, left: 212, width: 120, height: 36 },
  modalDownloadLink: { top: 276, left: 348, width: 132, height: 36 },
  modalTriangle: { top: 332, left: 432, width: 48, height: 36 },
  modalPartialAction: { top: 332, left: 40, width: 240, height: 44 },
  modalPartialCover: { top: 332, left: 40, width: 132, height: 44 },
  modalAction: { top: 332, left: 304, width: 112, height: 44 },
}

function parentHtml(origin, crossOriginOrigin) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>招聘中台坐标验收夹具</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Menlo, Monaco, monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: linear-gradient(180deg, #f7f8fb 0%, #eef2ff 46%, #fff7ed 100%);
        color: #1f2937;
        min-height: 2480px;
      }
      .toolbar {
        position: fixed;
        top: ${COMPLEX_LAYOUT.toolbar.top}px;
        left: ${COMPLEX_LAYOUT.toolbar.left}px;
        z-index: 10;
      }
      .toolbar button {
        width: ${COMPLEX_LAYOUT.toolbar.width}px;
        height: ${COMPLEX_LAYOUT.toolbar.height}px;
        border: 0;
        border-radius: 999px;
        background: #0f766e;
        color: #fff;
        font: inherit;
      }
      main {
        width: 980px;
        margin: 0 auto;
        padding: 120px 0 1360px;
      }
      .hero {
        position: relative;
        height: 760px;
        padding: 48px;
        border-radius: 28px;
        background: linear-gradient(135deg, #0f172a, #1d4ed8 52%, #14b8a6);
        color: #fff;
        overflow: hidden;
      }
      .hero::before {
        content: '';
        position: absolute;
        inset: auto -60px -120px auto;
        width: 320px;
        height: 320px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
      }
      .hero h1 {
        margin: 0 0 18px;
        font-size: 40px;
      }
      .hero p {
        margin: 0;
        max-width: 560px;
        line-height: 1.7;
      }
      .article-button {
        position: absolute;
        top: ${COMPLEX_LAYOUT.articleButton.top}px;
        left: ${COMPLEX_LAYOUT.articleButton.left}px;
        width: ${COMPLEX_LAYOUT.articleButton.width}px;
        height: ${COMPLEX_LAYOUT.articleButton.height}px;
        border: 0;
        border-radius: 16px;
        background: #111827;
        color: #fff;
        font: inherit;
      }
      .mixed-controls {
        position: absolute;
        top: 1038px;
        left: 120px;
        display: grid;
        gap: 12px;
        width: 360px;
      }
      .mixed-controls a,
      .mixed-controls input,
      .mixed-controls textarea,
      .mixed-controls select,
      .mixed-controls .fake-button,
      .mixed-controls [tabindex],
      .mixed-controls [onclick] {
        font: inherit;
      }
      .mixed-controls a {
        display: inline-flex;
        align-items: center;
        width: 360px;
      }
      .mixed-controls input,
      .mixed-controls textarea,
      .mixed-controls select {
        width: 360px;
      }
      .fake-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 184px;
        height: 40px;
        border-radius: 12px;
        background: #0f766e;
        color: #fff;
        cursor: pointer;
      }
      .library-frame,
      .external-frame {
        position: absolute;
        background: #fff;
      }
      .library-frame {
        top: ${COMPLEX_LAYOUT.libraryFrame.top}px;
        left: ${COMPLEX_LAYOUT.libraryFrame.left}px;
        width: ${COMPLEX_LAYOUT.libraryFrame.width}px;
        height: ${COMPLEX_LAYOUT.libraryFrame.height}px;
        border: ${COMPLEX_LAYOUT.libraryFrame.border}px solid #0f172a;
        border-radius: 20px;
      }
      .external-frame {
        top: ${COMPLEX_LAYOUT.externalFrame.top}px;
        left: ${COMPLEX_LAYOUT.externalFrame.left}px;
        width: ${COMPLEX_LAYOUT.externalFrame.width}px;
        height: ${COMPLEX_LAYOUT.externalFrame.height}px;
        border: ${COMPLEX_LAYOUT.externalFrame.border}px solid #7c3aed;
        border-radius: 18px;
      }
      .shadow-host {
        position: absolute;
        top: ${COMPLEX_LAYOUT.shadowHost.top}px;
        left: ${COMPLEX_LAYOUT.shadowHost.left}px;
        width: ${COMPLEX_LAYOUT.shadowHost.width}px;
        height: ${COMPLEX_LAYOUT.shadowHost.height}px;
        border-radius: 24px;
      }
      .status {
        position: absolute;
        top: 1700px;
        left: 120px;
        font-size: 14px;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 999;
      }
      .modal-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, 0.58);
      }
      .modal {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modal.top}px;
        left: ${COMPLEX_LAYOUT.modal.left}px;
        width: ${COMPLEX_LAYOUT.modal.width}px;
        height: ${COMPLEX_LAYOUT.modal.height}px;
        border-radius: 28px;
        background: #fff;
        box-shadow: 0 32px 80px rgba(15, 23, 42, 0.28);
        overflow: hidden;
      }
      .modal-close {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalClose.top}px;
        left: ${COMPLEX_LAYOUT.modalClose.left}px;
        width: ${COMPLEX_LAYOUT.modalClose.width}px;
        height: ${COMPLEX_LAYOUT.modalClose.height}px;
        border: 0;
        border-radius: 999px;
        background: #111827;
        color: #fff;
        font: inherit;
      }
      .modal-frame {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalFrame.top}px;
        left: ${COMPLEX_LAYOUT.modalFrame.left}px;
        width: ${COMPLEX_LAYOUT.modalFrame.width}px;
        height: ${COMPLEX_LAYOUT.modalFrame.height}px;
        border: 0;
        border-radius: 18px;
      }
      .modal-composer {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalComposer.top}px;
        left: ${COMPLEX_LAYOUT.modalComposer.left}px;
        width: ${COMPLEX_LAYOUT.modalComposer.width}px;
        height: ${COMPLEX_LAYOUT.modalComposer.height}px;
        resize: none;
        font: inherit;
      }
      .modal-upload {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalUploadInput.top}px;
        left: ${COMPLEX_LAYOUT.modalUploadInput.left}px;
        width: ${COMPLEX_LAYOUT.modalUploadInput.width}px;
        height: ${COMPLEX_LAYOUT.modalUploadInput.height}px;
        font: inherit;
      }
      .modal-offline-link,
      .modal-download {
        position: absolute;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 12px;
        text-decoration: none;
      }
      .modal-offline-link {
        top: ${COMPLEX_LAYOUT.modalViewOfflineLink.top}px;
        left: ${COMPLEX_LAYOUT.modalViewOfflineLink.left}px;
        width: ${COMPLEX_LAYOUT.modalViewOfflineLink.width}px;
        height: ${COMPLEX_LAYOUT.modalViewOfflineLink.height}px;
        background: #ede9fe;
        color: #6d28d9;
      }
      .modal-download {
        top: ${COMPLEX_LAYOUT.modalDownloadLink.top}px;
        left: ${COMPLEX_LAYOUT.modalDownloadLink.left}px;
        width: ${COMPLEX_LAYOUT.modalDownloadLink.width}px;
        height: ${COMPLEX_LAYOUT.modalDownloadLink.height}px;
        background: #dbeafe;
        color: #1d4ed8;
      }
      .modal-triangle {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalTriangle.top}px;
        left: ${COMPLEX_LAYOUT.modalTriangle.left}px;
        width: ${COMPLEX_LAYOUT.modalTriangle.width}px;
        height: ${COMPLEX_LAYOUT.modalTriangle.height}px;
        background: #f97316;
        clip-path: polygon(0 50%, 100% 0, 100% 100%);
        cursor: pointer;
      }
      .modal-action {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalAction.top}px;
        left: ${COMPLEX_LAYOUT.modalAction.left}px;
        width: ${COMPLEX_LAYOUT.modalAction.width}px;
        height: ${COMPLEX_LAYOUT.modalAction.height}px;
        border: 0;
        border-radius: 14px;
        background: #16a34a;
        color: #fff;
        font: inherit;
      }
      .modal-partial-action {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalPartialAction.top}px;
        left: ${COMPLEX_LAYOUT.modalPartialAction.left}px;
        width: ${COMPLEX_LAYOUT.modalPartialAction.width}px;
        height: ${COMPLEX_LAYOUT.modalPartialAction.height}px;
        border: 0;
        border-radius: 14px;
        background: #ea580c;
        color: #fff;
        font: inherit;
      }
      .modal-partial-cover {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalPartialCover.top}px;
        left: ${COMPLEX_LAYOUT.modalPartialCover.left}px;
        width: ${COMPLEX_LAYOUT.modalPartialCover.width}px;
        height: ${COMPLEX_LAYOUT.modalPartialCover.height}px;
        border-radius: 14px 0 0 14px;
        background: rgba(15, 23, 42, 0.7);
        z-index: 2;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <button>发布职位</button>
    </div>
    <main>
      <section class="hero">
        <h1>招聘中台复杂布局夹具</h1>
        <p>模拟职位搜索、候选人筛选、IM 沟通面板、附件上传下载、在线/离线简历查看、shadow 设计系统卡片与异形按钮，验证坐标、层级和随机落点还原。</p>
      </section>
    </main>
    <button class="article-button">立即沟通</button>
    <section class="mixed-controls">
      <a href="${origin}/jobs/frontend-platform">查看职位详情</a>
      <input type="text" name="jobQuery" value="前端工程师" readonly />
      <textarea name="candidateNote" placeholder="给候选人留言"></textarea>
      <select>
        <option>初筛中</option>
        <option>约面中</option>
      </select>
      <div class="fake-button" role="button" aria-expanded="true">更多筛选</div>
      <div tabindex="0" role="option" aria-selected="true">候选人标签</div>
      <div tabindex="0" role="checkbox" aria-checked="true">安排面试</div>
    </section>
    <iframe class="library-frame" src="${origin}/fixture/library"></iframe>
    <iframe class="external-frame" title="外部人才库" name="external-talent" src="${crossOriginOrigin}/fixture/external"></iframe>
    <div class="shadow-host" id="shadow-host"></div>
    <div class="status" id="fixture-status">fixture booting</div>
    <div class="modal-layer">
      <div class="modal-backdrop"></div>
      <div class="modal">
        <button class="modal-close">关闭沟通窗</button>
        <iframe class="modal-frame" src="${origin}/fixture/modal"></iframe>
        <textarea class="modal-composer" name="chatComposer" placeholder="输入消息，和候选人打个招呼"></textarea>
        <input class="modal-upload" type="file" aria-label="上传附件简历" accept="application/pdf,.pdf" />
        <a class="modal-offline-link" href="${origin}/fixture/offline-resume-view">查看离线简历</a>
        <a class="modal-download" href="${origin}/fixture/download/candidate-resume.pdf" download="candidate-resume.pdf">下载离线简历</a>
        <div class="modal-triangle" role="button" aria-label="更多沟通操作"></div>
        <button class="modal-partial-action">交换联系方式</button>
        <div class="modal-partial-cover" aria-hidden="true"></div>
        <button class="modal-action" disabled>发送消息</button>
      </div>
    </div>
    <script>
      const host = document.getElementById('shadow-host')
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = \`
        <style>
          .card {
            width: ${COMPLEX_LAYOUT.shadowHost.width}px;
            height: ${COMPLEX_LAYOUT.shadowHost.height}px;
            padding: ${COMPLEX_LAYOUT.shadowCard.paddingTop}px ${COMPLEX_LAYOUT.shadowCard.paddingLeft}px;
            border-radius: 24px;
            background: #fef3c7;
            border: ${COMPLEX_LAYOUT.shadowCard.border}px solid #f59e0b;
          }
          button {
            width: ${COMPLEX_LAYOUT.shadowButton.width}px;
            height: ${COMPLEX_LAYOUT.shadowButton.height}px;
            border: 0;
            border-radius: 12px;
            background: #f59e0b;
            color: #111827;
            font: inherit;
          }
        </style>
        <div class="card">
          <button>收藏候选人</button>
        </div>
      \`

      const frames = Array.from(document.querySelectorAll('iframe'))
      Promise.all(frames.map((frame) => new Promise((resolve) => {
        if (frame.contentDocument?.readyState === 'complete') return resolve()
        frame.addEventListener('load', () => resolve(), { once: true })
      }))).then(() => {
        window.scrollTo(0, ${FIXTURE_SCROLL_Y})
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.querySelector('.modal-composer')?.focus()
            document.getElementById('fixture-status').textContent = 'fixture-ready'
          })
        })
      })
    </script>
  </body>
</html>`
}

function libraryFrameHtml(origin) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { box-sizing: border-box; font-family: Menlo, Monaco, monospace; }
      body { margin: 0; background: #e2e8f0; }
      .button {
        position: absolute;
        top: ${COMPLEX_LAYOUT.libraryFrameButton.top}px;
        left: ${COMPLEX_LAYOUT.libraryFrameButton.left}px;
        width: ${COMPLEX_LAYOUT.libraryFrameButton.width}px;
        height: ${COMPLEX_LAYOUT.libraryFrameButton.height}px;
        border: 0;
        border-radius: 14px;
        background: #2563eb;
        color: #fff;
        font: inherit;
      }
      iframe {
        position: absolute;
        top: ${COMPLEX_LAYOUT.nestedFrame.top}px;
        left: ${COMPLEX_LAYOUT.nestedFrame.left}px;
        width: ${COMPLEX_LAYOUT.nestedFrame.width}px;
        height: ${COMPLEX_LAYOUT.nestedFrame.height}px;
        border: 0;
        border-radius: 12px;
      }
    </style>
  </head>
  <body>
    <button class="button">打开候选人档案</button>
    <iframe src="${origin}/fixture/nested"></iframe>
  </body>
</html>`
}

function nestedFrameHtml(origin) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { box-sizing: border-box; font-family: Menlo, Monaco, monospace; }
      body { margin: 0; background: #d1fae5; }
      a {
        position: absolute;
        top: ${COMPLEX_LAYOUT.nestedFrameLink.top}px;
        left: ${COMPLEX_LAYOUT.nestedFrameLink.left}px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: ${COMPLEX_LAYOUT.nestedFrameLink.width}px;
        height: ${COMPLEX_LAYOUT.nestedFrameLink.height}px;
        border-radius: 10px;
        background: #047857;
        color: #fff;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <a href="${origin}/fixture/download/candidate-portfolio.pdf" download="candidate-portfolio.pdf">下载候选人附件</a>
  </body>
</html>`
}

function modalFrameHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { box-sizing: border-box; font-family: Menlo, Monaco, monospace; }
      body {
        margin: 0;
        background: linear-gradient(135deg, #fef08a, #fca5a5);
      }
      button {
        position: absolute;
        top: ${COMPLEX_LAYOUT.modalFrameButton.top}px;
        left: ${COMPLEX_LAYOUT.modalFrameButton.left}px;
        width: ${COMPLEX_LAYOUT.modalFrameButton.width}px;
        height: ${COMPLEX_LAYOUT.modalFrameButton.height}px;
        border: 0;
        border-radius: 12px;
        background: #7c3aed;
        color: #fff;
        font: inherit;
      }
    </style>
  </head>
  <body>
    <button>查看在线简历</button>
  </body>
</html>`
}

function externalFrameHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>外部人才库</title>
    <style>
      body { margin: 0; font-family: Menlo, Monaco, monospace; background: #faf5ff; }
      .banner { padding: 24px; color: #581c87; }
    </style>
  </head>
  <body>
    <div class="banner">external-talent-frame</div>
  </body>
</html>`
}

function downloadBody(name) {
  return `%PDF-1.4\n% fixture ${name}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`
}

export async function createComplexLayoutServer() {
  const sockets = new Set()
  const externalSockets = new Set()
  const externalServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(externalFrameHtml())
  })
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`
    const crossOriginOrigin = `http://127.0.0.1:${externalServer.address().port}`

    if (req.url === '/fixture/download/candidate-resume.pdf' || req.url === '/fixture/download/candidate-portfolio.pdf') {
      const filename = req.url.endsWith('candidate-resume.pdf') ? 'candidate-resume.pdf' : 'candidate-portfolio.pdf'
      res.statusCode = 200
      res.setHeader('content-type', 'application/pdf')
      res.setHeader('content-disposition', `attachment; filename="${filename}"`)
      res.end(downloadBody(filename))
      return
    }

    if (req.url === '/fixture/offline-resume-view') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>查看离线简历</title></head><body>offline-resume-view</body></html>')
      return
    }

    res.setHeader('content-type', 'text/html; charset=utf-8')

    if (req.url === '/fixture/library') {
      res.end(libraryFrameHtml(origin))
      return
    }
    if (req.url === '/fixture/nested') {
      res.end(nestedFrameHtml(origin))
      return
    }
    if (req.url === '/fixture/modal') {
      res.end(modalFrameHtml())
      return
    }

    res.end(parentHtml(origin, crossOriginOrigin))
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  externalServer.on('connection', (socket) => {
    externalSockets.add(socket)
    socket.on('close', () => externalSockets.delete(socket))
  })

  await new Promise((resolve) => externalServer.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      for (const socket of externalSockets) socket.destroy()
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        externalServer.close((externalError) => externalError ? reject(externalError) : resolve())
      })
    }),
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/fixture/parent`,
  }
}
