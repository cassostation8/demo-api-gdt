// Hoá đơn minh hoạ cùng shape với GET /proxy/gdt/invoices/stored.
// Dùng cho hero (luôn gắn nhãn "Dữ liệu minh hoạ") và cho Casso giả lập (`npm run mock`).
// Seeded: cùng seed + cùng ngày thì ra cùng bộ dữ liệu.

export const SAMPLE_COMPANY = { name: 'CÔNG TY TNHH NỘI THẤT MẪU AN PHÁT', taxCode: '0000000001' }

const CUSTOMERS = [
  { name: 'CÔNG TY CP ĐẦU TƯ MẪU MINH KHOA', taxCode: '0000000002' },
  { name: 'CÔNG TY TNHH VĂN PHÒNG MẪU SÀI GÒN', taxCode: '0000000003' },
  { name: 'CÔNG TY CP KHÁCH SẠN MẪU BIỂN XANH', taxCode: '0000000004' },
  { name: 'TRƯỜNG HỌC MẪU HOÀNG GIA', taxCode: '0000000005' },
  { name: 'CÔNG TY TNHH KIẾN TRÚC MẪU VIỆT MỘC', taxCode: '0000000006' },
  { name: 'NGÂN HÀNG MẪU - CHI NHÁNH 1', taxCode: '0000000007-001' }
]

const SUPPLIERS = [
  { name: 'CÔNG TY CP GỖ MẪU MIỀN NAM', taxCode: '0000000008', items: [['Ván MDF chống ẩm 18mm', 420000, 40, 160, '10%']] },
  { name: 'CÔNG TY TNHH BAO BÌ MẪU SAO MAI', taxCode: '0000000009', items: [['Thùng carton 5 lớp', 18000, 300, 900, '8%']] },
  { name: 'CÔNG TY CP VẬN TẢI MẪU HOÀ BÌNH', taxCode: '0000000010', items: [['Cước vận chuyển nội thành', 650000, 4, 16, '8%']] },
  { name: 'CÔNG TY ĐIỆN LỰC MẪU', taxCode: '0000000011', items: [['Tiền điện xưởng sản xuất', 2650, 6000, 9000, '8%']], monthly: 8 },
  { name: 'CÔNG TY CP VIỄN THÔNG MẪU', taxCode: '0000000012', items: [['Cước internet doanh nghiệp', 1650000, 1, 1, '10%']], monthly: 3 },
  { name: 'CÔNG TY CP PHẦN MỀM KẾ TOÁN MẪU', taxCode: '0000000013', items: [['Phần mềm kế toán (thuê bao tháng)', 990000, 1, 1, 'KCT']], monthly: 1 }
]

const PRODUCTS = [
  ['Bàn làm việc gỗ sồi 1m4', 3200000, '10%'],
  ['Ghế công thái học', 2450000, '10%'],
  ['Tủ hồ sơ 3 ngăn', 1850000, '10%'],
  ['Bàn họp 8 chỗ', 12500000, '10%'],
  ['Dịch vụ lắp đặt', 1500000, '8%'],
  ['Vận chuyển và bàn giao', 800000, '8%']
]

function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

// Chuỗi QR của hoá đơn thật dài vài trăm ký tự — giữ độ dài gần thật để response giả lập nặng như thật.
function qrCode(id) {
  return `00020101021238${id}`.padEnd(400, '0123456789ABCDEF')
}

function rateOf(taxRate) {
  const n = parseFloat(taxRate)
  return Number.isFinite(n) ? n / 100 : 0
}

function lineItem(itemName, unitPrice, quantity, taxRate) {
  const subtotalAmount = unitPrice * quantity
  return { itemName, quantity, unitPrice, subtotalAmount, taxRate, taxAmount: Math.round(subtotalAmount * rateOf(taxRate)) }
}

function financialsOf(lineItems) {
  const bands = new Map()
  for (const li of lineItems) {
    const b = bands.get(li.taxRate) || { taxRate: li.taxRate, taxAmount: 0, taxableAmount: 0 }
    b.taxAmount += li.taxAmount
    b.taxableAmount += li.subtotalAmount
    bands.set(li.taxRate, b)
  }
  const subtotalAmount = lineItems.reduce((s, li) => s + li.subtotalAmount, 0)
  const totalTaxAmount = lineItems.reduce((s, li) => s + li.taxAmount, 0)
  return { subtotalAmount, totalTaxAmount, totalPaymentAmount: subtotalAmount + totalTaxAmount, taxRateBreakdown: [...bands.values()] }
}

/**
 * @param {{ fromDate: string, toDate: string, seed?: number, invoiceType?: 'sold'|'purchase' }} options
 * @returns {object[]} gdtInvoices
 */
