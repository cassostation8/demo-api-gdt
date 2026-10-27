// Casso Console Open API demo · Hoá đơn điện tử GDT.
// Hero: dashboard hoá đơn tương tác đầy đủ (dữ liệu minh hoạ, luôn gắn nhãn) → Cách hoạt động →
// 3 bước với dữ liệu thật: (1) liên kết tài khoản thuế lấy accessToken (link_id hoặc widget Cas Link;
// logic trong link-flow.js, UI vẽ theo khung api-transaction)
// → (2) gọi sync-status + invoices/stored → (3) bảng kê, rồi mở dashboard dữ liệu thật.
// Dữ liệu thật đi thẳng từ Casso Console qua server.js; không lưu database.

import { createCassoClient, createLinkFlow } from './link-flow.js'
import { buildSampleInvoices } from './sample-data.js'

// Gợi ý cách xử lý cho từng errorCode (theo https://console.casso.vn/docs/error).
const ERROR_HINTS = {
  MISSING_CREDENTIALS: 'Thiếu header x-client-id / x-secret-key.',
  INVALID_CREDENTIALS: 'Client ID không tồn tại hoặc secret key không khớp. Kiểm tra lại, và chắc chắn key thuộc đúng môi trường (sandbox / production).',
  BAD_REQUEST: 'Dữ liệu gửi lên không hợp lệ (thiếu Authorization, hoặc fromDate sau toDate). Xem trường detail.',
  PERMISSION_DENIED: 'Gói dịch vụ hiện tại chưa bao gồm dữ liệu hoá đơn GDT.',
  QUOTA_EXCEEDED: 'Đã hết hạn mức hoá đơn của gói trước khi gọi. Cần nạp thêm, gọi lại không giải quyết được.',
  TOO_MANY_REQUESTS: 'Gửi quá nhiều request (300/phút). Đợi một lát rồi thử lại.',
  INTERNAL_ERROR: 'Lỗi phía Casso Console hoặc Tổng cục Thuế. Thử lại sau.',
  INVALID_GRANT: 'accessToken không khớp với kết nối nào: token thuộc key / môi trường khác, hoặc kết nối đã bị gỡ (token của kết nối đã gỡ không dùng được nữa — liên kết lại ở bước 1).',
  invalid_grant: 'publicToken đã hết hạn hoặc đã dùng. Mở lại Cas Link để lấy publicToken mới.',
  ORG_MISMATCH: 'Mã số thuế không khớp với tổ chức của bạn — kết nối đã bị huỷ. Liên kết lại đúng tài khoản thuế.',
  IDENTITY_REQUIRED: 'Chưa xác thực xong tổ chức. Gọi GET /proxy/identity rồi thử lại.',
  IDENTITY_NOT_VERIFIED: 'Đang xác minh tổ chức. Token vẫn dùng được; gọi lại identity sau ít phút.',
  GRANT_NOT_PERMISSION: 'Grant thiếu scope identity. Liên kết lại với scopes gdt:invoice,identity.',
  CONNECTION_LIMIT_REACHED: 'Tổ chức đã đạt giới hạn số kết nối của gói dịch vụ.',
  GRANT_LOGIN_REQUIRED: 'Tài khoản thuế cần đăng nhập lại (mật khẩu vừa đổi). Dùng nút "Đăng nhập lại" ở bước 1.',
  OTP_REQUIRED: 'Tài khoản thuế cần xác thực OTP. Dùng nút "Đăng nhập lại" ở bước 1.',
  PREVENTED: 'Tài khoản thuế đang chặn đăng nhập từ website. Mở khoá trên cổng thuế rồi đăng nhập lại.',
  NOT_FOUND: 'link_id không tồn tại, hoặc không thuộc tổ chức của key này.',
  LOOKBACK_EXCEEDED: 'fromDate sớm hơn ngày bắt đầu có dữ liệu đã đồng bộ của tổ chức (xem detail). Chọn khoảng ngắn hơn; org_admin có thể yêu cầu đồng bộ hoá đơn quá khứ trong Casso Console.',
  LIMIT_REACHED: 'Hết hạn mức giữa chừng — danh sách hoá đơn đã bị cắt ngắn. Nạp thêm rồi gọi lại (hoá đơn đã tính phí lấy lại miễn phí).',
  DEMO_MISSING_INPUT: 'Điền đủ các trường bắt buộc rồi gọi lại.',
  KIT_MISSING_INPUT: 'Điền đủ các trường bắt buộc rồi gọi lại.',
  DEMO_NETWORK_ERROR: 'Server demo không kết nối được tới Casso Console.'
}

// coverage.status của invoices/stored: dữ liệu đã đủ chưa, và nên làm gì tiếp.
const COVERAGE_HINTS = {
  complete: 'Đã đồng bộ đầy đủ chi tiết.',
  syncing: 'Lần đồng bộ đầu đang chạy — theo dõi sync-status rồi gọi lại sau ít phút.',
  partial: 'Có hoá đơn chưa lấy được chi tiết. Gọi lại sau, hoá đơn đã tính phí không bị tính lại.',
  outside_window: 'fromDate sớm hơn syncedFrom — phần trước đó chưa được đồng bộ. org_admin có thể yêu cầu đồng bộ hoá đơn quá khứ trong Casso Console.'
}

const state = {
  config: null,
  env: sessionGet('casso_env') || 'sandbox',
  method: 'claim',
  cred: { clientId: '', secretKey: '' },
  accessToken: '',
  flow: null, // máy trạng thái liên kết (createLinkFlow trong link-flow.js)
  results: {},
  activeCall: {},
  real: null, // { invoices, query, coverage } sau khi gọi API thành công
  heroSource: 'sample',
  qlPhase: 'link', // hộp thoại liên kết nhanh: 'link' → 'range'
  qlLinking: false
}

// Mỗi API call gắn với một panel "API console" bên phải bước tương ứng.
// Call có `kit: true` do link-flow.js gọi; panel hiện đúng request đã gửi (server đã che secret).
// identity / grant/remove chạy sau cả hai cách liên kết nên hiện ở panel của tab đang mở.
const linkPanel = () => (state.method === 'claim' ? 'apiClaim' : 'apiCasLink')
const CALLS = {
  claim: {
    panel: 'apiClaim', kit: true, label: 'grant/claim', method: 'POST', path: '/proxy/grant/claim',
    body: () => ({ link_ids: [val('claimLinkId') || '<link_id>'] })
  },
  grantToken: {
    panel: 'apiCasLink', kit: true, label: 'grant/token', method: 'POST', path: '/proxy/grant/token',
    body: () => ({ fiServiceId: '9fd49a0b-a9f0-4eb5-8c10-00c23bd29a41' })
  },
  exchange: { panel: 'apiCasLink', kit: true, label: 'grant/exchange', method: 'POST', path: '/proxy/grant/exchange', body: () => ({ publicToken: val('manualPublicToken') || '<publicToken>' }) },
  identity: { panel: linkPanel, kit: true, label: 'identity', method: 'GET', path: '/proxy/identity', token: true },
  remove: { panel: linkPanel, kit: true, label: 'grant/remove', method: 'POST', path: '/proxy/grant/remove', token: true },
  syncStatus: { panel: 'apiInv', label: 'gdt/sync-status', method: 'GET', path: '/proxy/gdt/sync-status', token: true },
  invoices: { panel: 'apiInv', label: 'gdt/invoices/stored', method: 'GET', path: '/proxy/gdt/invoices/stored', token: true, query: () => invQuery() }
}
const PANELS = {
  apiClaim: ['claim', 'identity', 'remove'],
  apiCasLink: ['grantToken', 'exchange', 'identity', 'remove'],
  apiInv: ['syncStatus', 'invoices']
}

function panelOf(key) {
  const p = CALLS[key].panel
  return typeof p === 'function' ? p() : p
}

const ICONS = {
  search: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  filter: '<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z"/></svg>',
  download: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
  alert: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function $(id) { return document.getElementById(id) }
function val(id) { return ($(id)?.value || '').trim() }

function sessionGet(key) {
  try { return sessionStorage.getItem(key) } catch { return null }
}
function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value) } catch { /* bỏ qua khi trình duyệt chặn storage */ }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function toast(message, kind = 'info') {
  const el = $('toast')
  el.textContent = message
  el.dataset.kind = kind
  el.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200)
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`Đã copy ${label}`, 'success')
  } catch {
    toast('Trình duyệt chặn clipboard — hãy copy thủ công', 'error')
  }
}

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

// Ngày đầu tháng, lùi `back` tháng so với tháng hiện tại.
function monthStart(back = 0) {
  const d = new Date()
  d.setMonth(d.getMonth() - back, 1)
  return isoDate(d)
}

function viDate(iso) {
  return iso ? iso.slice(0, 10).split('-').reverse().join('/') : ''
}

function formatVnd(amount, { sign = false } = {}) {
  const abs = new Intl.NumberFormat('vi-VN').format(Math.abs(Math.round(amount)))
  const prefix = amount < 0 ? '−' : sign && amount > 0 ? '+' : ''
  return `${prefix}${abs} đ`
}

function formatCompact(amount) {
  const abs = Math.abs(amount)
  const fmt = (n) => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
  let text
  if (abs >= 1e9) text = `${fmt(abs / 1e9)} tỷ`
  else if (abs >= 1e6) text = `${fmt(abs / 1e6)} tr`
  else if (abs >= 1e3) text = `${fmt(abs / 1e3)}k`
  else text = fmt(abs)
  return `${amount < 0 ? '−' : ''}${text}`
}

// Casso bọc lỗi trong { error: { errorCode } }, nhưng route passthrough (exchange, invoices) có thể trả { error: "..." }.
function errorOf(payload) {
  const err = payload?.data?.error
  if (!err) return null
  if (typeof err === 'string') return { errorCode: err, errorMessage: payload.data.message || '' }
  return err
}

function envConfig() {
  return state.config?.[state.env] || {}
}

function envLabel() {
  return state.env === 'sandbox' ? 'Sandbox' : 'Production'
}

function hasCred() {
  return Boolean(state.cred.clientId && state.cred.secretKey)
}

function promptCred() {
  toast('Nhập Client ID và Client secret trước', 'error')
  const empty = !state.cred.clientId ? 'clientId' : 'secretKey'
  document.querySelector(`[data-cred="${empty}"]`)?.focus()
}

function apiHeaders(withToken, token) {
  const headers = { 'x-casso-env': state.env }
  if (state.cred.clientId) headers['x-client-id'] = state.cred.clientId
  if (state.cred.secretKey) headers['x-secret-key'] = state.cred.secretKey
  if (withToken) headers.Authorization = token
  return headers
}

const MISSING_KEYS = { ok: false, status: 0, missingKeys: true, data: { error: { errorCode: 'DEMO_MISSING_INPUT', errorMessage: 'Thiếu x-client-id / x-secret-key.' } } }

async function api(path, { method = 'GET', body, token } = {}) {
  if (!hasCred()) {
    promptCred()
    return MISSING_KEYS
  }
  const headers = apiHeaders(token !== undefined, token)
  if (body) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    return await res.json()
  } catch (err) {
    return { ok: false, status: 0, data: { error: { errorCode: 'DEMO_NETWORK_ERROR', errorMessage: err.message } } }
  }
}

function setBusy(button, busy, busyText = 'Đang gọi…') {
  if (!button) return
  if (busy) {
    button.dataset.label = button.innerHTML
    button.textContent = busyText
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
  } else {
    button.innerHTML = button.dataset.label || button.innerHTML
    button.disabled = false
    button.removeAttribute('aria-busy')
  }
}

function showResult(id, kind, html) {
  const el = $(id)
  el.hidden = false
  el.className = `inline-result ${kind}`
  el.innerHTML = html
}

function errorLine(payload) {
  const err = errorOf(payload)
  const code = err?.errorCode || payload.status
  const byStatus = { 401: 'INVALID_CREDENTIALS', 429: 'TOO_MANY_REQUESTS', 502: 'INTERNAL_ERROR' }[payload.status]
  const hint = ERROR_HINTS[err?.errorCode] || err?.errorMessage || ERROR_HINTS[byStatus] || ''
  const detail = typeof err?.detail === 'string' ? `<br><span class="muted">${escapeHtml(err.detail)}</span>` : ''
  return `${ICONS.alert}<span><b>Lỗi ${escapeHtml(code)}</b>${hint ? ` — ${escapeHtml(hint)}` : ''}${detail}</span>`
}

// ------------------------------------------------------------------
// Dữ liệu minh hoạ (chỉ cho hero, luôn gắn nhãn) — sinh trong sample-data.js
// ------------------------------------------------------------------
function buildSampleDataset() {
  const query = { fromDate: monthStart(5), toDate: isoDate(new Date()) }
  return { invoices: buildSampleInvoices(query), query, isSample: true }
}

// ------------------------------------------------------------------
// Chuẩn hoá hoá đơn cho bảng kê / dashboard
// ------------------------------------------------------------------
const DETAIL_LABELS = { complete: 'Đầy đủ', pending: 'Đang tải chi tiết', failed: 'Lỗi chi tiết' }

