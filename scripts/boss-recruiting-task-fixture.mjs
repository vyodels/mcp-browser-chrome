import http from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'boss-like')

const ROUTES = new Map([
  ['/', 'jobs.html'],
  ['/jobs', 'jobs.html'],
  ['/candidates', 'candidates.html'],
  ['/candidate/613', 'candidate-detail.html'],
])

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.pdf', 'application/pdf'],
])

function contentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream'
}

function resolveAsset(urlPath) {
  const cleanPath = urlPath.replace(/^\/+/, '')
  const routed = ROUTES.get(urlPath) ?? cleanPath
  const filePath = path.resolve(FIXTURE_ROOT, routed)
  if (!filePath.startsWith(FIXTURE_ROOT)) return undefined
  return filePath
}

async function serveFile(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const filePath = resolveAsset(url.pathname)
  if (!filePath) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) throw new Error('not a file')
    const headers = {
      'content-length': String(fileStat.size),
      'content-type': contentType(filePath),
    }
    if (path.extname(filePath) === '.pdf') {
      headers['content-disposition'] = `attachment; filename="${path.basename(filePath)}"`
      headers['x-content-type-options'] = 'nosniff'
    }
    res.writeHead(200, headers)
    createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

export async function createBossRecruitingTaskServer(options = {}) {
  const sockets = new Set()
  const requestedPort = Number.isInteger(options.port) && options.port >= 0 ? options.port : 0

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      res.writeHead(500)
      res.end(error.message)
    })
  })

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    await serveFile(req, res)
  }

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(requestedPort, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    routes: {
      jobs: `${origin}/jobs`,
      candidates: `${origin}/candidates`,
      candidateDetail: `${origin}/candidate/613`,
    },
    assetBuffer: async (relativePath) => readFile(path.join(FIXTURE_ROOT, relativePath)),
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function serveMockEnvironment() {
  const requestedPort = Number.parseInt(process.env.BOSS_RECRUITING_FIXTURE_PORT ?? '', 10)
  const fixture = await createBossRecruitingTaskServer({
    port: Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0,
  })
  console.log(JSON.stringify({
    origin: fixture.origin,
    routes: fixture.routes,
    description: 'Boss-like mock target site. Use as target_url for external agents/tests; this server does not run or decide the workflow.',
    role: 'mock-target-environment-only',
  }, null, 2))

  const close = async () => {
    await fixture.close()
    process.exit(0)
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  await new Promise(() => {})
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveMockEnvironment().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
