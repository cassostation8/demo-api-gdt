// Tax-account linking flow for the demo: grant/token → (claim | Cas Link widget → exchange) → identity, as a small state machine.
//
// Trạng thái (fs.status): idle · working · waiting-user (widget Cas Link đang mở) · exchanging
// · identity-pending (đã có token, Casso đang xác minh tổ chức; tự kiểm tra lại mỗi 15 giây)
// · linked · needs-relogin (tài khoản thuế cần đăng nhập lại — Update Mode) · error.

const RELOGIN_CODES = ['GRANT_LOGIN_REQUIRED', 'OTP_REQUIRED', 'PREVENTED']
const IDENTITY_POLL_MS = 15_000

// Casso bọc lỗi trong { error: { errorCode } }, nhưng exchange có thể trả { error: "invalid_grant", message }.
function errorOf(payload) {
  const err = payload?.data?.error
  if (!err) return null
  if (typeof err === 'string') return { code: err, message: payload.data.message || '' }
  return { code: err.errorCode || 'ERROR', message: err.errorMessage || '' }
}

// Gọi các route /api/casso/* của server demo; mỗi response được báo lên UI qua onApiCall để hiện trong API console.
export function createCassoClient({ baseUrl, getEnv, getCredentials, getWidgetUrl, onApiCall }) {
  async function call(name, method, path, { body, token } = {}) {
    const cred = getCredentials()
    const headers = { 'x-casso-env': getEnv(), 'x-client-id': cred.clientId, 'x-secret-key': cred.secretKey }
    if (token) headers.Authorization = token
    if (body) headers['Content-Type'] = 'application/json'
    let payload
    try {
      const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
      payload = await res.json()
    } catch (err) {
      payload = { ok: false, status: 0, data: { error: { errorCode: 'DEMO_NETWORK_ERROR', errorMessage: err.message } } }
    }
    return payload
  }
  const report = (name, payload) => {
    onApiCall?.({ name, payload })
    return payload
  }

  let loadedWidgetUrl = null
  function loadWidget(url) {
    if (loadedWidgetUrl === url && window.BankHub) return Promise.resolve()
    document.querySelectorAll('script[data-cas-link]').forEach((s) => s.remove())
    delete window.BankHub
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = url
      script.dataset.casLink = 'true'
      script.onload = () => {
        if (!window.BankHub?.useBankHubLink) return reject(new Error('Script Cas Link tải xong nhưng không có window.BankHub'))
        loadedWidgetUrl = url
        resolve()
      }
      script.onerror = () => reject(new Error(`Không tải được ${url}`))
      document.head.appendChild(script)
    })
  }

  return {
    async grantToken(token) {
      const payload = await call('grantToken', 'POST', '/grant/token', { token })
      const d = payload.data || {}
      payload.grant = { mode: d.grantToken ? 'open-caslink' : d.link_id ? 'existing-link' : 'unknown' }
      return report('grantToken', payload)
    },
    claim: async (linkId) => report('claim', await call('claim', 'POST', '/grant/claim', { body: { linkId } })),
    exchange: async (publicToken) => report('exchange', await call('exchange', 'POST', '/grant/exchange', { body: { publicToken } })),
    identity: async (token) => report('identity', await call('identity', 'GET', '/identity', { token })),
    remove: async (token) => report('remove', await call('remove', 'POST', '/grant/remove', { token })),

    // Ký state ở server, tải script Cas Link theo môi trường, mở iframe; resolve publicToken (null nếu chỉ đăng nhập lại).
    async openCasLink(grantToken) {
      const signed = await call('state', 'POST', '/grant/state')
      if (!signed.ok) throw Object.assign(new Error(signed.message || 'Không ký được state'), { code: 'DEMO_MISSING_INPUT' })
      await loadWidget(getWidgetUrl())
      return new Promise((resolve, reject) => {
        let settled = false
        const done = (fn, value) => {
          if (settled) return
          settled = true
          window.removeEventListener('message', onMessage)
          fn(value)
        }
        // Dự phòng: trang /casso/callback gửi publicToken bằng postMessage (cùng origin) khi Casso chuyển trang trong iframe.
        const onMessage = (e) => {
          if (e.origin === window.location.origin && e.data?.type === 'casso:public-token' && e.data.publicToken) done(resolve, e.data.publicToken)
        }
        window.addEventListener('message', onMessage)
        window.BankHub.useBankHubLink({
          grantToken,
          state: signed.state,
          iframe: true,
          onSuccess: (publicToken) => done(resolve, publicToken || null),
          onExit: () => done(reject, Object.assign(new Error('Đã đóng Cas Link khi chưa hoàn tất.'), { code: 'CASLINK_CLOSED' }))
        }).open()
      })
    }
  }
}