function plain(text) {
  return (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
}

function refKey(serial, number) {
  return `${serial || ''}|${String(number ?? '').replace(/^0+/, '')}`
}

// Hoá đơn thay thế (invoiceNature 2) thay hẳn hoá đơn gốc: bỏ hoá đơn gốc khỏi mọi tổng để không cộng trùng.
// Hoá đơn chưa "complete" chưa có số liệu đáng tin nên cũng không cộng.
function normalize(dataset) {
  const replaced = new Set(
    dataset.invoices
      .filter((x) => Number(x.invoiceNature) === 2 && x.originalInvoiceRef?.originalInvoiceNumber != null)
      .map((x) => refKey(x.originalInvoiceRef.originalInvoiceSerial, x.originalInvoiceRef.originalInvoiceNumber))
  )
  return dataset.invoices.map((inv) => {
    const sold = inv.invoiceType === 'sold'
    const f = inv.financials || {}
    const complete = inv.detailStatus === 'complete'
    const superseded = replaced.has(refKey(inv.invoiceSerial, inv.invoiceNumber))
    const nature = Number(inv.invoiceNature) || 1
    const partner = (sold ? inv.buyer : inv.seller) || {}
    const items = Array.isArray(inv.lineItems) ? inv.lineItems.map((li) => li?.itemName).filter(Boolean) : []
    let status = { label: DETAIL_LABELS[inv.detailStatus] || inv.detailStatus || '—', kind: complete ? 'ok' : inv.detailStatus === 'failed' ? 'err' : 'warn' }
    if (superseded) status = { label: 'Đã bị thay thế', kind: 'muted' }
    else if (complete && nature === 2) status = { label: 'Thay thế', kind: 'info' }
    else if (complete && nature === 3) status = { label: 'Điều chỉnh', kind: 'info' }
    return {
      inv,
      day: (inv.transactionDate || '').slice(0, 10),
      number: `${inv.invoiceSerial || ''} · ${inv.invoiceNumber || ''}`,
      sold,
      sign: sold ? 1 : -1,
      partnerName: partner.name || '',
      partnerTax: partner.taxCode || '',
      items,
      itemsText: items.length ? `${items[0]}${items.length > 1 ? ` +${items.length - 1}` : ''}` : '',
      complete,
      superseded,
      nature,
      counted: complete && !superseded,
      attention: !complete || superseded || nature !== 1,
      subtotal: Number(f.subtotalAmount) || 0,
      tax: Number(f.totalTaxAmount) || 0,
      total: Number(f.totalPaymentAmount ?? inv.amount) || 0,
      bands: Array.isArray(f.taxRateBreakdown) ? f.taxRateBreakdown : [],
      status
    }
  })
}

// ------------------------------------------------------------------
// Ledger: bảng kê + dashboard dùng chung (hero, bước 3, dashboard dữ liệu thật)
// ------------------------------------------------------------------
const TIME_FILTERS = [
  { key: 'all', label: 'Toàn kỳ' },
  { key: 'month', label: 'Tháng gần nhất' },
  { key: '3m', label: '3 tháng gần nhất' }
]

function createLedger(root, { mode }) {
  // tab: góc nhìn của dashboard (Tổng quan / Sales / Product / Expense) — giữ nguyên khi đổi dữ liệu.
  const L = { root, mode, dataset: null, rows: [], tab: 'overview' }
  const dashboard = mode === 'dashboard'

  function resetFilters() {
    L.f = { quick: 'all', type: 'all', detail: 'all', time: 'all', search: '', col: { time: '', number: '', partner: '', items: '' } }
  }
  resetFilters()

  L.setData = (dataset) => {
    L.dataset = dataset
    L.rows = normalize(dataset)
    resetFilters()
    renderShell()
    renderData()
  }

  function range() {
    const { fromDate, toDate } = L.dataset.query
    const clamp = (start) => ({ from: start > fromDate ? start : fromDate, to: toDate })
    if (L.f.time === 'month') return clamp(`${toDate.slice(0, 7)}-01`)
    if (L.f.time === '3m') {
      const d = new Date(`${toDate.slice(0, 7)}-01T00:00:00`)
      d.setMonth(d.getMonth() - 2)
      return clamp(isoDate(d))
    }
    return { from: fromDate, to: toDate }
  }

  // Lọc theo sidebar, bỏ qua một nhóm để đếm số lượng cho chính nhóm đó.
  function sideFiltered(except) {
    const f = L.f
    const r = range()
    return L.rows.filter((x) => {
      if (except !== 'quick' && f.quick === 'attention' && !x.attention) return false
      if (except !== 'type' && f.type === 'sold' && !x.sold) return false
      if (except !== 'type' && f.type === 'purchase' && x.sold) return false
      if (except !== 'detail' && f.detail !== 'all' && x.inv.detailStatus !== f.detail) return false
      if (except !== 'time' && (x.day < r.from || x.day > r.to)) return false
      return true
    })
  }

  function rows(except) {
    const q = plain(L.f.search)
    const c = L.f.col
    const has = (value, needle) => !needle || plain(value).includes(plain(needle))
    return sideFiltered(except)
      .filter((x) => !q || plain(`${x.number} ${x.partnerName} ${x.partnerTax} ${x.items.join(' ')}`).includes(q))
      .filter((x) => has(viDate(x.day), c.time) && has(x.number, c.number) && has(`${x.partnerName} ${x.partnerTax}`, c.partner) && has(x.items.join(' '), c.items))
      .sort((a, b) => b.day.localeCompare(a.day) || b.number.localeCompare(a.number))
  }

  function sideOption(group, key, label, count) {
    const active = L.f[group] === key
    return `<button class="side-opt ${active ? 'active' : ''}" data-lf="${group}" data-v="${escapeHtml(key)}" aria-pressed="${active}">
      <span class="side-radio" aria-hidden="true"></span><span class="side-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${count != null ? `<span class="side-count">${count}</span>` : ''}</button>`
  }

  function renderSide() {
    const byType = sideFiltered('type')
    const byDetail = sideFiltered('detail')
    const count = (list, fn) => list.filter(fn).length
    const { fromDate, toDate } = L.dataset.query

    root.querySelector('[data-part="side"]').innerHTML = `${dashboard ? `
      <div class="side-group side-views">
        <div class="side-title">Góc nhìn</div>
        ${DASH_TABS.map((t) => `<button class="side-opt side-view ${L.tab === t.key ? 'active' : ''}" data-ltab="${t.key}" aria-pressed="${L.tab === t.key}" title="${escapeHtml(t.question)}">
          <span class="side-radio" aria-hidden="true"></span><span class="side-label">${t.label}</span></button>`).join('')}
      </div>` : ''}
      <div class="side-tabs">
        <button class="side-tab ${L.f.quick === 'all' ? 'active' : ''}" data-lf="quick" data-v="all">Tất cả hoá đơn</button>
        <button class="side-tab ${L.f.quick === 'attention' ? 'active' : ''}" data-lf="quick" data-v="attention">Cần chú ý</button>
      </div>
      <div class="side-group">
        <div class="side-title">Loại hoá đơn</div>
        ${sideOption('type', 'all', 'Tất cả', byType.length)}
        ${sideOption('type', 'sold', 'Bán ra', count(byType, (x) => x.sold))}
        ${sideOption('type', 'purchase', 'Mua vào', count(byType, (x) => !x.sold))}
      </div>
      <div class="side-group">
        <div class="side-title">Trạng thái chi tiết</div>
        ${sideOption('detail', 'all', 'Tất cả', byDetail.length)}
        ${Object.entries(DETAIL_LABELS).map(([k, label]) => sideOption('detail', k, label, count(byDetail, (x) => x.inv.detailStatus === k))).join('')}
      </div>
      <div class="side-group">
        <div class="side-title">Thời gian</div>
        ${TIME_FILTERS.map((tf) => sideOption('time', tf.key, tf.label, null)).join('')}
        <div class="side-range">${viDate(fromDate)} → ${viDate(toDate)}</div>
      </div>`
  }

  function renderShell() {
    root.innerHTML = `
      <div class="ledger ${dashboard ? 'ledger-dash' : 'ledger-statement'}">
        <aside class="ledger-side" data-part="side" aria-label="Bộ lọc"></aside>
        <div class="ledger-main">
          <div class="ledger-toolbar">
            <label class="search-box">${ICONS.search}<input type="search" data-lsearch placeholder="Tìm theo số hoá đơn, đối tác, MST, hàng hoá…" aria-label="Tìm hoá đơn"></label>
            <span class="toolbar-meta" data-part="meta"></span>
            <button class="btn btn-ghost btn-sm" data-lexport>${ICONS.download}Xuất CSV</button>
          </div>
          ${dashboard ? `
            <div class="dash-head" data-part="dashHead"></div>
            <div class="dash-body" data-part="dash"></div>` : ''}
          <div class="sheet">
            <div class="sheet-scroll">
              <table class="sheet-table">
                <thead>
                  <tr>
                    <th class="col-time">Ngày lập</th>
                    <th class="col-ref col-invno">Ký hiệu · Số</th>
                    <th class="col-type">Loại</th>
                    <th class="col-partner">Đối tác</th>
                    <th class="col-items">Hàng hoá, dịch vụ</th>
                    <th class="num col-amt">Trước thuế</th>
                    <th class="num col-amt">Thuế GTGT</th>
                    <th class="num col-amt">Tổng thanh toán</th>
                    <th class="col-cat">Trạng thái</th>
                  </tr>
                  <tr class="filter-row">
                    <th><label class="col-filter">${ICONS.filter}<input data-lcol="time" placeholder="dd/mm" aria-label="Lọc ngày"></label></th>
                    <th><label class="col-filter">${ICONS.filter}<input data-lcol="number" aria-label="Lọc số hoá đơn"></label></th>
                    <th></th>
                    <th><label class="col-filter">${ICONS.filter}<input data-lcol="partner" aria-label="Lọc đối tác"></label></th>
                    <th><label class="col-filter">${ICONS.filter}<input data-lcol="items" aria-label="Lọc hàng hoá"></label></th>
                    <th></th><th></th><th></th><th></th>
                  </tr>
                </thead>
                <tbody data-part="tbody"></tbody>
                <tfoot><tr><td colspan="5" data-part="footLabel"></td><td class="num" data-part="footSub"></td><td class="num" data-part="footTax"></td><td class="num" data-part="footTotal"></td><td></td></tr></tfoot>
              </table>
            </div>
          </div>
        </div>
      </div>`
    renderSide()
  }

  function money(x, value) {
    if (!x.complete) return '—'
    return formatVnd(x.sign * value, { sign: true })
  }

  function renderData() {
    const list = rows()
    const limit = 300
    root.querySelector('[data-part="tbody"]').innerHTML = list.length
      ? list.slice(0, limit).map((x) => `
        <tr class="${x.superseded ? 'row-struck' : ''}">
          <td class="nowrap">${escapeHtml(viDate(x.day))}</td>
          <td class="nowrap mono">${escapeHtml(x.number)}</td>
          <td class="nowrap">${x.sold ? 'Bán ra' : 'Mua vào'}</td>
          <td class="desc" title="${escapeHtml(x.partnerName)}">${escapeHtml(x.partnerName || '—')}<span class="sub mono">${escapeHtml(x.partnerTax)}</span></td>
          <td class="desc" title="${escapeHtml(x.items.join('\n'))}">${escapeHtml(x.itemsText || (x.complete ? '—' : 'Chưa có chi tiết'))}</td>
          <td class="num ${x.sold ? 'pos' : 'neg'}">${money(x, x.subtotal)}</td>
          <td class="num">${money(x, x.tax)}</td>
          <td class="num ${x.sold ? 'pos' : 'neg'}">${money(x, x.total)}</td>
          <td><span class="status-chip ${x.status.kind}">${escapeHtml(x.status.label)}</span></td>
        </tr>`).join('')
      : '<tr><td colspan="9" class="empty-row">Không có hoá đơn phù hợp bộ lọc.</td></tr>'

    const counted = list.filter((x) => x.counted)
    const net = (field) => counted.reduce((s, x) => s + x.sign * x[field], 0)
    root.querySelector('[data-part="footLabel"]').textContent =
      `Bán ra − mua vào (${counted.length.toLocaleString('vi-VN')}/${list.length.toLocaleString('vi-VN')} hoá đơn đủ chi tiết, bỏ hoá đơn đã bị thay thế)${list.length > limit ? ` · hiển thị ${limit} dòng mới nhất` : ''}`
    ;[['footSub', 'subtotal'], ['footTax', 'tax'], ['footTotal', 'total']].forEach(([part, field]) => {
      const total = net(field)
      const el = root.querySelector(`[data-part="${part}"]`)
      el.textContent = formatVnd(total, { sign: true })
      el.className = `num ${total >= 0 ? 'pos' : 'neg'}`
    })
    root.querySelector('[data-part="meta"]').textContent = `${list.length.toLocaleString('vi-VN')} / ${L.rows.length.toLocaleString('vi-VN')} hoá đơn`

    if (dashboard) renderDash(list)
  }

  // Tổng quan dùng đúng các hoá đơn đang lọc. Sales / Product / Expense tự chọn loại hoá đơn (bán ra / mua vào)
  // nên bỏ qua bộ lọc "Loại hoá đơn" ở sidebar, còn lại (thời gian, trạng thái, tìm kiếm) vẫn áp dụng.
  function renderDash(list) {
    const el = root.querySelector('[data-part="dash"]')
    const view = DASH_TABS.find((t) => t.key === L.tab)
    root.querySelector('[data-part="dashHead"]').innerHTML = `<h3>${view.label}</h3><p class="muted">${view.question}</p>`
    if (L.tab === 'overview') {
      el.innerHTML = OVERVIEW_HTML
      renderKpis(root, list)
      renderChart(root, list, range())
      renderInsights(root, list)
    } else {
      view.render(el, rows('type'), range())
    }
  }
  L.redrawChart = () => { if (dashboard && L.dataset) renderDash(rows()) }

  L.exportCsv = () => {
    const list = rows()
    const header = ['transactionDate', 'invoiceSerial', 'invoiceNumber', 'invoiceType', 'partnerName', 'partnerTaxCode', 'items', 'subtotalAmount', 'totalTaxAmount', 'totalPaymentAmount', 'detailStatus', 'invoiceNature']
    // Chống CSV/formula injection: ô chuỗi bắt đầu bằng = + - @ tab CR được thêm dấu ' phía trước (số thật giữ nguyên).
    const csvCell = (v) => {
      let s = String(v ?? '')
      if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`
      return `"${s.replace(/"/g, '""')}"`
    }
    const lines = [header.join(',')].concat(list.map((x) => [
      x.day, x.inv.invoiceSerial, x.inv.invoiceNumber, x.inv.invoiceType, x.partnerName, x.partnerTax, x.items.join('; '),
      x.complete ? x.subtotal : '', x.complete ? x.tax : '', x.complete ? x.total : '', x.inv.detailStatus, x.nature
    ].map(csvCell).join(',')))
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `casso-${L.dataset.isSample ? 'minh-hoa' : 'hoa-don'}_${L.dataset.query.fromDate}_${L.dataset.query.toDate}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast(`Đã xuất ${list.length} hoá đơn`, 'success')
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t || !L.dataset) return
    if (t.dataset.lf) {
      L.f[t.dataset.lf] = t.dataset.v
      renderSide()
      renderData()
    } else if (t.dataset.ltab) {
      L.tab = t.dataset.ltab
      renderSide()
      renderDash(rows())
    } else if (t.dataset.lexport !== undefined) {
      L.exportCsv()
    }
  })
  root.addEventListener('input', (e) => {
    if (!L.dataset) return
    if (e.target.dataset.lsearch !== undefined) L.f.search = e.target.value
    else if (e.target.dataset.lcol) L.f.col[e.target.dataset.lcol] = e.target.value
    else return
    renderData()
  })
  return L
}

// ------------------------------------------------------------------
// Dashboard theo góc nhìn: Tổng quan · Sales Growth · Product Growth · Expense
// Cùng nguồn hoá đơn, chỉ khác cách đọc: bán ra theo khách hàng, theo dòng hàng, mua vào theo nhà cung cấp.
// ------------------------------------------------------------------
const OVERVIEW_HTML = `
  <div class="kpi-row" data-part="kpi"></div>
  <div class="card chart-card">
    <div class="card-head">
      <div><h3>Bán ra và mua vào theo <span data-part="grain">ngày</span></h3>
        <p class="muted">Giá trị trước thuế. Bán ra hướng lên, mua vào hướng xuống. Rê chuột để xem chi tiết.</p></div>
      <div class="legend"><span><i class="sw sw-in"></i>Bán ra</span><span><i class="sw sw-out"></i>Mua vào</span></div>
    </div>
    <div class="chart-wrap"><svg data-part="chart" role="img" aria-label="Biểu đồ hoá đơn bán ra và mua vào"></svg><div class="chart-tip" hidden></div></div>
  </div>
  <div class="insight-grid" data-part="insights"></div>`

const DASH_TABS = [
  { key: 'overview', label: 'Tổng quan', question: 'Thuế, doanh thu, chi phí', render: null },
  { key: 'sales', label: 'Sales Growth', question: 'Doanh số tăng nhờ khách mới hay khách cũ?', render: renderSalesTab },
  { key: 'product', label: 'Product Growth', question: 'Sản phẩm nào bán chạy, sản phẩm nào chững?', render: renderProductTab },
  { key: 'expense', label: 'Expense', question: 'Tiền đi đâu, nhóm nào tăng bất thường?', render: renderExpenseTab }
]

// Bảng màu phân loại cố định theo thứ tự (đã kiểm tra CVD); phần còn lại gộp vào "Khác" màu trung tính.
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']
const OTHER_COLOR = '#98a2b3'

function monthKeys(r) {
  const keys = []
  for (let m = r.from.slice(0, 7); m <= r.to.slice(0, 7);) {
    keys.push(m)
    const [y, mo] = m.split('-').map(Number)
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
  }
  return keys
}

function monthName(key) {
  const [y, m] = key.split('-')
  return `T${Number(m)}/${y.slice(2)}`
}

// Cặp tháng để so sánh MoM: [tháng so, tháng trước]. Tháng cuối chưa hết (VD đến 09/10) mà so với cả tháng trước
// thì luôn "giảm", nên khi còn đủ dữ liệu, so hai tháng trọn vẹn gần nhất. Không đủ 2 tháng thì không so.
function momPair(months, r) {
  const last = months[months.length - 1]
  const [y, m] = last.split('-').map(Number)
  const monthEnd = isoDate(new Date(y, m, 0))
  const partial = r.to < monthEnd
  if (partial && months.length >= 3) return [months[months.length - 2], months[months.length - 3]]
  if (months.length >= 2) return [last, months[months.length - 2]]
  return null
}

function momOf(byMonth, pair) {
  if (!pair) return null
  const cur = byMonth.get(pair[0]) || 0
  const prev = byMonth.get(pair[1]) || 0
  return prev ? (cur - prev) / Math.abs(prev) : null
}

function deltaHtml(d, { goodWhenUp = true } = {}) {
  if (d == null || !Number.isFinite(d)) return '<span class="muted">—</span>'
  if (Math.abs(d) < 0.0005) return '<span class="muted">0%</span>'
  const up = d >= 0
  const good = up === goodWhenUp
  return `<span class="delta ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${(Math.abs(d) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%</span>`
}

