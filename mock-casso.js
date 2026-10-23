// Fake Casso Console for `npm run mock`: same routes/response shapes the demo uses, plus a fake Cas Link widget script.
// Casso Console giả lập — chỉ dùng với `npm run mock` để chạy thử trọn luồng khi chưa có key.
// Cùng route, cùng shape response với Casso thật cho các endpoint demo này dùng.
import express from 'express'
import { buildSampleInvoices, SAMPLE_COMPANY } from './public/sample-data.js'

const GDT_ID = '9fd49a0b-a9f0-4eb5-8c10-00c23bd29a41'

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

export function createMockCasso() {
  const router = express.Router()
  router.use(express.json())
  const tokens = new Set()
  const syncedFrom = (() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 11, 1)
    return isoDate(d)
  })()

  router.use('/proxy', (req, res, next) => {
    if (!req.headers['x-client-id'] || !req.headers['x-secret-key']) {
      return res.status(401).json({ error: { errorCode: 'MISSING_CREDENTIALS', errorMessage: 'Thiếu credential' } })
    }
    next()
  })

  const requireToken = (req, res, next) => {
    if (!req.headers.authorization) return res.status(400).json({ error: { errorCode: 'BAD_REQUEST', errorMessage: 'Thiếu Authorization' } })
    if (!tokens.has(req.headers.authorization)) return res.status(400).json({ error: { errorCode: 'INVALID_GRANT', errorMessage: 'accessToken không thuộc credential này' } })
    next()
  }

  router.post('/proxy/grant/token', (req, res) => {
    res.json({ requestId: 'req_mock', grantToken: `gt_mock_${Date.now()}`, expiration: new Date(Date.now() + 30 * 60e3).toISOString() })
  })

  router.post('/proxy/grant/exchange', (req, res) => {
    const { publicToken } = req.body || {}
    if (!String(publicToken || '').startsWith('pub_')) {
      return res.status(400).json({ requestId: 'req_mock', error: 'invalid_grant', message: 'Public token expired' })
    }
    const accessToken = `pt_mock_${Date.now()}`
    tokens.add(accessToken)
    res.json({ requestId: 'req_mock', accessToken, grantId: 'pg_mock', identity: { fiService: { name: 'Hoá đơn điện tử' }, company: SAMPLE_COMPANY, accounts: [SAMPLE_COMPANY] } })
  })

  router.post('/proxy/grant/claim', (req, res) => {
    res.json({
      results: (req.body?.link_ids || []).map((id) => {
        if (!id.startsWith('lnk_')) return { link_id: id, ok: false, error: 'NOT_FOUND' }
        const token = `pt_mock_claim_${Date.now()}`
        tokens.add(token)
        return { link_id: id, ok: true, grant_id: 'pg_mock', access_token: token }
      })
    })
  })

  router.post('/proxy/grant/remove', requireToken, (req, res) => res.json({ state: 'DELETED' }))

  router.all('/proxy/identity', requireToken, (req, res) => {
    res.json({ fiService: { name: 'Hoá đơn điện tử' }, company: SAMPLE_COMPANY, accounts: [SAMPLE_COMPANY] })
  })

  router.get('/proxy/gdt/sync-status', requireToken, (req, res) => {
    res.json({
      taxAccount: { status: 'active', actionRequired: null, message: null },
      sync: { state: 'steady', firstSync: null, pendingDetail: 2, failedDetail: 0 },
      quota: { used: 241, limit: 6000, remaining: 5759, resetPeriod: 'yearly', resetDate: `${new Date().getFullYear() + 1}-01-01T00:00:00.000Z`, state: 'normal', lowQuotaWarning: false }
    })
  })

  router.get('/proxy/gdt/invoices/stored', requireToken, (req, res) => {
    const toDate = req.query.toDate || isoDate(new Date())
    const fromDate = req.query.fromDate || isoDate(new Date(Date.now() - 29 * 86400e3))
    if (fromDate > toDate) return res.status(400).json({ error: { errorCode: 'BAD_REQUEST', errorMessage: 'fromDate > toDate' } })
    const effectiveFrom = fromDate < syncedFrom ? syncedFrom : fromDate
    const gdtInvoices = buildSampleInvoices({ fromDate: effectiveFrom, toDate, seed: 7, invoiceType: req.query.invoiceType })
    const pendingCount = gdtInvoices.filter((x) => x.detailStatus === 'pending').length
    const failedCount = gdtInvoices.filter((x) => x.detailStatus === 'failed').length
    res.json({
      gdtInvoices,
      coverage: {
        status: fromDate < syncedFrom ? 'outside_window' : pendingCount || failedCount ? 'partial' : 'complete',
        syncedFrom,
        pendingCount,
        failedCount
      },
      quota: { used: 241, limit: 6000, remaining: 5759, newlyCharged: 0, state: 'normal' }
    })
  })

  // Widget Cas Link giả (thay /link/v1/link-initialize.js): hộp thoại xác nhận rồi trả publicToken qua onSuccess.
  const widget = `window.BankHub = { useBankHubLink: function (cfg) { return { open: function () {
    setTimeout(function () {
      if (window.confirm('Cas Link (giả lập) · Tổng cục Thuế\\nfiServiceId ${GDT_ID}\\n\\nOK = đăng nhập thành công, Cancel = đóng.')) cfg.onSuccess('pub_mock_' + Date.now())
      else cfg.onExit && cfg.onExit()
    }, 50)
  } } } }`
  router.get(['/link/v1/link-initialize.js', '/link/v1/stable/link-initialize.js'], (req, res) => res.type('application/javascript').send(widget))

  return router
}