export function createLinkFlow({ client, onLinked, onUnlinked }) {
  let fs = { status: 'idle', busy: false, error: null, accessToken: '', identity: null }
  const listeners = new Set()
  let pollTimer = null
  // Tăng mỗi khi bắt đầu luồng mới / gỡ liên kết: kết quả identity của luồng cũ về muộn thì bỏ qua.
  let generation = 0

  const set = (patch) => {
    fs = { ...fs, ...patch }
    listeners.forEach((fn) => fn(fs))
    return fs
  }
  const stopPoll = () => {
    clearTimeout(pollTimer)
    pollTimer = null
    generation++
  }
  const fail = (error, status = 'error') => set({ status, busy: false, error })

  function failFrom(payload, fallback) {
    const err = errorOf(payload) || { code: 'ERROR', message: fallback }
    if (RELOGIN_CODES.includes(err.code) && fs.accessToken) return fail(err, 'needs-relogin')
    if (err.code === 'ORG_MISMATCH') {
      // Casso đã huỷ kết nối: token không còn dùng được.
      stopPoll()
      set({ accessToken: '', identity: null })
      onUnlinked?.()
    }
    return fail(err)
  }

  // Có accessToken → kiểm tra identity: xác minh xong là linked, chưa xong là identity-pending (vẫn dùng token được).
  async function verify(token, identity) {
    stopPoll()
    const mine = generation
    let data = identity
    if (!data || data.error) {
      const payload = await client.identity(token)
      if (mine !== generation) return fs // đã gỡ liên kết / bắt đầu luồng khác trong lúc chờ
      if (!payload.ok) return failFrom(payload, 'Không kiểm tra được identity.')
      data = payload.data
    }
    const pending = data?.error === 'IDENTITY_NOT_VERIFIED'
    set({ status: pending ? 'identity-pending' : 'linked', busy: false, error: null, accessToken: token, identity: data })
    onLinked?.({ accessToken: token, identity: data })
    if (pending) pollTimer = setTimeout(() => verify(token), IDENTITY_POLL_MS)
    return fs
  }

  async function exchange(publicToken) {
    set({ status: 'exchanging', busy: true, error: null })
    const payload = await client.exchange(publicToken)
    const token = payload.data?.accessToken
    if (!payload.ok || !token) return failFrom(payload, 'Không đổi được publicToken.')
    return verify(token, payload.data.identity)
  }

  async function claim(linkId) {
    set({ status: 'working', busy: true, error: null })
    const payload = await client.claim(linkId)
    const first = payload.data?.results?.[0]
    // grant/claim luôn HTTP 200 — lỗi nằm trong results[].ok.
    if (!payload.ok || !first?.ok || !first.access_token) {
      return payload.ok ? fail({ code: first?.error || 'NOT_FOUND', message: 'Claim không thành công cho link_id này.' }) : failFrom(payload)
    }
    return verify(first.access_token)
  }

  async function openWidget(grantToken) {
    set({ status: 'waiting-user', busy: false, error: null })
    try {
      return await client.openCasLink(grantToken)
    } catch (err) {
      fail({ code: err.code || 'ERROR', message: err.message })
      return undefined
    }
  }

  async function link() {
    stopPoll()
    set({ status: 'working', busy: true, error: null })
    const payload = await client.grantToken()
    const d = payload.data || {}
    if (!payload.ok) return failFrom(payload, 'grant/token lỗi.')
    if (d.link_id) return claim(d.link_id) // tổ chức đã có kết nối hoá đơn điện tử → dùng lại, không mở Cas Link
    if (!d.grantToken) return fail({ code: 'ERROR', message: 'grant/token không trả grantToken.' })
    const publicToken = await openWidget(d.grantToken)
    if (publicToken === undefined) return fs
    if (!publicToken) return fail({ code: 'ERROR', message: 'Cas Link không trả publicToken.' })
    return exchange(publicToken)
  }

  // Update Mode: grant/token kèm token cũ → đăng nhập lại trong Cas Link → identity (không exchange, token giữ nguyên).
  async function relogin() {
    const token = fs.accessToken
    if (!token) return link()
    stopPoll()
    set({ status: 'working', busy: true, error: null })
    const payload = await client.grantToken(token)
    if (!payload.ok || !payload.data?.grantToken) return failFrom(payload, 'grant/token (Update Mode) lỗi.')
    const result = await openWidget(payload.data.grantToken)
    if (result === undefined) return set({ status: 'needs-relogin' })
    set({ status: 'working', busy: true })
    return verify(token)
  }

  async function unlink() {
    const token = fs.accessToken
    stopPoll()
    if (token) {
      set({ busy: true })
      const payload = await client.remove(token)
      // INVALID_GRANT: kết nối đã bị gỡ ở nơi khác — coi như gỡ xong.
      if (!payload.ok && errorOf(payload)?.code !== 'INVALID_GRANT') return failFrom(payload, 'grant/remove lỗi.')
    }
    set({ status: 'idle', busy: false, error: null, accessToken: '', identity: null })
    onUnlinked?.()
    return fs
  }

  return {
    getState: () => fs,
    subscribe(fn) {
      listeners.add(fn)
      fn(fs)
      return () => listeners.delete(fn)
    },
    destroy() {
      stopPoll()
      listeners.clear()
    },
    link,
    relogin,
    claim,
    unlink,
    submitPublicToken: (publicToken) => exchange(publicToken)
  }
}