function sumByMonth(facts, field = 'value') {
  const map = new Map()
  facts.forEach((f) => map.set(f.month, (map.get(f.month) || 0) + f[field]))
  return map
}

function kpiTile(label, value, sub) {
  return `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub}</span></div>`
}

function momSub(byMonth, pair, opts) {
  if (!pair) return 'Chọn khoảng ≥ 2 tháng để so sánh'
  return `${deltaHtml(momOf(byMonth, pair), opts)} ${monthName(pair[0])} so với ${monthName(pair[1])}`
}

function momLabel(pair) {
  return pair ? `${monthName(pair[0])} vs ${monthName(pair[1])}` : 'MoM'
}

// Top-N theo tổng giá trị, phần còn lại gộp "Khác". Màu theo thứ hạng trong khoảng đang xem.
function stackSeries(facts, months, n = 5) {
  const totals = new Map()
  facts.forEach((f) => {
    const t = totals.get(f.key) || { key: f.key, label: f.label, total: 0 }
    t.total += f.value
    totals.set(f.key, t)
  })
  const top = [...totals.values()].sort((a, b) => b.total - a.total).slice(0, n)
  const topKeys = new Set(top.map((t) => t.key))
  const series = top.map((t, i) => ({ label: t.label, color: SERIES_COLORS[i], values: months.map(() => 0), keys: [t.key] }))
  const other = { label: 'Khác', color: OTHER_COLOR, values: months.map(() => 0) }
  facts.forEach((f) => {
    const i = months.indexOf(f.month)
    if (i < 0) return
    const s = topKeys.has(f.key) ? series.find((x) => x.keys[0] === f.key) : other
    s.values[i] += f.value
  })
  if (other.values.some((v) => v)) series.push(other)
  return series
}

function legendHtml(series) {
  return `<div class="legend legend-wrap">${series.map((s) => `<span title="${escapeHtml(s.label)}"><i class="sw" style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`).join('')}</div>`
}

// Cột chồng theo tháng: khe 2px giữa các đoạn, đầu cột bo 4px, rê chuột xem từng nhóm.
function renderStackChart(wrap, months, series) {
  const svg = wrap.querySelector('svg')
  const tip = wrap.querySelector('.chart-tip')
  tip.style.width = '260px' // tên nhà cung cấp / sản phẩm dài hơn nhãn của biểu đồ tổng quan
  const totals = months.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i]), 0))
  const width = Math.max(wrap.clientWidth, 280)
  const height = 240
  const m = { top: 14, right: 12, bottom: 28, left: 60 }
  const plotW = width - m.left - m.right
  const plotH = height - m.top - m.bottom
  const step = niceStep(Math.max(...totals, 1))
  const top = Math.max(step, Math.ceil(Math.max(...totals, 0) / step) * step)
  const y = (v) => m.top + ((top - v) / top) * plotH
  const band = plotW / months.length
  const bw = Math.max(4, Math.min(40, band * 0.6))
  const gap = 2

  let grid = ''
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = Math.round(y(v)) + 0.5
    grid += `<line class="${v === 0 ? 'axis-zero' : 'grid'}" x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}"/>
      <text class="tick" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${formatCompact(v)}</text>`
  }
  let bars = ''
  months.forEach((key, i) => {
    const x = m.left + band * i + (band - bw) / 2
    bars += `<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${plotH}"/>`
    let acc = 0
    const segs = series.map((s) => ({ s, v: Math.max(0, s.values[i]) })).filter((g) => g.v > 0)
    segs.forEach((g, j) => {
      const y0 = y(acc) - (j ? gap / 2 : 0)
      acc += g.v
      const y1 = y(acc) + (j < segs.length - 1 ? gap / 2 : 0)
      if (y0 - y1 < 0.5) return
      bars += j === segs.length - 1
        ? `<path d="${barPath(x, bw, y0, y1, 4)}" fill="${g.s.color}"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${y0 - y1}" fill="${g.s.color}"/>`
    })
    bars += `<text class="tick" x="${x + bw / 2}" y="${height - 8}" text-anchor="middle">${monthName(key)}</text>`
  })
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  svg.innerHTML = `<rect class="hover-band" x="0" y="${m.top}" width="${band}" height="${plotH}" visibility="hidden"/>${grid}${bars}`
  const hoverBand = svg.querySelector('.hover-band')

  svg.onmousemove = (e) => {
    const target = e.target.closest('.hit')
    if (!target) return
    const i = Number(target.dataset.i)
    hoverBand.setAttribute('x', m.left + band * i)
    hoverBand.setAttribute('visibility', 'visible')
    tip.hidden = false
    tip.innerHTML = `<b>${monthName(months[i])}</b>${series.filter((s) => s.values[i]).map((s) => `
      <div><i class="sw" style="background:${s.color}"></i>${escapeHtml(s.label.length > 28 ? `${s.label.slice(0, 28)}…` : s.label)} <span>${formatCompact(s.values[i])}</span></div>`).join('')}
      <div class="tip-net">Tổng <span>${formatVnd(totals[i])}</span></div>`
    const rect = wrap.getBoundingClientRect()
    let left = (m.left + band * i + band / 2) * (rect.width / width) + 12
    if (left + 240 > rect.width) left -= 264
    tip.style.left = `${Math.max(0, left)}px`
    tip.style.top = `${m.top}px`
  }
  svg.onmouseleave = () => {
    tip.hidden = true
    hoverBand.setAttribute('visibility', 'hidden')
  }
}

function chartCard(title, note, series) {
  return `
    <div class="card chart-card">
      <div class="card-head"><div><h3>${title}</h3><p class="muted">${note}</p></div></div>
      <div class="chart-wrap" data-part="stack"><svg role="img" aria-label="${escapeHtml(title)}"></svg><div class="chart-tip" hidden></div></div>
      ${legendHtml(series)}
    </div>`
}

function shareBar(share) {
  return `<span class="share"><span class="share-track"><span class="share-fill" style="width:${Math.min(100, share * 100)}%"></span></span>${(share * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%</span>`
}

function emptyTab(el, text) {
  el.innerHTML = `<div class="card dash-empty">${text}</div>`
}

// Nhóm hoá đơn theo đối tác (MST), kèm giá trị của cặp tháng so sánh để tính MoM.
function partnerTable(list, pair) {
  const [last, prev] = pair || []
  const map = new Map()
  list.forEach((x) => {
    const key = x.partnerTax || x.partnerName
    const g = map.get(key) || { name: x.partnerName || '—', tax: x.partnerTax, count: 0, total: 0, last: 0, prev: 0, lastDay: '' }
    g.count++
    g.total += x.subtotal
    if (last && x.day.startsWith(last)) g.last += x.subtotal
    if (prev && x.day.startsWith(prev)) g.prev += x.subtotal
    if (x.day > g.lastDay) g.lastDay = x.day
    map.set(key, g)
  })
  return [...map.values()].sort((a, b) => b.total - a.total)
}

