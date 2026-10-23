// Demo server: proxies Casso Console grant (tax-account linking) and GDT invoice APIs for the browser demo.
import crypto from 'crypto'
import express from 'express'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3040
if (process.argv.includes('--mock') && process.env.NODE_ENV === 'production') {
  console.error('Không chạy --mock khi NODE_ENV=production.')
  process.exit(1)
}
// `npm run mock`: Casso giả lập chạy ngay trong server này, để thử trọn luồng khi chưa có key.
const MOCK = process.argv.includes('--mock')
const SELF_URL = `http://localhost:${PORT}`

// Sandbox và Production dùng chung host API; khác nhau ở credential (tổ chức sandbox / thật).
// Khách luôn tự nhập x-client-id / x-secret-key của họ trên UI — server không giữ credential nào.
const trimUrl = (url) => (url || '').replace(/\/+$/, '')
const DEFAULT_BASE_URL = MOCK ? `${SELF_URL}/mock-casso` : trimUrl(process.env.CASSO_BASE_URL) || 'https://api-console.casso.vn'

const ENVIRONMENTS = {
  sandbox: {
    baseUrl: (MOCK ? '' : trimUrl(process.env.CASSO_SANDBOX_BASE_URL)) || DEFAULT_BASE_URL,
    widgetPath: '/link/v1/link-initialize.js'
  },
  production: {
    baseUrl: (MOCK ? '' : trimUrl(process.env.CASSO_PRODUCTION_BASE_URL)) || DEFAULT_BASE_URL,
    widgetPath: '/link/v1/stable/link-initialize.js'
  }
}

// fiServiceId của Tổng cục Thuế (hoá đơn điện tử); scopes / redirectUri do Casso Console tự ép phía server.
const GDT_FI_SERVICE_ID = '9fd49a0b-a9f0-4eb5-8c10-00c23bd29a41'
const TOKEN_RE = /^[A-Za-z0-9._~-]{1,512}$/
const UPSTREAM_TIMEOUT_MS = Number(process.env.CASSO_TIMEOUT_MS) || 45000
const str = (v) => (typeof v === 'string' ? v.trim() : '')

// Sau ngrok / reverse proxy: chỉ tin đúng số hop proxy khai báo (mặc định 1), không tin mọi X-Forwarded-*.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))
app.disable('x-powered-by')

// Origin của API/widget Casso (kể cả host giả lập khi --mock) — cho phép trong CSP: script widget, iframe, fetch của widget.
const CASSO_ORIGINS = [...new Set(Object.values(ENVIRONMENTS).map((e) => new URL(e.baseUrl).origin))]

// Header bảo mật + CSP; trang callback dùng nonce cho script inline của nó.
// Tài nguyên ngoài mà trang demo tải: Google Fonts (style/font), script + iframe widget Cas Link (Casso),
// logo ngân hàng (img https:). Không có script/style bên thứ ba nào khác.
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64')
  const casso = CASSO_ORIGINS.join(' ')
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${res.locals.nonce}' ${casso}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      `connect-src 'self' ${casso}`,
      `frame-src ${casso}`,
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains'
  })
  next()
})

// Giới hạn tần suất đơn giản theo IP (in-memory) để server không thành relay mở.
const RATE_WINDOW_MS = 60_000
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN) || 300
const hits = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [ip, h] of hits) if (now - h.start > RATE_WINDOW_MS) hits.delete(ip)
}, RATE_WINDOW_MS).unref()
function rateLimit(req, res, next) {
  const now = Date.now()
  let h = hits.get(req.ip)
  if (!h || now - h.start > RATE_WINDOW_MS) hits.set(req.ip, (h = { start: now, count: 0 }))
  if (++h.count > RATE_MAX) {
    return res.status(429).json({
      ok: false,
      status: 429,
      data: { error: { errorCode: 'DEMO_RATE_LIMITED', errorMessage: 'Quá nhiều request, thử lại sau 1 phút.' } }
    })
  }
  next()
}