export function buildSampleInvoices({ fromDate, toDate, seed = 20261008, invoiceType } = {}) {
  const rand = seededRandom(seed)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const between = (min, max) => min + Math.floor(rand() * (max - min + 1))
  const today = isoDate(new Date())
  const invoices = []
  let soldNo = 1201
  const purchaseNo = new Map()

  const push = (inv) => {
    const day = inv.transactionDate
    // Hoá đơn vài ngày gần nhất có thể chưa lấy xong chi tiết; một ít bị lỗi hẳn.
    const recent = (new Date(`${today}T00:00:00`) - new Date(`${day}T00:00:00`)) / 86400000 < 3
    const roll = rand()
    inv.detailStatus = recent && roll < 0.35 ? 'pending' : roll > 0.99 ? 'failed' : 'complete'
    if (inv.detailStatus !== 'complete') {
      inv.lineItems = null
      inv.financials = undefined
      inv.amount = null
      inv.hashes = { qrCode: null }
    }
    invoices.push(inv)
  }

  const sold = (day, lineItems, extra = {}) => {
    const financials = financialsOf(lineItems)
    push({
      invoiceSerial: `1C${day.slice(2, 4)}TAP`,
      invoiceNumber: String(soldNo++).padStart(7, '0'),
      invoiceType: 'sold',
      transactionDate: day,
      amount: financials.totalPaymentAmount,
      financials,
      lineItems,
      hashes: { qrCode: qrCode(soldNo) },
      seller: SAMPLE_COMPANY,
      buyer: extra.buyer || pick(CUSTOMERS),
      invoiceNature: extra.invoiceNature || 1,
      ...(extra.originalInvoiceRef ? { originalInvoiceRef: extra.originalInvoiceRef } : {})
    })
  }

  const purchase = (day, supplier) => {
    const lineItems = supplier.items.map(([name, price, minQ, maxQ, rate]) => lineItem(name, price, between(minQ, maxQ), rate))
    const financials = financialsOf(lineItems)
    const no = (purchaseNo.get(supplier.taxCode) || between(300, 9000)) + 1
    purchaseNo.set(supplier.taxCode, no)
    push({
      invoiceSerial: `1C${day.slice(2, 4)}T${supplier.taxCode.slice(-2)}`,
      invoiceNumber: String(no).padStart(7, '0'),
      invoiceType: 'purchase',
      transactionDate: day,
      amount: financials.totalPaymentAmount,
      financials,
      lineItems,
      hashes: { qrCode: qrCode(`${supplier.taxCode}${no}`) },
      seller: { name: supplier.name, taxCode: supplier.taxCode },
      buyer: SAMPLE_COMPANY,
      invoiceNature: 1
    })
  }

  for (let d = new Date(`${fromDate}T00:00:00`); isoDate(d) <= toDate; d.setDate(d.getDate() + 1)) {
    const day = isoDate(d)
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const orders = weekend ? (rand() < 0.3 ? 1 : 0) : between(0, 3)
    for (let i = 0; i < orders; i++) {
      const items = [PRODUCTS[between(0, 3)], ...(rand() < 0.6 ? [PRODUCTS[between(4, 5)]] : [])]
      sold(day, items.map(([name, price, rate]) => lineItem(name, price, between(1, 12), rate)))
    }
    // Thỉnh thoảng có hoá đơn thay thế (sửa thông tin, giữ nguyên giá trị) hoặc điều chỉnh giảm.
    const lastSold = [...invoices].reverse().find((x) => x.invoiceType === 'sold' && x.detailStatus === 'complete' && x.invoiceNature === 1)
    if (lastSold && !weekend && rand() < 0.04) {
      const ref = { originalInvoiceSerial: lastSold.invoiceSerial, originalInvoiceNumber: lastSold.invoiceNumber, originalInvoiceIssuedAt: lastSold.transactionDate }
      if (rand() < 0.5) {
        sold(day, lastSold.lineItems.map((li) => ({ ...li })), { buyer: lastSold.buyer, invoiceNature: 2, originalInvoiceRef: { ...ref, originalInvoiceNote: 'Hóa đơn thay thế do sai địa chỉ người mua' } })
      } else {
        sold(day, [lineItem('Chiết khấu thương mại', -between(2, 8) * 100000, 1, '10%')], { buyer: lastSold.buyer, invoiceNature: 3, originalInvoiceRef: { ...ref, originalInvoiceNote: 'Hóa đơn điều chỉnh giảm' } })
      }
    }
    SUPPLIERS.forEach((s) => {
      if (s.monthly ? d.getDate() === s.monthly : !weekend && rand() < 0.12) purchase(day, s)
    })
  }

  return invoiceType ? invoices.filter((x) => x.invoiceType === invoiceType) : invoices
}