// ---------------- Sales Growth: hoá đơn bán ra theo khách hàng (MST) ----------------
function renderSalesTab(el, rowsList, r) {
  const sold = rowsList.filter((x) => x.sold && x.counted)
  if (!sold.length) return emptyTab(el, 'Không có hoá đơn bán ra đủ chi tiết trong khoảng đang lọc.')
  const months = monthKeys(r)
  const pair = momPair(months, r)
  const facts = sold.map((x) => ({ month: x.day.slice(0, 7), value: x.subtotal, key: x.partnerTax || x.partnerName }))
  const revenue = sumByMonth(facts)
  const count = sumByMonth(facts.map((f) => ({ ...f, value: 1 })))
  const avg = new Map(months.map((k) => [k, count.get(k) ? (revenue.get(k) || 0) / count.get(k) : 0]))
  const customersByMonth = new Map(months.map((k) => [k, new Set(facts.filter((f) => f.month === k).map((f) => f.key)).size]))
  const total = sold.reduce((s, x) => s + x.subtotal, 0)

  // Khách mới = lần đầu xuất hiện trong khoảng đang xem; tháng đầu tiên vì vậy luôn là "mới".
  const firstMonth = new Map()
  ;[...facts].sort((a, b) => a.month.localeCompare(b.month)).forEach((f) => { if (!firstMonth.has(f.key)) firstMonth.set(f.key, f.month) })
  const series = [
    { label: 'Khách mua lại', color: SERIES_COLORS[0], values: months.map(() => 0) },
    { label: 'Khách mới trong tháng', color: SERIES_COLORS[1], values: months.map(() => 0) }
  ]
  facts.forEach((f) => {
    const i = months.indexOf(f.month)
    if (i >= 0) series[firstMonth.get(f.key) === f.month ? 1 : 0].values[i] += f.value
  })
  const returningShare = total ? series[0].values.reduce((a, b) => a + b, 0) / total : 0
  const customers = partnerTable(sold, pair)

  el.innerHTML = `
    <div class="kpi-row">
      ${kpiTile('<i class="sw sw-in"></i>Doanh thu hoá đơn', formatVnd(total), momSub(revenue, pair))}
      ${kpiTile('Số hoá đơn đầu ra', sold.length.toLocaleString('vi-VN'), momSub(count, pair))}
      ${kpiTile('Giá trị HĐ trung bình', formatVnd(total / sold.length), momSub(avg, pair))}
      ${kpiTile('Khách hàng phát sinh', `${customers.length.toLocaleString('vi-VN')} <small>MST</small>`, momSub(customersByMonth, pair))}
    </div>
    ${chartCard('Doanh thu theo tháng: khách mới và khách mua lại', `Giá trị trước thuế. Khách mua lại đóng góp ${(returningShare * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% doanh thu trong khoảng đang xem.`, series)}
    <div class="card dash-table-card">
      <div class="card-head"><div><h3>Khách hàng lớn nhất</h3><p class="muted">Theo MST người mua. Top-1 chiếm ${(customers[0].total / total * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%, top-5 chiếm ${(customers.slice(0, 5).reduce((s, c) => s + c.total, 0) / total * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%.</p></div></div>
      <div class="dash-table-scroll"><table class="dash-table">
        <thead><tr><th>Khách hàng</th><th class="num">Số HĐ</th><th class="num">Doanh thu</th><th>Tỷ trọng</th><th class="num">${momLabel(pair)}</th><th class="num">HĐ cuối</th></tr></thead>
        <tbody>${customers.slice(0, 10).map((c) => `
          <tr><td><span class="cell-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span><span class="sub mono">${escapeHtml(c.tax || '')}</span></td>
            <td class="num">${c.count}</td><td class="num">${formatVnd(c.total)}</td><td>${shareBar(c.total / total)}</td>
            <td class="num">${deltaHtml(c.prev ? (c.last - c.prev) / c.prev : null)}</td><td class="num">${viDate(c.lastDay)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>`
  renderStackChart(el.querySelector('[data-part="stack"]'), months, series)
}

// ---------------- Product Growth: dòng hàng trên hoá đơn bán ra ----------------
function renderProductTab(el, rowsList, r) {
  const sold = rowsList.filter((x) => x.sold && x.counted)
  const pending = rowsList.filter((x) => x.sold && !x.complete).length
  const facts = []
  sold.forEach((x) => (x.inv.lineItems || []).forEach((li) => {
    if (!li?.itemName) return
    facts.push({ month: x.day.slice(0, 7), key: plain(li.itemName).replace(/\s+/g, ' ').trim(), label: li.itemName, value: Number(li.subtotalAmount) || 0, qty: Number(li.quantity) || 0 })
  }))
  if (!facts.length) return emptyTab(el, 'Không có dòng hàng nào trên hoá đơn bán ra trong khoảng đang lọc.')
  const months = monthKeys(r)
  const pair = momPair(months, r)
  const [last, prev] = pair || []
  const qtyByMonth = sumByMonth(facts, 'qty')
  const total = facts.reduce((s, f) => s + f.value, 0)

  const products = new Map()
  facts.forEach((f) => {
    const p = products.get(f.key) || { label: f.label, qty: 0, total: 0, last: 0, prev: 0 }
    p.qty += f.qty
    p.total += f.value
    if (f.month === last) p.last += f.value
    if (f.month === prev) p.prev += f.value
    products.set(f.key, p)
  })
  const ranked = [...products.values()].sort((a, b) => b.total - a.total)
  const top5Share = total ? ranked.slice(0, 5).reduce((s, p) => s + p.total, 0) / total : 0
  const nameCountByMonth = new Map(months.map((k) => [k, new Set(facts.filter((f) => f.month === k).map((f) => f.key)).size]))
  const series = stackSeries(facts, months)
  const trend = (p) => {
    if (!prev) return ''
    if (!p.prev && p.last) return '<span class="status-chip info">Mới</span>'
    if (!p.prev) return ''
    const d = (p.last - p.prev) / p.prev
    if (d >= 0.3) return '<span class="status-chip ok">Tăng mạnh</span>'
    if (d <= -0.3) return '<span class="status-chip warn">Chững lại</span>'
    return ''
  }

  el.innerHTML = `
    <div class="kpi-row">
      ${kpiTile('Tên hàng khác nhau', ranked.length.toLocaleString('vi-VN'), momSub(nameCountByMonth, pair))}
      ${kpiTile('Sản lượng bán', ranked.reduce((s, p) => s + p.qty, 0).toLocaleString('vi-VN'), momSub(qtyByMonth, pair))}
      ${kpiTile('Tỷ trọng top-5', `${(top5Share * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`, 'Theo doanh thu trước thuế')}
      ${kpiTile('HĐ bán ra chờ chi tiết', pending.toLocaleString('vi-VN'), pending ? 'Chưa có dòng hàng, chưa tính vào đây' : 'Mọi hoá đơn đều đủ dòng hàng')}
    </div>
    ${chartCard('Doanh thu theo sản phẩm', 'Top-5 tên hàng theo doanh thu trước thuế, phần còn lại gộp "Khác". Tên hàng lấy nguyên văn trên hoá đơn, chưa gộp các cách viết khác nhau.', series)}
    <div class="card dash-table-card">
      <div class="card-head"><div><h3>Bán chạy nhất</h3><p class="muted">Xếp theo doanh thu, chưa có biên lợi nhuận: cần ghép với hoá đơn mua vào.</p></div></div>
      <div class="dash-table-scroll"><table class="dash-table">
        <thead><tr><th>Tên hàng</th><th class="num">Số lượng</th><th class="num">Doanh thu</th><th>Tỷ trọng</th><th class="num">${momLabel(pair)}</th><th></th></tr></thead>
        <tbody>${ranked.slice(0, 10).map((p) => `
          <tr><td><span class="cell-name" title="${escapeHtml(p.label)}">${escapeHtml(p.label)}</span></td>
            <td class="num">${p.qty.toLocaleString('vi-VN')}</td><td class="num">${formatVnd(p.total)}</td><td>${shareBar(p.total / total)}</td>
            <td class="num">${deltaHtml(p.prev ? (p.last - p.prev) / p.prev : null)}</td><td>${trend(p)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>`
  renderStackChart(el.querySelector('[data-part="stack"]'), months, series)
}

// ---------------- Expense: hoá đơn mua vào theo nhà cung cấp ----------------
function renderExpenseTab(el, rowsList, r) {
  const bought = rowsList.filter((x) => !x.sold && x.counted)
  const pending = rowsList.filter((x) => !x.sold && !x.complete).length
  if (!bought.length) return emptyTab(el, 'Không có hoá đơn mua vào đủ chi tiết trong khoảng đang lọc.')
  const months = monthKeys(r)
  const pair = momPair(months, r)
  const facts = bought.map((x) => ({ month: x.day.slice(0, 7), key: x.partnerTax || x.partnerName, label: x.partnerName || x.partnerTax, value: x.subtotal, tax: x.tax }))
  const cost = sumByMonth(facts)
  const vatIn = sumByMonth(facts, 'tax')
  const suppliersByMonth = new Map(months.map((k) => [k, new Set(facts.filter((f) => f.month === k).map((f) => f.key)).size]))
  const total = bought.reduce((s, x) => s + x.subtotal, 0)
  const suppliers = partnerTable(bought, pair)
  const series = stackSeries(facts, months)
  const movers = suppliers.filter((s) => s.last - s.prev).sort((a, b) => Math.abs(b.last - b.prev) - Math.abs(a.last - a.prev)).slice(0, 5)
  const goodDown = { goodWhenUp: false }

  el.innerHTML = `
    <div class="kpi-row">
      ${kpiTile('<i class="sw sw-out"></i>Chi phí có hoá đơn', formatVnd(total), momSub(cost, pair, goodDown))}
      ${kpiTile('Thuế GTGT đầu vào', formatVnd(bought.reduce((s, x) => s + x.tax, 0)), momSub(vatIn, pair))}
      ${kpiTile('Nhà cung cấp', `${suppliers.length.toLocaleString('vi-VN')} <small>MST</small>`, momSub(suppliersByMonth, pair, goodDown))}
      ${kpiTile('HĐ mua vào chờ chi tiết', pending.toLocaleString('vi-VN'), pending ? 'Chưa đủ chi tiết, chưa tính vào đây' : 'Mọi hoá đơn đều đủ chi tiết')}
    </div>
    <div class="callout">Chỉ gồm chi phí <b>có hoá đơn</b>. Lương, bảo hiểm và các khoản không xuất hoá đơn không xuất hiện ở đây, nên dùng để phát hiện nhóm tăng bất thường, không thay báo cáo tổng chi phí.</div>
    ${chartCard('Chi phí theo nhà cung cấp', 'Top-5 nhà cung cấp theo chi phí trước thuế, phần còn lại gộp "Khác".', series)}
    <div class="dash-split">
      <div class="card dash-table-card">
        <div class="card-head"><div><h3>Vì sao chi phí thay đổi?</h3><p class="muted">${pair ? `Nhà cung cấp biến động nhiều nhất, ${monthName(pair[0])} so với ${monthName(pair[1])}.` : 'Chọn khoảng ≥ 2 tháng để so sánh.'}</p></div></div>
        ${movers.length && pair ? `<ul class="mini-list">${movers.map((s) => `
          <li><span title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span><span class="num ${s.last > s.prev ? 'neg' : 'pos'}">${formatVnd(s.last - s.prev, { sign: true })}</span></li>`).join('')}</ul>`
          : '<p class="insight-empty">Không có biến động.</p>'}
      </div>
      <div class="card dash-table-card">
        <div class="card-head"><div><h3>Nhà cung cấp lớn nhất</h3><p class="muted">Theo MST người bán.</p></div></div>
        <div class="dash-table-scroll"><table class="dash-table">
          <thead><tr><th>Nhà cung cấp</th><th class="num">Số HĐ</th><th class="num">Chi phí</th><th>Tỷ trọng</th></tr></thead>
          <tbody>${suppliers.slice(0, 8).map((s) => `
            <tr><td><span class="cell-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span><span class="sub mono">${escapeHtml(s.tax || '')}</span></td>
              <td class="num">${s.count}</td><td class="num">${formatVnd(s.total)}</td><td>${shareBar(s.total / total)}</td></tr>`).join('')}
          </tbody></table></div>
      </div>
    </div>`
  renderStackChart(el.querySelector('[data-part="stack"]'), months, series)
}

function renderKpis(root, list) {
  const counted = list.filter((x) => x.counted)
  const sold = counted.filter((x) => x.sold)
  const bought = counted.filter((x) => !x.sold)
  const sum = (arr, field) => arr.reduce((s, x) => s + x[field], 0)
  const vatOut = sum(sold, 'tax')
  const vatIn = sum(bought, 'tax')
  const vatDue = vatOut - vatIn
  const attention = list.filter((x) => x.attention).length

  root.querySelector('[data-part="kpi"]').innerHTML = `
    <div class="kpi kpi-hero">
      <span class="kpi-label">Thuế GTGT tạm tính</span>
      <span class="kpi-value ${vatDue >= 0 ? 'neg' : 'pos'}">${formatVnd(vatDue)}</span>
      <span class="kpi-sub">Đầu ra ${formatCompact(vatOut)} − đầu vào ${formatCompact(vatIn)} · ${vatDue >= 0 ? 'phải nộp' : 'được khấu trừ chuyển kỳ sau'}</span>
    </div>
    <div class="kpi">
      <span class="kpi-label"><i class="sw sw-in"></i>Doanh thu bán ra</span>
      <span class="kpi-value">${formatVnd(sum(sold, 'subtotal'))}</span>
      <span class="kpi-sub">${sold.length.toLocaleString('vi-VN')} hoá đơn · trước thuế</span>
    </div>
    <div class="kpi">
      <span class="kpi-label"><i class="sw sw-out"></i>Chi phí mua vào</span>
      <span class="kpi-value">${formatVnd(sum(bought, 'subtotal'))}</span>
      <span class="kpi-sub">${bought.length.toLocaleString('vi-VN')} hoá đơn · trước thuế</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Cần chú ý</span>
      <span class="kpi-value">${attention.toLocaleString('vi-VN')}</span>
      <span class="kpi-sub">Chưa đủ chi tiết, thay thế, điều chỉnh</span>
    </div>`
}

function buildBuckets(list, r) {
  const days = Math.round((new Date(`${r.to}T00:00:00`) - new Date(`${r.from}T00:00:00`)) / 86400000) + 1
  const monthly = days > 62
  const buckets = new Map()
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
    const key = monthly ? d.slice(0, 7) : d
    if (!buckets.has(key)) buckets.set(key, { key, in: 0, out: 0, count: 0 })
  }
  list.filter((x) => x.counted).forEach((x) => {
    const key = monthly ? x.day.slice(0, 7) : x.day
    if (!buckets.has(key)) buckets.set(key, { key, in: 0, out: 0, count: 0 })
    const b = buckets.get(key)
    if (x.sold) b.in += x.subtotal
    else b.out -= x.subtotal
    b.count++
  })
  return { monthly, list: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) }
}

function niceStep(rangeValue) {
  const raw = rangeValue / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow
}

function bucketLabel(key, monthly) {
  if (monthly) {
    const [y, m] = key.split('-')
    return `${m}/${y}`
  }
  const [, m, d] = key.split('-')
  return `${d}/${m}`
}

function barPath(x, w, y0, y1, r) {
  // Đầu cột bo 4px ở phía dữ liệu, gốc cột vuông ở đường 0.
  const h = Math.abs(y0 - y1)
  const rr = Math.min(r, w / 2, h)
  if (h < 0.5) return ''
  if (y1 < y0) return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`
  return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`
}

function renderChart(root, rowsList, r) {
  const svg = root.querySelector('[data-part="chart"]')
  const wrap = svg.parentElement
  const tip = wrap.querySelector('.chart-tip')
  const { monthly, list } = buildBuckets(rowsList, r)
  root.querySelector('[data-part="grain"]').textContent = monthly ? 'tháng' : 'ngày'

  const width = Math.max(wrap.clientWidth, 280)
  const height = 240
  const m = { top: 14, right: 12, bottom: 28, left: 60 }
  const plotW = width - m.left - m.right
  const plotH = height - m.top - m.bottom

  const maxIn = Math.max(0, ...list.map((b) => b.in))
  const maxOut = Math.max(0, ...list.map((b) => -b.out))
  const step = niceStep(Math.max(maxIn + maxOut, 1))
  const top = Math.max(step, Math.ceil(maxIn / step) * step)
  const bottom = maxOut > 0 ? Math.ceil(maxOut / step) * step : 0
  const y = (v) => m.top + ((top - v) / (top + bottom)) * plotH
  const y0 = y(0)
  const band = plotW / list.length
  const bw = Math.max(2, Math.min(24, band * 0.62))
  const labelEvery = Math.ceil(list.length / Math.max(2, Math.floor(plotW / 64)))

  let grid = ''
  for (let v = -bottom; v <= top + 1e-9; v += step) {
    const yy = Math.round(y(v)) + 0.5
    grid += `<line class="${v === 0 ? 'axis-zero' : 'grid'}" x1="${m.left}" x2="${width - m.right}" y1="${yy}" y2="${yy}"/>
      <text class="tick" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${formatCompact(v)}</text>`
  }
  let bars = ''
  let labels = ''
  list.forEach((b, i) => {
    const cx = m.left + band * i + band / 2
    const x = cx - bw / 2
    bars += `<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${plotH}"/>`
    if (b.in > 0) bars += `<path class="bar-in" d="${barPath(x, bw, y0 - 1, y(b.in), 4)}"/>`
    if (b.out < 0) bars += `<path class="bar-out" d="${barPath(x, bw, y0 + 1, y(b.out), 4)}"/>`
    if (i % labelEvery === 0) labels += `<text class="tick" x="${cx}" y="${height - 8}" text-anchor="middle">${bucketLabel(b.key, monthly)}</text>`
  })

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  svg.innerHTML = `<rect class="hover-band" x="0" y="${m.top}" width="${band}" height="${plotH}" visibility="hidden"/>${grid}${bars}${labels}`
  const hoverBand = svg.querySelector('.hover-band')

  svg.onmousemove = (e) => {
    const target = e.target.closest('.hit')
    if (!target) return
    const i = Number(target.dataset.i)
    const b = list[i]
    hoverBand.setAttribute('x', m.left + band * i)
    hoverBand.setAttribute('visibility', 'visible')
    tip.hidden = false
    tip.innerHTML = `<b>${monthly ? `Tháng ${bucketLabel(b.key, true)}` : viDate(b.key)}</b>
      <div><i class="sw sw-in"></i>Bán ra <span>${formatVnd(b.in)}</span></div>
      <div><i class="sw sw-out"></i>Mua vào <span>${formatVnd(b.out)}</span></div>
      <div class="tip-net">Chênh lệch <span>${formatVnd(b.in + b.out, { sign: true })}</span></div>
      <div class="muted">${b.count} hoá đơn</div>`
    const rect = wrap.getBoundingClientRect()
    const scale = rect.width / width
    let left = (m.left + band * i + band / 2) * scale + 12
    if (left + 200 > rect.width) left -= 224
    tip.style.left = `${Math.max(0, left)}px`
    tip.style.top = `${m.top}px`
  }
  svg.onmouseleave = () => {
    tip.hidden = true
    hoverBand.setAttribute('visibility', 'hidden')
  }
}

function groupByPartner(list) {
  const map = new Map()
  list.forEach((x) => {
    const key = x.partnerTax || x.partnerName
    const g = map.get(key) || { name: x.partnerName || x.partnerTax || '—', total: 0, count: 0 }
    g.total += x.subtotal
    g.count++
    map.set(key, g)
  })
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, 5)
}

function renderInsights(root, list) {
  const counted = list.filter((x) => x.counted)
  const customers = groupByPartner(counted.filter((x) => x.sold))
  const suppliers = groupByPartner(counted.filter((x) => !x.sold))
  const maxCustomer = Math.max(1, ...customers.map((c) => c.total))

  // Thuế theo thuế suất: thuế suất là chuỗi nguyên văn từ GDT ("8%", "10%", "KCT"…), không ép về số.
  const bands = new Map()
  counted.forEach((x) => x.bands.forEach((b) => {
    const g = bands.get(b.taxRate) || { rate: b.taxRate, out: 0, in: 0 }
    if (x.sold) g.out += Number(b.taxAmount) || 0
    else g.in += Number(b.taxAmount) || 0
    bands.set(b.taxRate, g)
  }))
  const bandList = [...bands.values()].sort((a, b) => (parseFloat(b.rate) || -1) - (parseFloat(a.rate) || -1))

  const attention = list.filter((x) => x.attention)
  const countBy = (fn) => attention.filter(fn).length
  const empty = '<p class="insight-empty">Không có hoá đơn trong bộ lọc hiện tại.</p>'

  root.querySelector('[data-part="insights"]').innerHTML = `
    <article class="card insight">
      <h3>Khách hàng lớn nhất</h3>
      <p class="muted">Doanh thu trước thuế theo người mua trên hoá đơn bán ra. Biết ngay ai đóng góp nhiều nhất, không cần chờ kế toán tổng hợp.</p>
      ${customers.length ? `<ul class="cat-list">${customers.map((c) => `
        <li>
          <div class="cat-row"><span>${escapeHtml(c.name)} <span class="muted">· ${c.count}</span></span><span class="num">${formatVnd(c.total)}</span></div>
          <div class="cat-track"><div class="cat-fill in" style="width:${(c.total / maxCustomer) * 100}%"></div></div>
        </li>`).join('')}</ul>` : empty}
    </article>
    <article class="card insight">
      <h3>Nhà cung cấp chính</h3>
      <p class="muted">Chi phí mua vào theo người bán. Đối chiếu với đơn đặt hàng và công nợ phải trả.</p>
      ${suppliers.length ? `<ul class="mini-list">${suppliers.map((s) => `
        <li><span title="${escapeHtml(s.name)}">${escapeHtml(s.name)} <span class="muted">· ${s.count} HĐ</span></span><span class="num">${formatVnd(s.total)}</span></li>`).join('')}</ul>` : empty}
    </article>
    <article class="card insight">
      <h3>Thuế GTGT theo thuế suất</h3>
      <p class="muted">Tách đầu ra, đầu vào theo từng thuế suất để lập tờ khai. Không chịu thuế (KCT) được kê riêng.</p>
      ${bandList.length ? `<ul class="mini-list">${bandList.map((b) => `
        <li><span><b>${escapeHtml(b.rate)}</b> <span class="muted">· ra ${formatCompact(b.out)} · vào ${formatCompact(b.in)}</span></span><span class="num">${formatVnd(b.out - b.in, { sign: true })}</span></li>`).join('')}</ul>` : empty}
    </article>
    <article class="card insight">
      <h3>Hoá đơn cần chú ý</h3>
      <p class="muted">Hoá đơn chưa đủ chi tiết chưa nên ghi sổ. Hoá đơn thay thế tự loại hoá đơn gốc khỏi tổng để không cộng trùng doanh thu.</p>
      ${attention.length
        ? `<p class="insight-big">${attention.length.toLocaleString('vi-VN')} <span>hoá đơn · ${countBy((x) => !x.complete)} chưa đủ chi tiết · ${countBy((x) => x.superseded)} bị thay thế · ${countBy((x) => x.complete && x.nature === 3)} điều chỉnh</span></p>
           <ul class="mini-list">${attention.slice(0, 3).map((x) => `<li><span><span class="order-code">${escapeHtml(x.number)}</span> ${escapeHtml(viDate(x.day))}</span><span class="status-chip ${x.status.kind}">${escapeHtml(x.status.label)}</span></li>`).join('')}</ul>`
        : '<p class="insight-empty">Mọi hoá đơn đều đủ chi tiết.</p>'}
    </article>`
}

// ------------------------------------------------------------------
// Environment & credentials
// ------------------------------------------------------------------
function renderEnv() {
  document.querySelectorAll('.env-option').forEach((btn) => {
    const active = btn.dataset.env === state.env
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-checked', active)
  })
  const mockNote = state.config?.mock ? '<p><b>Casso giả lập</b> (<code>npm run mock</code>): key điền sẵn, Cas Link là trang giả, không gọi Casso thật.</p>' : ''
  $('envNote').innerHTML = mockNote + (state.env === 'sandbox'
    ? '<p>Dùng key của <b>tổ chức sandbox</b>. Đăng nhập Cas Link bằng tài khoản thuế thử nghiệm của tổ chức sandbox.</p>'
    : '<p>Kết nối <b>tài khoản thuế thật</b>, hoá đơn thật. Dùng key của tổ chức thật.</p>')
  renderCredFields()
}

// Redirect URI / Webhook URL theo domain đang chạy (ngrok hoặc server thật) để khách copy vào Casso Console.
function renderConsoleSetup() {
  const cfg = state.config || {}
  // Không có PUBLIC_BASE_URL thì suy từ URL trang để giữ sub-path (VD /demo-api-gdt).
  const base = cfg.publicBaseUrl || new URL('.', window.location.href).href.replace(/\/+$/, '')
  $('callbackUrl').textContent = `${base}/casso/callback`
  $('webhookUrl').textContent = `${base}/casso/webhook`
  const host = new URL(base).hostname
  const isLocal = ['localhost', '127.0.0.1', '0.0.0.0'].includes(host) && !cfg.mock
  const warn = $('localhostWarn')
  warn.hidden = !isLocal
  if (isLocal) {
    warn.innerHTML = `${ICONS.alert}<span>Đang chạy trên <b>${escapeHtml(host)}</b> — Casso không chuyển hướng về được địa chỉ này nên Cas Link sẽ không trả publicToken.
      Chạy <code>npm run tunnel</code> rồi mở demo bằng URL ngrok; 2 URL phía trên sẽ tự đổi theo domain ngrok.</span>`
  }
  if (cfg.githubUrl) $('githubLink').href = cfg.githubUrl
}

function setEnv(env) {
  if (env === state.env) return
  const hasProgress = state.accessToken || state.real || Object.keys(state.results).length
  if (hasProgress && !confirm('Đổi môi trường sẽ xoá key, token và kết quả hiện tại (không dùng chéo giữa sandbox và production). Tiếp tục?')) return
  state.env = env
  sessionSet('casso_env', env)
  resetFlow()
  renderEnv()
  toast(`Đã chuyển sang ${envLabel()}`)
}

function resetFlow() {
  Object.assign(state, { accessToken: '', results: {}, activeCall: {}, real: null, heroSource: 'sample' })
  state.cred = state.config?.mock ? { clientId: 'mock-client', secretKey: 'mock-secret' } : { clientId: '', secretKey: '' }
  ;['tokenResult', 'invResult', 'claimResult', 'linkResult'].forEach((id) => { $(id).hidden = true })
  ;['invToken', 'claimLinkId', 'manualPublicToken'].forEach((id) => { $(id).value = '' })
  setupLinkFlow()
  closeResult()
  renderStatement()
  renderHero()
  Object.keys(PANELS).forEach(renderApiPanel)
  renderProgress()
  // Dự phòng khi Casso chuyển cả trang về /casso/callback: publicToken quay lại qua ?publicToken=.
  const params = new URLSearchParams(window.location.search)
  const publicToken = params.get('publicToken')
  if (publicToken) {
    history.replaceState(null, '', window.location.pathname + window.location.hash)
    setMethod('caslink')
    $('manualPublicToken').value = publicToken
    toast('Đã nhận publicToken — nhập key rồi bấm dùng publicToken để lấy accessToken', 'success')
  }
}

function renderCredFields() {
  const envName = state.env === 'sandbox' ? 'sandbox' : 'thật (production)'
  document.querySelectorAll('[data-cred-group]').forEach((group) => {
    group.innerHTML = `
      <div class="field-row">
        <label class="field"><span>Client ID <em>(x-client-id)</em></span>
          <input type="text" data-cred="clientId" value="${escapeHtml(state.cred.clientId)}" placeholder="Client ID" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>Client secret <em>(x-secret-key)</em></span>
          <span class="secret-wrap">
            <input type="password" data-cred="secretKey" value="${escapeHtml(state.cred.secretKey)}" placeholder="Client secret" autocomplete="off" spellcheck="false">
            <button type="button" class="secret-toggle" aria-label="Hiện / ẩn secret">Hiện</button>
          </span></label>
      </div>
      <p class="hint">Key của tổ chức ${envName}, lấy ở Casso Console → API Credential. Chỉ gửi tới server demo để gọi Casso, không lưu lại.</p>`
  })
}

// ------------------------------------------------------------------
// Tiến độ 3 bước
// ------------------------------------------------------------------
function renderProgress() {
  const done = { 1: Boolean(state.accessToken), 2: Boolean(state.real), 3: false }
  const current = !done[1] ? 1 : !done[2] ? 2 : 3
  document.querySelectorAll('.step-card').forEach((card) => {
    const n = Number(card.dataset.step)
    // Bước 2 luôn mở để CTO có sẵn token nhảy thẳng tới gọi API; bước 3 cần dữ liệu thật.
    const locked = n === 3 && !state.real
    card.classList.toggle('done', done[n])
    card.classList.toggle('current', n === current && !locked)
    card.classList.toggle('locked', locked)
    const status = card.querySelector('.step-status')
    if (status) status.innerHTML = done[n] ? `${ICONS.check} Xong` : n === current ? 'Đang làm' : ''
  })
  $('btnOpenDashboard').disabled = !state.real
}

function scrollToStep(n) {
  $(`step${n}`).scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ------------------------------------------------------------------
// API console panel
// ------------------------------------------------------------------
function buildRequestPreview(key) {
  const call = CALLS[key]
  // Call của link-flow: hiện đúng request đã gửi (server đã che secret và token).
  const sent = call.kit && state.results[key]?.request
  if (sent) return { method: sent.method, url: sent.url, headers: sent.headers, body: sent.body || null, token: '' }

  const cfg = envConfig()
  const query = call.query ? call.query() : null
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString() : ''
  const url = `${cfg.baseUrl || ''}${call.path}${qs ? `?${qs}` : ''}`
  const headers = {
    'x-client-id': state.cred.clientId || '<client-id>',
    'x-secret-key': state.cred.secretKey ? '••••••••' : '<secret-key>'
  }
  const token = call.token ? (call.kit ? state.accessToken : val('invToken')) : ''
  if (call.token) headers.Authorization = token || '<accessToken>'
  const body = call.body ? call.body() : null
  if (body) headers['Content-Type'] = 'application/json'
  return { method: call.method, url, headers, body, token }
}

function curlFor(key) {
  const p = buildRequestPreview(key)
  const sq = (v) => String(v).replace(/'/g, `'\\''`)
  const lines = [`curl --location --request ${p.method} '${sq(p.url)}'`]
  lines.push(`  --header 'x-client-id: ${sq(state.cred.clientId || '<client-id>')}'`)
  lines.push(`  --header 'x-secret-key: <secret-key>'`)
  if (p.headers.Authorization) lines.push(`  --header 'Authorization: ${sq(p.token || state.accessToken || '<accessToken>')}'`)
  if (p.body) {
    lines.push(`  --header 'Content-Type: application/json'`)
    lines.push(`  --data '${sq(JSON.stringify(p.body))}'`)
  }
  return lines.join(' \\\n')
}

function highlightJson(obj) {
  const json = escapeHtml(JSON.stringify(obj, null, 2))
  return json.replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, (match, str, colon, literal) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`
    if (literal) return `<span class="j-lit">${match}</span>`
    return `<span class="j-num">${match}</span>`
  })
}

// Response hoá đơn thật nặng vài MB (lineItems, qrCode của từng hoá đơn): tô màu nguyên văn sẽ treo trình duyệt.
// Chỉ hiển thị bản rút gọn; "Copy JSON" vẫn lấy response đầy đủ.
const PREVIEW_ITEMS = 3
const PREVIEW_CHARS = 120

function previewData(value) {
  if (Array.isArray(value)) {
    const head = value.slice(0, PREVIEW_ITEMS).map(previewData)
    const rest = value.length - head.length
    return rest > 0 ? [...head, `… còn ${rest.toLocaleString('vi-VN')} phần tử (rút gọn để hiển thị — Copy JSON lấy đủ)`] : head
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, previewData(v)]))
  }
  if (typeof value === 'string' && value.length > PREVIEW_CHARS) return `${value.slice(0, PREVIEW_CHARS)}…`
  return value
}