// Webhook của Casso có thể mang nhiều giao dịch nên có parser riêng, giới hạn lớn hơn; các route khác chỉ nhận body nhỏ.
const jsonParser = express.json({ limit: '10kb' })
const webhookJsonParser = express.json({ limit: '256kb' })
app.use((req, res, next) => (req.path === '/casso/webhook' ? next() : jsonParser(req, res, next)))
app.use(['/api', '/casso/callback', '/casso/webhook'], rateLimit)

if (MOCK) {
  const { createMockCasso } = await import('./mock-casso.js')
  app.use('/mock-casso', createMockCasso())
}

app.use(express.static(path.join(__dirname, 'public')))

function maskKey(key, visibleChars = 4) {
  if (!key) return '(trống)'
  if (key.length <= visibleChars * 2) return '****'
  return `${key.slice(0, visibleChars)}…${key.slice(-visibleChars)}`
}

function getEnv(req) {
  const name = req.headers['x-casso-env'] === 'production' ? 'production' : 'sandbox'
  return { name, ...ENVIRONMENTS[name] }
}

function resolveCredentials(req) {
  return {
    clientId: (req.headers['x-client-id'] || '').trim(),
    secretKey: (req.headers['x-secret-key'] || '').trim()
  }
}

// Gọi thẳng Casso Proxy và trả nguyên status/response về UI, kèm request (đã che secret) để khách xem cấu trúc API.
async function callCasso(req, res, { method, endpoint, query, body, needsToken }) {
  const env = getEnv(req)
  const creds = resolveCredentials(req)
  const accessToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  // grant/token: có Authorization = Update Mode (đăng nhập lại kết nối cũ) thì chuyển tiếp token.
  const sendToken = needsToken || (method === 'POST' && endpoint === '/proxy/grant/token' && Boolean(accessToken))

  const missing = []
  if (!creds.clientId) missing.push('x-client-id')
  if (!creds.secretKey) missing.push('x-secret-key')
  if (needsToken && !accessToken) missing.push('Authorization (accessToken)')
  if (missing.length) {
    return res.status(400).json({
      ok: false,
      status: 400,
      data: { error: { errorCode: 'DEMO_MISSING_INPUT', errorMessage: `Thiếu ${missing.join(', ')}.` } }
    })
  }

  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString() : ''
  const url = `${env.baseUrl}${endpoint}${qs ? `?${qs}` : ''}`
  const headers = {
    'x-client-id': creds.clientId,
    'x-secret-key': creds.secretKey,
    Accept: 'application/json'
  }
  if (sendToken) headers.Authorization = accessToken
  if (body) headers['Content-Type'] = 'application/json'

  const request = {
    method,
    url,
    headers: {
      ...headers,
      'x-secret-key': maskKey(creds.secretKey),
      ...(sendToken ? { Authorization: maskKey(accessToken, 6) } : {})
    },
    body: body || undefined
  }

  const startedAt = Date.now()
  try {
    // Hết thời gian chờ thì trả lỗi thay vì giữ kết nối mãi khi Casso không phản hồi.
    const cassoRes = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    const text = await cassoRes.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text }
    }
    return res.status(cassoRes.status).json({
      ok: cassoRes.ok,
      status: cassoRes.status,
      latencyMs: Date.now() - startedAt,
      environment: env.name,
      request,
      data
    })
  } catch (err) {
    return res.status(502).json({
      ok: false,
      status: 502,
      latencyMs: Date.now() - startedAt,
      environment: env.name,
      request,
      data: { error: { errorCode: 'DEMO_NETWORK_ERROR', errorMessage: `Không kết nối được tới ${env.baseUrl}: ${err.message}` } }
    })
  }
}

// Domain công khai của demo (gồm cả sub-path nếu có) — dùng để hiện Redirect URI / Webhook URL cho khách copy.
// Không đặt thì trả null: trình duyệt tự suy từ URL trang (giữ được sub-path như /demo-api-gdt), không tin header Host.
const PUBLIC_BASE_URL = trimUrl(process.env.PUBLIC_BASE_URL) || null