// grant/claim luôn trả 200 — lỗi nằm trong results[].ok, nên cần kiểm tra riêng.
function callFailed(key) {
  if (key !== 'claim') return false
  const first = state.results.claim?.data?.results?.[0]
  return !first || !first.ok
}
function callFailedError(key) {
  if (!callFailed(key) || !state.results[key]?.ok) return null
  const first = state.results.claim?.data?.results?.[0]
  return { errorCode: first?.error || 'NOT_FOUND', errorMessage: 'Claim không thành công cho link_id này.' }
}

function renderApiPanel(panelId) {
  const el = $(panelId)
  if (!el) return
  const keys = PANELS[panelId]
  const active = state.activeCall[panelId] || keys[0]
  const preview = buildRequestPreview(active)
  const result = state.results[active]

  const tabs = keys.length > 1
    ? `<div class="api-tabs" role="tablist">${keys.map((k) => `
        <button class="api-tab ${k === active ? 'active' : ''}" role="tab" aria-selected="${k === active}" data-panel="${panelId}" data-call="${k}">
          <span class="api-tab-dot ${state.results[k] ? (state.results[k].ok && !callFailed(k) ? 'ok' : 'err') : ''}"></span>${CALLS[k].label}
        </button>`).join('')}</div>`
    : ''

  const headerLines = Object.entries(preview.headers).map(([h, v]) => `<span class="h-name">${escapeHtml(h)}:</span> ${escapeHtml(v)}`).join('\n')
  const requestHtml = `<span class="h-method m-${preview.method.toLowerCase()}">${preview.method}</span> ${escapeHtml(preview.url)}\n${headerLines}${preview.body ? `\n\n${highlightJson(preview.body)}` : ''}`

  let responseHtml
  if (!result) {
    responseHtml = `<div class="api-empty">Chưa gọi. ${CALLS[active].kit ? 'Card liên kết bên trái gọi API này khi cần.' : 'Nhấn nút bên trái để xem response thật từ Casso Console.'}</div>`
  } else {
    const err = errorOf(result) || callFailedError(active)
    const statusClass = result.ok && !callFailed(active) ? 'ok' : 'err'
    const hint = err ? (ERROR_HINTS[err.errorCode] || '') : ''
    responseHtml = `
      <div class="api-status">
        <span class="status-pill ${statusClass}">${result.status || 'ERR'}</span>
        ${result.latencyMs != null ? `<span class="muted">${result.latencyMs} ms</span>` : ''}
      </div>
      ${err ? `<div class="api-error"><b>${escapeHtml(err.errorCode || 'Lỗi')}</b>${err.errorMessage ? ` — ${escapeHtml(err.errorMessage)}` : ''}${err.detail ? `<br><span class="muted">${escapeHtml(err.detail)}</span>` : ''}${hint ? `<p>${escapeHtml(hint)}</p>` : ''}</div>` : ''}
      <pre class="code">${result.responseHtml}</pre>`
  }

  el.innerHTML = `
    <div class="api-panel-head">
      <span class="api-title"><span class="api-dots" aria-hidden="true"><i></i><i></i><i></i></span>API console</span>
      <span class="muted">Request thật, gọi từ server của bạn</span>
    </div>
    ${tabs}
    <div class="api-section">
      <div class="api-section-head"><span>Request</span><button class="btn-link" data-curl="${active}">Copy cURL</button></div>
      <pre class="code">${requestHtml}</pre>
    </div>
    <div class="api-section">
      <div class="api-section-head"><span>Response</span>${result ? `<button class="btn-link" data-copy-json="${active}">Copy JSON</button>` : ''}</div>
      ${responseHtml}
    </div>`
}

function recordResult(key, payload) {
  // Tô màu một lần khi nhận response; panel vẽ lại theo từng phím gõ chỉ đọc lại HTML này.
  payload.responseHtml = highlightJson(previewData(payload.data))
  state.results[key] = payload
  state.activeCall[panelOf(key)] = key
  renderApiPanel(panelOf(key))
}

// ------------------------------------------------------------------
// Bước 1: liên kết tài khoản thuế → accessToken
// Logic (grant/token, widget Cas Link, exchange, claim, identity, đăng nhập lại) nằm trong createLinkFlow
// của link-flow.js; phần này chỉ vẽ UI theo khung api-transaction và đẩy từng call vào API console.
// ------------------------------------------------------------------
function setupLinkFlow() {
  state.flow?.destroy()
  const client = createCassoClient({
    baseUrl: './api/casso',
    getEnv: () => state.env,
    getCredentials: () => state.cred,
    getWidgetUrl: () => envConfig().widgetScriptUrl,
    onApiCall: ({ name, payload }) => {
      if (CALLS[name]) recordResult(name, payload)
      if (state.qlLinking) qlTrack(name, payload)
    }
  })
  state.flow = createLinkFlow({
    client,
    onLinked: ({ accessToken, identity }) => {
      onAccessToken(accessToken, identity)
    },
    onUnlinked: () => {
      state.accessToken = ''
      $('invToken').value = ''
      $('tokenResult').hidden = true
      renderProgress()
    }
  })
  state.flow.subscribe((fs) => {
    renderLinkFlow(fs)
    if (state.qlLinking) qlOnFlow(fs)
  })
}

function setMethod(method) {
  state.method = method
  document.querySelectorAll('.method-tab').forEach((tab) => {
    const active = tab.dataset.method === method
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', active)
  })
  $('panelClaim').hidden = method !== 'claim'
  $('panelCasLink').hidden = method !== 'caslink'
  renderLinkFlow(state.flow.getState())
}

// Tiến độ a/b/c của tab Cas Link, suy từ trạng thái của flow.
function casLinkProgress(fs) {
  if (fs.status === 'linked') return 4
  if (['exchanging', 'identity-pending'].includes(fs.status)) return 3
  if (fs.status === 'waiting-user') return 2
  return 1
}

function renderLinkFlow(fs) {
  const current = casLinkProgress(fs)
  document.querySelectorAll('[data-lstep]').forEach((li) => {
    const n = Number(li.dataset.lstep)
    li.classList.toggle('done', n < current)
    li.classList.toggle('current', n === current)
    li.classList.toggle('locked', n > current)
  })
  const btnLink = $('btnLink')
  btnLink.disabled = fs.busy || fs.status === 'waiting-user'
  btnLink.textContent = fs.busy ? 'Đang gọi…' : fs.status === 'waiting-user' ? 'Đang chờ đăng nhập trong Cas Link…'
    : fs.status === 'needs-relogin' ? 'Đăng nhập lại tài khoản thuế' : 'Liên kết tài khoản thuế'
  $('btnClaim').disabled = fs.busy
  $('btnClaim').textContent = fs.busy && state.method === 'claim' ? 'Đang gọi…' : 'Lấy accessToken'

  // Kết quả inline hiện ở tab đang mở; tab kia ẩn.
  const id = state.method === 'claim' ? 'claimResult' : 'linkResult'
  $(state.method === 'claim' ? 'linkResult' : 'claimResult').hidden = true
  if (fs.error && ['error', 'needs-relogin'].includes(fs.status)) {
    const action = fs.status === 'needs-relogin' && state.method === 'claim'
      ? ' <button class="btn btn-secondary btn-sm" data-method="caslink">Sang tab Cas Link để đăng nhập lại</button>' : ''
    showResult(id, fs.status === 'needs-relogin' ? 'warn' : 'err', `${ICONS.alert}<span><b>${escapeHtml(fs.error.code || 'Lỗi')}</b> — ${escapeHtml(ERROR_HINTS[fs.error.code] || fs.error.message)}${action}</span>`)
  } else if (fs.status === 'identity-pending') {
    showResult(id, 'warn', `${ICONS.alert}<span>Đã có accessToken, Casso đang xác minh tổ chức. Tự kiểm tra lại <code>identity</code> sau mỗi 15 giây.</span>`)
  } else if (fs.status === 'waiting-user') {
    showResult(id, 'warn', `${ICONS.alert}<span>Đang chờ đăng nhập trong cửa sổ Cas Link. Đóng Cas Link thì bấm lại nút để mở lại.</span>`)
  } else {
    $(id).hidden = true
  }
}

function doClaim() {
  if (!hasCred()) return promptCred()
  const linkId = val('claimLinkId')
  if (!linkId) return toast('Dán link_id từ Casso Console trước', 'error')
  state.flow.claim(linkId)
}

function doLink() {
  if (!hasCred()) return promptCred()
  if (state.flow.getState().status === 'needs-relogin') state.flow.relogin()
  else state.flow.link()
}

function doManualPublicToken() {
  if (!hasCred()) return promptCred()
  const token = val('manualPublicToken')
  if (!token) return toast('Dán publicToken trước', 'error')
  state.flow.submitPublicToken(token)
}