// Cấu hình công khai cho UI: không bao giờ trả secret key về trình duyệt.
app.get('/api/config', (req, res) => {
  res.json({
    mock: MOCK,
    publicBaseUrl: PUBLIC_BASE_URL,
    githubUrl: process.env.GITHUB_URL || 'https://github.com',
    sandbox: { baseUrl: ENVIRONMENTS.sandbox.baseUrl, widgetScriptUrl: `${ENVIRONMENTS.sandbox.baseUrl}${ENVIRONMENTS.sandbox.widgetPath}` },
    production: { baseUrl: ENVIRONMENTS.production.baseUrl, widgetScriptUrl: `${ENVIRONMENTS.production.baseUrl}${ENVIRONMENTS.production.widgetPath}` }
  })
})

// Trạng thái đồng bộ: không gọi CAS, không tốn quota — poll thoải mái.
app.get('/api/gdt/sync-status', (req, res) =>
  callCasso(req, res, { method: 'GET', endpoint: '/proxy/gdt/sync-status', needsToken: true })
)

// Hoá đơn đã đồng bộ: không phân trang, 1 call trả hết khoảng ngày. Chỉ hoá đơn lần đầu "complete" mới tính quota.
// Query lặp (?a=1&a=2) thành mảng/object nên không nhận: chỉ chấp nhận chuỗi, rỗng = bỏ qua (Casso dùng mặc định).
const INVOICE_TYPES = new Set(['sold', 'purchase'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isRealDate = (s) => {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
const queryStr = (v) => (v === undefined ? '' : typeof v === 'string' ? v.trim() : null)
const badInput = (res, errorMessage) =>
  res.status(400).json({ ok: false, status: 400, data: { error: { errorCode: 'DEMO_INVALID_INPUT', errorMessage } } })

app.get('/api/gdt/invoices', (req, res) => {
  const fromDate = queryStr(req.query.fromDate)
  const toDate = queryStr(req.query.toDate)
  const invoiceType = queryStr(req.query.invoiceType)
  if (fromDate === null || (fromDate && !isRealDate(fromDate))) return badInput(res, 'fromDate phải có dạng YYYY-MM-DD.')
  if (toDate === null || (toDate && !isRealDate(toDate))) return badInput(res, 'toDate phải có dạng YYYY-MM-DD.')
  if (invoiceType === null || (invoiceType && !INVOICE_TYPES.has(invoiceType))) return badInput(res, 'invoiceType chỉ nhận sold hoặc purchase.')
  return callCasso(req, res, {
    method: 'GET',
    endpoint: '/proxy/gdt/invoices/stored',
    needsToken: true,
    query: { fromDate, toDate, invoiceType }
  })
})

// ---------------- Liên kết tài khoản thuế (grant) ----------------
// Mỗi route gọi đúng 1 API Casso bằng key của khách; logic luồng (claim / Cas Link / exchange / identity) nằm ở public/link-flow.js.

// Không có kết nối → { grantToken }; tổ chức đã có kết nối GDT → { link_id, message } (dùng grant/claim).
app.post('/api/casso/grant/token', (req, res) =>
  callCasso(req, res, { method: 'POST', endpoint: '/proxy/grant/token', body: { fiServiceId: GDT_FI_SERVICE_ID } })
)

// state = base64(JSON payload).HMAC-SHA512(hex) ký bằng x-secret-key — phải ký ở server vì cần secret.
app.post('/api/casso/grant/state', (req, res) => {
  const creds = resolveCredentials(req)
  if (!creds.clientId || !creds.secretKey) {
    return res.status(400).json({ ok: false, message: 'Thiếu x-client-id / x-secret-key để ký state.' })
  }
  const payload = { clientId: creds.clientId, nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  const signature = crypto.createHmac('sha512', creds.secretKey).update(payloadB64).digest('hex')
  res.json({ ok: true, state: `${payloadB64}.${signature}` })
})

app.post('/api/casso/grant/exchange', (req, res) =>
  callCasso(req, res, { method: 'POST', endpoint: '/proxy/grant/exchange', body: { publicToken: str(req.body?.publicToken) } })
)

app.post('/api/casso/grant/claim', (req, res) =>
  callCasso(req, res, { method: 'POST', endpoint: '/proxy/grant/claim', body: { link_ids: [str(req.body?.linkId)].filter(Boolean) } })
)

app.get('/api/casso/identity', (req, res) =>
  callCasso(req, res, { method: 'GET', endpoint: '/proxy/identity', needsToken: true })
)

// Chỉ gỡ claim của key này (không gọi CAS, không xoá kết nối của tổ chức).
app.post('/api/casso/grant/remove', (req, res) =>
  callCasso(req, res, { method: 'POST', endpoint: '/proxy/grant/remove', needsToken: true })
)

// JSON an toàn khi nhúng vào <script> inline: chặn </script> và ký tự xuống dòng JS.
const scriptJson = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

// Authorized Redirect URI: widget Cas Link (qua launcher của Casso Console) chuyển về đây kèm ?publicToken=&state=.
// Trả publicToken về trang demo (postMessage nếu mở từ cửa sổ demo, không thì chuyển trang kèm ?publicToken=).
app.get('/casso/callback', (req, res) => {
  // Widget iframe có thể nạp Redirect URI bên trong iframe của Casso — cho phép đúng các origin đó nhúng trang này.
  res.set('Content-Security-Policy', res.get('Content-Security-Policy').replace("frame-ancestors 'self'", `frame-ancestors 'self' ${CASSO_ORIGINS.join(' ')}`))
  res.removeHeader('X-Frame-Options')
  const raw = String(req.query.publicToken || '')
  const publicToken = TOKEN_RE.test(raw) ? raw : ''
  // Đường dẫn tương đối để chạy được cả ở gốc domain lẫn dưới sub-path (VD /demo-api-gdt/).
  const target = `../?publicToken=${encodeURIComponent(publicToken)}#step1`
  res.type('html').send(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Đang hoàn tất liên kết…</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1d2939">
  <p>${publicToken ? 'Liên kết thành công — đang quay lại trang demo…' : 'Không nhận được publicToken.'}</p>
  <script nonce="${res.locals.nonce}">
    (function () {
      var payload = ${scriptJson({ type: 'casso:public-token', publicToken })};
      var target = window.opener || (window.parent !== window ? window.parent : null);
      if (target && payload.publicToken) {
        target.postMessage(payload, window.location.origin);
        if (window.opener) window.close();
        return;
      }
      window.location.replace(${scriptJson(target)});
    })();
  </script>
</body></html>`)
})

// Authorized Webhook URL: body hợp lệ thì trả 200 ngay (non-2xx khiến Casso retry) rồi chỉ ghi log — không lưu, không xử lý.
// Không xác thực chữ ký: endpoint công khai, nội dung chỉ để hiển thị log. Bị giới hạn tần suất theo IP (429);
// body hỏng / quá lớn trả 400 / 413 qua error handler bên dưới.
app.post('/casso/webhook', webhookJsonParser, (req, res) => {
  res.status(200).json({ received: true })
  // Cắt ngắn + bỏ ký tự điều khiển để body lạ không chèn được dòng log giả.
  const clean = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80)
  console.log(`[webhook] ${new Date().toISOString()} ${clean(req.body?.webhookCode || req.body?.event) || '(không có webhookCode)'} grant=${clean(req.body?.grantId) || '-'}`)
})

// Lỗi chung (body quá lớn, JSON hỏng…): trả JSON gọn, không bao giờ lộ stack trace trong response.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const status = err.status || err.statusCode || 500
  if (status >= 500) console.error(`[error] ${req.method} ${req.path} ${status} ${String(err.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)}`)
  res.status(status).json({
    ok: false,
    status,
    data: { error: { errorCode: 'DEMO_BAD_REQUEST', errorMessage: status === 413 ? 'Request quá lớn.' : 'Request không hợp lệ.' } }
  })
})

// Chỉ nghe localhost: mọi truy cập đi qua nginx, không ai vào thẳng cổng để giả X-Forwarded-For.
app.listen(PORT, '127.0.0.1', () => {
  console.log('=======================================================')
  console.log(`🚀 Casso GDT Invoice Demo: ${SELF_URL}${MOCK ? '  (Casso giả lập)' : ''}`)
  for (const [name, env] of Object.entries(ENVIRONMENTS)) {
    console.log(`   ${name.padEnd(10)} ${env.baseUrl}`)
  }
  console.log('=======================================================')
})