function onAccessToken(token, identity) {
  state.accessToken = token
  $('invToken').value = token
  renderApiPanel('apiInv')
  const company = identity?.company || identity?.accounts?.[0] || {}
  const el = $('tokenResult')
  el.hidden = false
  el.innerHTML = `
    <div class="token-result-head"><span class="ok-dot">${ICONS.check}</span><b>Đã nhận accessToken</b>
      ${company.name || company.taxCode ? `<span class="muted">${escapeHtml(company.name || '')}${company.taxCode ? ` · MST ${escapeHtml(company.taxCode)}` : ''}</span>` : ''}</div>
    <div class="copy-field">
      <code>${escapeHtml(token)}</code>
      <button class="btn btn-ghost btn-sm" data-copy="${escapeHtml(token)}" data-copy-label="accessToken">Copy</button>
    </div>
    <div class="step-foot-actions">
      <button class="btn btn-primary" data-scroll-step="2">Tiếp tục bước 2: Gọi API ↓</button>
      <button class="btn btn-ghost" data-unlink>Gỡ liên kết (grant/remove)</button>
    </div>`
  renderProgress()
  toast('Đã nhận accessToken', 'success')
}

// ------------------------------------------------------------------
// Bước 2: gọi API (sync-status → invoices/stored)
// ------------------------------------------------------------------
function invQuery() {
  return { fromDate: val('invFrom'), toDate: val('invTo'), invoiceType: val('invType') }
}

function setRange(months) {
  $('invFrom').value = monthStart(months - 1)
  $('invTo').value = isoDate(new Date())
  document.querySelectorAll('#quickRanges button').forEach((b) => b.classList.toggle('active', Number(b.dataset.months) === months))
  renderApiPanel('apiInv')
}

function syncLine(sync) {
  if (!sync.ok) return `sync-status lỗi (${escapeHtml(errorOf(sync)?.errorCode || sync.status)}).`
  const d = sync.data || {}
  const first = d.sync?.firstSync
  const progress = first ? ` · lần đầu ${first.percent ?? '…'}% (${first.synced}/${first.total})` : ''
  const relogin = d.taxAccount?.status === 'needs_relogin' ? ` · cần đăng nhập lại: ${escapeHtml(d.taxAccount.message || d.taxAccount.actionRequired || '')}` : ''
  return `Tài khoản thuế <b>${escapeHtml(d.taxAccount?.status || '—')}</b> · đồng bộ <b>${escapeHtml(d.sync?.state || '—')}</b>${progress}${relogin}`
}

// Dùng chung cho nút ở bước 2 và hộp thoại liên kết nhanh. Trả { ok, payload, empty }; scroll: false khi gọi từ hộp thoại.
async function doFetch({ scroll = true } = {}) {
  const token = val('invToken')
  const query = invQuery()
  const invalid = !token ? 'Cần accessToken từ bước 1' : !query.fromDate || !query.toDate ? 'Chọn khoảng thời gian'
    : query.fromDate > query.toDate ? 'Ngày bắt đầu phải trước ngày kết thúc' : null
  if (invalid) {
    toast(invalid, 'error')
    return { ok: false, payload: { data: { error: { errorCode: 'DEMO_MISSING_INPUT', errorMessage: invalid } } } }
  }

  const btn = $('btnFetch')
  setBusy(btn, true, 'Đang kiểm tra đồng bộ…')
  const sync = await api('./api/gdt/sync-status', { token })
  if (sync.missingKeys) {
    setBusy(btn, false)
    return { ok: false, payload: sync }
  }
  recordResult('syncStatus', sync)

  btn.textContent = 'Đang lấy hoá đơn…'
  let qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString()
  let payload = await api(`./api/gdt/invoices?${qs}`, { token })
  // Tổ chức mới liên kết chỉ có dữ liệu từ ngày đồng bộ đầu: lùi fromDate về ngày detail báo rồi gọi lại 1 lần.
  let clampedFrom = null
  const floor = errorOf(payload)?.errorCode === 'LOOKBACK_EXCEEDED' && /\d{4}-\d{2}-\d{2}/.exec(errorOf(payload).detail || '')?.[0]
  if (floor && floor > query.fromDate && floor <= query.toDate) {
    recordResult('invoices', payload)
    clampedFrom = query.fromDate
    query.fromDate = floor
    $('invFrom').value = floor
    qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString()
    payload = await api(`./api/gdt/invoices?${qs}`, { token })
  }
  setBusy(btn, false)
  recordResult('invoices', payload)

  const invoices = payload.data?.gdtInvoices
  if (!payload.ok || !Array.isArray(invoices)) {
    showResult('invResult', 'err', errorLine(payload))
    return { ok: false, payload }
  }

  const { coverage, quota } = payload.data
  const notes = [
    clampedFrom ? `Tổ chức chỉ có dữ liệu từ ${viDate(query.fromDate)} nên đã gọi lại với fromDate=${escapeHtml(query.fromDate)} (thay vì ${escapeHtml(clampedFrom)}).` : '',
    syncLine(sync),
    coverage ? `Coverage <b>${escapeHtml(coverage.status)}</b> từ ${viDate(coverage.syncedFrom)}${COVERAGE_HINTS[coverage.status] ? ` — ${escapeHtml(COVERAGE_HINTS[coverage.status])}` : ''}` : '',
    quota ? `Quota còn ${Number(quota.remaining).toLocaleString('vi-VN')}/${Number(quota.limit).toLocaleString('vi-VN')} · call này tính ${Number(quota.newlyCharged || 0).toLocaleString('vi-VN')}` : '',
    errorOf(payload)?.errorCode === 'LIMIT_REACHED' ? `⚠ ${escapeHtml(ERROR_HINTS.LIMIT_REACHED)}` : ''
  ].filter(Boolean).map((n) => `<br><span class="muted">${n}</span>`).join('')

  if (!invoices.length) {
    showResult('invResult', 'warn', `${ICONS.alert}<span>API trả về <b>0 hoá đơn</b> từ ${viDate(query.fromDate)} đến ${viDate(query.toDate)}. Thử mở rộng khoảng thời gian.${notes}</span>`)
    return { ok: false, empty: true, payload }
  }
  state.real = { invoices, query, coverage, isSample: false }
  state.heroSource = 'real'
  showResult('invResult', 'ok', `${ICONS.check}<span>Nhận <b>${invoices.length.toLocaleString('vi-VN')} hoá đơn thật</b>.${notes}
    <br><button class="btn btn-primary btn-sm" data-scroll-step="3">Xem bảng kê ↓</button></span>`)
  renderProgress()
  renderStatement()
  if (scroll) scrollToStep(3)
  // Hero chỉ là phần trình diễn: lỗi ở đây không được chặn bảng kê và luồng chính.
  try {
    renderHero()
  } catch (err) {
    console.error('[demo] Không vẽ được hero với dữ liệu thật', err)
    state.heroSource = 'sample'
    renderHero()
  }
  return { ok: true, payload }
}

// ------------------------------------------------------------------
// Hero, bảng kê bước 3, dashboard dữ liệu thật
// ------------------------------------------------------------------
let heroLedger
let statementLedger
let fullLedger
const SAMPLE = buildSampleDataset()

// Tab "Dữ liệu minh hoạ" luôn có dữ liệu mẫu; tab "Dữ liệu thật" chưa có dữ liệu thì hiện empty state + nút liên kết.
function renderHero() {
  const wantReal = state.heroSource === 'real'
  const badge = $('heroBadge')
  badge.className = `data-badge ${wantReal ? (state.real ? 'real' : 'empty') : 'sample'}`
  badge.textContent = !wantReal
    ? '● Dữ liệu minh hoạ · chưa phải dữ liệu của bạn'
    : state.real ? `● Dữ liệu thật · ${envLabel()}` : 'Chưa có dữ liệu thật'
  $('heroSource').querySelectorAll('.seg-btn').forEach((b) => {
    const active = b.dataset.source === state.heroSource
    b.classList.toggle('active', active)
    b.setAttribute('aria-selected', active)
  })
  $('btnQuickLinkLabel').textContent = !wantReal
    ? 'Thử với tài khoản demo · Sandbox'
    : state.real ? `Lấy lại hoá đơn · ${envLabel()}` : 'Liên kết tài khoản thuế thật · Production'

  if (wantReal && !state.real) {
    heroLedger.dataset = null
    $('heroLedger').innerHTML = `
      <div class="hero-empty">
        <span class="hero-empty-icon"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg></span>
        <h3>Chưa có dữ liệu thật</h3>
        <p class="muted">Liên kết tài khoản thuế của doanh nghiệp bằng Cas Link. Hoá đơn bán ra và mua vào sẽ hiện ngay tại dashboard này.</p>
        <div class="hero-empty-actions">
          <button class="btn btn-primary" data-quick-link>Liên kết tài khoản thuế thật · Production</button>
          <a class="btn btn-ghost" href="#try">Hoặc làm từng bước ↓</a>
        </div>
      </div>`
    return
  }
  heroLedger.setData(wantReal ? state.real : SAMPLE)
}

function realMeta() {
  const { query, invoices } = state.real
  return `${invoices.length.toLocaleString('vi-VN')} hoá đơn thật từ <code>GET /proxy/gdt/invoices/stored</code> · ${viDate(query.fromDate)} → ${viDate(query.toDate)} · ${envLabel()}`
}

function renderStatement() {
  const root = $('statementLedger')
  if (!state.real) {
    $('statementMeta').textContent = 'Response của API, trình bày thành bảng kê để kế toán dùng ngay.'
    root.innerHTML = '<div class="statement-empty">Bảng kê hiện ở đây sau khi gọi API thành công ở bước 2.</div>'
    statementLedger.dataset = null
    return
  }
  $('statementMeta').innerHTML = realMeta()
  statementLedger.setData(state.real)
}

function openResult() {
  if (!state.real) return
  $('resultBadge').textContent = `● Dữ liệu thật · ${envLabel()}`
  $('resultMeta').innerHTML = `${realMeta()}. Không lưu database — tải lại trang là mất.`
  $('resultOverlay').hidden = false
  document.body.classList.add('overlay-open')
  fullLedger.setData(state.real)
  $('btnCloseResult').focus()
}

function closeResult() {
  $('resultOverlay').hidden = true
  document.body.classList.remove('overlay-open')
}

// ------------------------------------------------------------------
// Liên kết nhanh tài khoản thuế từ dashboard hero
// Tab hero quyết định môi trường: minh hoạ → sandbox, thật → production. Liên kết chạy bằng cùng máy trạng thái
// của link-flow.js (state.flow) và cùng api()/recordResult(), nên step card và API console bên dưới cập nhật theo.
// ------------------------------------------------------------------
const QL_STEPS = ['conn', 'token', 'login', 'exchange', 'fetch']

function openQuickLink() {
  const source = state.heroSource
  // Tab thật đã có dữ liệu (kể cả lấy bằng sandbox) thì giữ môi trường đang dùng để không xoá mất dữ liệu đó.
  const env = source === 'real' ? (state.real ? state.env : 'production') : 'sandbox'
  if (env !== state.env) {
    setEnv(env)
    if (state.env !== env) return // khách huỷ đổi môi trường
    state.heroSource = source
    renderHero()
  }
  const isSandbox = env === 'sandbox'
  $('qlEnv').className = `env-pill ${env}`
  $('qlEnv').textContent = isSandbox ? 'Sandbox · tài khoản demo' : 'Production · tài khoản thuế thật'
  $('qlTitle').textContent = isSandbox ? 'Thử với tài khoản demo' : 'Liên kết tài khoản thuế thật'
  $('qlSubtitle').innerHTML = isSandbox
    ? 'Dùng key của <b>tổ chức sandbox</b>. Trong Cas Link, đăng nhập bằng tài khoản thuế thử nghiệm của tổ chức sandbox.'
    : 'Dùng key của <b>tổ chức thật</b>. Trong Cas Link, đăng nhập bằng tài khoản thuế doanh nghiệp (cổng hoá đơn điện tử).'
  $('qlTaxNote').innerHTML = 'Tổ chức đã có kết nối hoá đơn điện tử thì dùng lại luôn, không mở Cas Link. Nếu chưa, Cas Link sẽ mở ngay trên trang để đăng nhập tài khoản thuế.'
  $('qlLocalWarn').innerHTML = $('localhostWarn').innerHTML
  // Đã có accessToken (từ bước 1 hoặc lần trước) thì vào thẳng bước chọn khoảng thời gian.
  setQlPhase(state.accessToken ? 'range' : 'link')
  setQlMode('cas')
  if (state.accessToken) {
    qlShowLinked(state.flow.getState(), 'Đang dùng kết nối đã liên kết trước đó. Muốn đổi kết nối thì bấm "← Liên kết lại".')
    QL_STEPS.slice(0, 4).forEach((k) => qlStep(k, 'done'))
    $('qlProgress').hidden = true
  }
  $('quickLinkModal').hidden = false
  document.body.classList.add('overlay-open')
  const firstEmpty = [...$('quickLinkModal').querySelectorAll('[data-cred]')].find((i) => !i.value && !i.closest('[hidden]'))
  ;(firstEmpty || $('qlStart')).focus()
}

function closeQuickLink() {
  if ($('qlStart').getAttribute('aria-busy')) return
  $('quickLinkModal').hidden = true
  if ($('resultOverlay').hidden) document.body.classList.remove('overlay-open')
}

// Giai đoạn 'link': key → liên kết tài khoản thuế. Giai đoạn 'range': đã có accessToken → chọn khoảng ngày → lấy hoá đơn.
function setQlPhase(phase) {
  state.qlPhase = phase
  const linking = phase === 'link'
  $('qlSecKeys').hidden = !linking
  $('qlSecTax').hidden = !linking
  $('qlSecRange').hidden = linking
  $('qlRelink').hidden = linking
  $('qlStart').textContent = linking ? qlStartLabel() : 'Lấy hoá đơn'
  if (!linking) $('qlLocalWarn').hidden = true
  $('qlResult').hidden = true
  if (linking) {
    QL_STEPS.forEach((k) => qlStep(k, ''))
    $('qlProgress').hidden = true
  } else {
    $('qlType').value = val('invType')
    if (!val('qlFrom') || !val('qlTo')) setQlRange(3)
    else setQlRange(null)
  }
}

function qlLinkLabel() {
  return state.flow?.getState().status === 'needs-relogin' ? 'Đăng nhập lại tài khoản thuế' : 'Liên kết tài khoản thuế'
}

function qlStartLabel() {
  return state.qlMode === 'account' ? 'Dùng account_id này' : qlLinkLabel()
}

// Hai cách trong hộp thoại: 'account' = account_id có sẵn (grant/claim, không mở Cas Link, không cần localhost) | 'cas' = liên kết mới qua Cas Link.
function setQlMode(mode) {
  state.qlMode = mode
  document.querySelectorAll('[data-qlmode]').forEach((b) => {
    const active = b.dataset.qlmode === mode
    b.classList.toggle('active', active)
    b.setAttribute('aria-checked', active)
  })
  const account = mode === 'account'
  $('qlAccountBox').hidden = !account
  document.querySelector('#qlSecTax .ql-tax').hidden = account
  $('qlLocalWarn').hidden = account || state.qlPhase !== 'link' || $('localhostWarn').hidden
  if (state.qlPhase === 'link') $('qlStart').textContent = qlStartLabel()
}

function setQlRange(months) {
  if (months) {
    $('qlFrom').value = monthStart(months - 1)
    $('qlTo').value = isoDate(new Date())
  }
  document.querySelectorAll('#qlRanges button').forEach((b) => b.classList.toggle('active', b.dataset.qlmonths === String(months)))
}

function qlStep(key, status, note) {
  $('qlProgress').hidden = false
  const li = $('qlProgress').querySelector(`[data-qlstep="${key}"]`)
  li.className = status
  li.dataset.note = note || ''
}

function qlStatus(key) {
  return $('qlProgress').querySelector(`[data-qlstep="${key}"]`).className
}

function qlShowError(html) {
  const out = $('qlResult')
  out.hidden = false
  out.className = 'inline-result err'
  out.innerHTML = html
}

function qlShowLinked(fs, note) {
  const company = fs.identity?.company || fs.identity?.accounts?.[0] || {}
  const who = company.name ? `${escapeHtml(company.name)}${company.taxCode ? ` · MST ${escapeHtml(company.taxCode)}` : ''}` : ''
  $('qlLinked').innerHTML = `
    <span class="ok-dot">${ICONS.check}</span>
    <div><b>Đã liên kết tài khoản thuế${who ? `: ${who}` : ''}</b>
      <span class="muted">${escapeHtml(note)}</span></div>`
}

// Mỗi call của kit trong lúc liên kết nhanh → cập nhật tiến trình.
function qlTrack(name, payload) {
  const d = payload.data || {}
  if (name === 'grantToken' && payload.ok) {
    const mode = payload.grant?.mode
    if (qlStatus('conn') !== 'skip') qlStep('conn', 'done', mode === 'existing-link' ? 'Tổ chức đã có kết nối' : 'Chưa có kết nối')
    qlStep('token', 'done', mode === 'existing-link' ? 'Đã liên kết sẵn → grant/claim' : '')
    if (mode !== 'open-caslink') {
      qlStep('login', 'skip', 'Dùng kết nối có sẵn')
      qlStep('exchange', 'run')
    }
  } else if (name === 'claim' && payload.ok && d.results?.[0]?.ok) {
    qlStep('exchange', 'run', 'grant/claim')
  } else if (name === 'identity' && payload.ok) {
    qlStep('exchange', 'done')
  }
}

function qlOnFlow(fs) {
  if (fs.status === 'waiting-user') {
    if (qlStatus('token') === 'run') qlStep('token', 'done')
    qlStep('login', 'run', 'Hoàn tất đăng nhập trong cửa sổ Cas Link')
  }
  if (fs.status === 'exchanging') {
    qlStep('login', 'done')
    qlStep('exchange', 'run')
  }
}

function runQuickLink() {
  if (state.qlPhase === 'range') return runQlFetch()
  return state.qlMode === 'account' ? runQlAccount() : runQlLink()
}

// Cách account_id: grant/claim trực tiếp bằng account_id của kết nối đã có (không tạo grant/token, không mở Cas Link).
function runQlAccount() {
  if (!hasCred()) return promptCred()
  const linkId = val('qlAccountId')
  if (!linkId) return toast('Nhập account_id trước', 'error')
  const btn = $('qlStart')
  QL_STEPS.forEach((k) => qlStep(k, ''))
  $('qlResult').hidden = true
  state.qlLinking = true
  qlStep('conn', 'skip', 'Dùng account_id nhập tay')
  qlStep('token', 'skip', 'Bỏ qua — không tạo grant/token')
  qlStep('login', 'skip', 'Bỏ qua — không mở Cas Link')
  qlStep('exchange', 'run', 'grant/claim')
  setBusy(btn, true, 'Đang liên kết…')
  qlAwaitLink(state.flow.claim(linkId))
}

// Giai đoạn 1: liên kết (claim nếu tổ chức đã có kết nối, không thì mở Cas Link).
function runQlLink() {
  if (!hasCred()) return promptCred()
  const btn = $('qlStart')
  QL_STEPS.forEach((k) => qlStep(k, ''))
  $('qlResult').hidden = true
  state.qlLinking = true
  const relogin = state.flow.getState().status === 'needs-relogin'
  const pending = relogin ? state.flow.relogin() : state.flow.link()
  setBusy(btn, true, 'Đang liên kết…')
  qlStep('conn', 'run')
  if (relogin) {
    qlStep('conn', 'skip', 'Đăng nhập lại cùng kết nối')
    qlStep('token', 'run')
  }
  qlAwaitLink(pending)
}

function qlAwaitLink(pending) {
  const btn = $('qlStart')
  pending.then((fs) => {
    state.qlLinking = false
    setBusy(btn, false)
    if (fs.accessToken && ['linked', 'identity-pending'].includes(fs.status)) {
      if (qlStatus('login') === 'run') qlStep('login', 'done')
      qlStep('exchange', 'done', fs.status === 'identity-pending' ? 'Đang xác minh tổ chức' : '')
      qlShowLinked(fs, fs.status === 'identity-pending'
        ? 'Casso đang xác minh tổ chức. Hoá đơn có thể chưa đồng bộ xong; gọi lại sau ít phút nếu trả về 0 hoá đơn.'
        : 'Chọn khoảng thời gian rồi lấy hoá đơn vào dashboard.')
      setQlPhase('range')
      QL_STEPS.slice(0, 4).forEach((k) => { if (!['done', 'skip'].includes(qlStatus(k))) qlStep(k, 'done') })
      $('qlSecRange').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      $('qlRanges').querySelector('button.active, button')?.focus()
      toast('Liên kết thành công — chọn khoảng thời gian để lấy hoá đơn', 'success')
      return
    }
    // Lỗi: đánh dấu đỏ ở bước đang chạy, giữ hộp thoại mở để thử lại.
    const failed = QL_STEPS.find((k) => qlStatus(k) === 'run') || 'conn'
    qlStep(failed, 'err')
    const err = fs.error || { code: 'INTERNAL_ERROR', message: 'Liên kết chưa hoàn tất.' }
    qlShowError(`${ICONS.alert}<span><b>${escapeHtml(err.code || 'Lỗi')}</b> — ${escapeHtml(ERROR_HINTS[err.code] || err.message)}</span>`)
    $('qlStart').textContent = qlStartLabel()
  })
}

// Giai đoạn 2: sync-status → invoices/stored trong khoảng ngày đã chọn → đổ vào dashboard hero.
async function runQlFetch() {
  const from = val('qlFrom')
  const to = val('qlTo')
  if (!from || !to) return toast('Chọn khoảng thời gian', 'error')
  if (from > to) return toast('Ngày bắt đầu phải trước ngày kết thúc', 'error')

  const btn = $('qlStart')
  setBusy(btn, true, 'Đang lấy hoá đơn…')
  $('qlResult').hidden = true
  qlStep('fetch', 'run', `${viDate(from)} → ${viDate(to)}`)
  $('invFrom').value = from
  $('invTo').value = to
  $('invType').value = val('qlType')
  document.querySelectorAll('#quickRanges button').forEach((b) => b.classList.remove('active'))
  const result = await doFetch({ scroll: false })
  setBusy(btn, false)
  if (!result.ok) {
    qlStep('fetch', 'err')
    return qlShowError(result.empty
      ? `${ICONS.alert}<span>Không có hoá đơn từ ${viDate(from)} đến ${viDate(to)}. Chọn khoảng rộng hơn rồi thử lại.</span>`
      : errorLine(result.payload))
  }
  const n = state.real.invoices.length.toLocaleString('vi-VN')
  qlStep('fetch', 'done', `${n} hoá đơn`)
  closeQuickLink()
  state.heroSource = 'real'
  renderHero()
  $('hero').scrollIntoView({ behavior: 'smooth', block: 'start' })
  toast(`Đã tải ${n} hoá đơn thật vào dashboard`, 'success')
}

// ------------------------------------------------------------------
// Wire-up
// ------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a')
  if (!t) return

  if (t.dataset.copy !== undefined) return copyText(t.dataset.copy, t.dataset.copyLabel || 'giá trị')
  if (t.dataset.copyFrom) return copyText($(t.dataset.copyFrom).textContent, t.dataset.copyLabel || 'giá trị')
  if (t.dataset.curl) return copyText(curlFor(t.dataset.curl), 'cURL')
  if (t.dataset.copyJson) return copyText(JSON.stringify(state.results[t.dataset.copyJson]?.data, null, 2), 'JSON')
  if (t.dataset.env) return setEnv(t.dataset.env)
  if (t.dataset.scrollStep) return scrollToStep(Number(t.dataset.scrollStep))
  if (t.dataset.source) {
    state.heroSource = t.dataset.source
    return renderHero()
  }
  if (t.dataset.call) {
    state.activeCall[t.dataset.panel] = t.dataset.call
    return renderApiPanel(t.dataset.panel)
  }
  if (t.dataset.months) return setRange(Number(t.dataset.months))
  if (t.dataset.quickLink !== undefined) return openQuickLink()
  if (t.dataset.qlclose !== undefined) return closeQuickLink()
  if (t.dataset.qlrelink !== undefined) return setQlPhase('link')
  if (t.dataset.qlmode) return setQlMode(t.dataset.qlmode)
  if (t.dataset.qlmonths) return setQlRange(Number(t.dataset.qlmonths))
  if (t.dataset.method) return setMethod(t.dataset.method)
  if (t.dataset.unlink !== undefined) return state.flow.unlink()
  if (t.classList.contains('secret-toggle')) {
    const input = t.previousElementSibling
    input.type = input.type === 'password' ? 'text' : 'password'
    t.textContent = input.type === 'password' ? 'Hiện' : 'Ẩn'
  }
})

document.addEventListener('input', (e) => {
  const key = e.target.dataset?.cred
  if (key) {
    state.cred[key] = e.target.value.trim()
    // đồng bộ các ô key ở bước 1 và bước 2
    document.querySelectorAll(`[data-cred="${key}"]`).forEach((el) => { if (el !== e.target) el.value = e.target.value })
    Object.keys(PANELS).forEach(renderApiPanel)
    return
  }
  if (e.target.id === 'claimLinkId') return renderApiPanel('apiClaim')
  if (e.target.id === 'manualPublicToken') return renderApiPanel('apiCasLink')
  if (['qlFrom', 'qlTo'].includes(e.target.id)) return setQlRange(null)
  if (['invToken', 'invFrom', 'invTo', 'invType'].includes(e.target.id)) {
    if (e.target.type === 'date') document.querySelectorAll('#quickRanges button').forEach((b) => b.classList.remove('active'))
    return renderApiPanel('apiInv')
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('quickLinkModal').hidden) return closeQuickLink()
  if (!$('resultOverlay').hidden) closeResult()
})

// Bấm ra ngoài thẻ thì đóng hộp thoại.
$('quickLinkModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeQuickLink() })
$('qlStart').addEventListener('click', runQuickLink)

$('btnClaim').addEventListener('click', doClaim)
$('btnLink').addEventListener('click', doLink)
$('btnUseManualPublic').addEventListener('click', doManualPublicToken)
$('btnFetch').addEventListener('click', doFetch)
$('btnOpenDashboard').addEventListener('click', openResult)
$('btnCloseResult').addEventListener('click', closeResult)
$('btnRefetch').addEventListener('click', () => {
  closeResult()
  scrollToStep(2)
})

let resizeTimer
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    heroLedger.redrawChart()
    if (!$('resultOverlay').hidden) fullLedger.redrawChart()
  }, 150)
})

async function init() {
  heroLedger = createLedger($('heroLedger'), { mode: 'dashboard' })
  statementLedger = createLedger($('statementLedger'), { mode: 'statement' })
  fullLedger = createLedger($('fullLedger'), { mode: 'dashboard' })
  try {
    state.config = await (await fetch('./api/config')).json()
  } catch {
    toast('Không đọc được cấu hình server', 'error')
  }
  if (state.config?.mock) state.cred = { clientId: 'mock-client', secretKey: 'mock-secret' }
  setRange(3)
  renderEnv()
  renderConsoleSetup()
  renderHero()
  renderStatement()
  setupLinkFlow()
  setMethod('claim')
  Object.keys(PANELS).forEach(renderApiPanel)
  renderProgress()
}

init()
