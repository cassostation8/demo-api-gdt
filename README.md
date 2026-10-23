# Casso Console · Demo API hoá đơn điện tử (GDT)

Ứng dụng web mẫu cho thấy cách tích hợp **[Casso Console Open API](https://console.casso.vn/docs/quickstart)** để lấy hoá đơn điện tử của doanh nghiệp từ Tổng cục Thuế (GDT):

1. **Liên kết tài khoản thuế** qua Cas Link → nhận `accessToken`.
2. **Gọi API hoá đơn** (`/proxy/gdt/sync-status`, `/proxy/gdt/invoices/stored`).
3. **Hiển thị dữ liệu** thành bảng kê và dashboard (doanh thu, chi phí, thuế GTGT tạm tính, xuất CSV).

Trang có sẵn một dashboard bằng **dữ liệu minh hoạ** để xem ngay. Có thêm **chế độ giả lập** (`npm run mock`) chạy trọn luồng mà không cần tài khoản Casso. Phần "Kết nối dữ liệu thật" chạy với key của bạn, có khung API console hiện request/response thật và nút Copy cURL.

**Kiến trúc:** Node.js + Express (`server.js`) chỉ chuyển tiếp request tới Casso Console; giao diện là HTML/CSS/JS thuần trong `public/`. Không database, không bước build, server không lưu key.

---

## Chạy

```bash
git clone <URL-repo-này> demo-api-gdt
cd demo-api-gdt
npm install
npm start            # hoặc npm run dev (tự reload khi sửa code)
```

Mở <http://localhost:3040> — xong. Cần [Node.js 18+](https://nodejs.org); không cần file `.env` hay tài khoản Casso để xem dashboard minh hoạ.

Muốn bấm thử trọn luồng liên kết → gọi API mà chưa có tài khoản Casso: chạy `npm run mock` thay cho `npm start` (Casso giả lập, key điền sẵn).

---

## Tuỳ chọn: kết nối dữ liệu thật

Chỉ cần khi muốn liên kết tài khoản thật và gọi API bằng key của bạn.

### 1 · Lấy key trên Casso Console

1. Đăng ký / đăng nhập tại <https://console.casso.vn>. Tài khoản mới có thể dùng môi trường **Sandbox** để thử.
2. Ở **Tổng quan**, bấm **Tạo credential**, đặt tên, chọn dịch vụ **GDT Invoice**.
3. Lưu lại **Client ID** và **Secret key** (xem trong trang chi tiết credential).

### 2 · Chạy với Casso thật qua URL công khai

Cas Link chỉ trả kết quả về địa chỉ đã khai báo trên credential, và địa chỉ đó phải là HTTPS công khai — `localhost` không dùng được. Khi thử ở máy cá nhân, dùng **ngrok**:

1. Tạo tài khoản miễn phí và cài ngrok: <https://ngrok.com/download>, rồi chạy `ngrok config add-authtoken <token>`.
2. (Tuỳ chọn) Lấy domain cố định miễn phí trong dashboard ngrok và điền vào `.env`: `NGROK_DOMAIN=ten-cua-ban.ngrok-free.app`.
3. Chạy 2 terminal:

   ```bash
   npm start          # terminal 1 — Casso thật (không phải mock)
   npm run tunnel     # terminal 2 — in ra URL https://....ngrok-free.app
   ```

4. Mở demo bằng **URL ngrok** đó.

> Nếu đã deploy lên server có domain HTTPS (xem phần Deploy), bỏ qua bước này.

### 3 · Khai báo URL trên credential

Trong demo, ở **Bước 1 · Liên kết tài khoản thuế** có sẵn 2 URL theo domain đang mở, kèm nút Copy:

- **Authorized Redirect URIs**: `https://<domain>/casso/callback`
- **Authorized Webhook URLs**: `https://<domain>/casso/webhook`

Dán 2 URL này vào trang chi tiết credential trên Casso Console rồi **Lưu**.

### 4 · Chạy luồng trong demo

1. **Bước 1 · Liên kết tài khoản thuế**: chọn **Sandbox** hoặc **Production** (khớp môi trường của credential), nhập Client ID + Secret key, rồi:
   - mở **Cas Link** và đăng nhập tài khoản thuế → demo nhận `accessToken`; hoặc
   - dán **`link_id`** nếu đã có kết nối tạo sẵn trên Casso Console.
2. **Bước 2 · Gọi API**: xem trạng thái đồng bộ (miễn phí), chọn khoảng ngày và loại hoá đơn (bán ra / mua vào) → bấm gọi. Lần liên kết đầu, Casso cần vài phút để đồng bộ hoá đơn.
3. **Bước 3 · Bảng kê**: xem hoá đơn thật; bấm **Xem dashboard** để mở dashboard toàn màn hình.

Quy tắc tính tổng: chỉ cộng hoá đơn `detailStatus: complete`; hoá đơn gốc đã bị thay thế (`invoiceNature: 2` trỏ tới) được bỏ khỏi tổng để không cộng trùng.

---

## Tuỳ chọn: deploy lên server (PM2 + Nginx)

```bash
npm ci --omit=dev
cp .env.example .env      # đặt PUBLIC_BASE_URL=https://<domain-của-bạn>, PORT, TRUST_PROXY_HOPS
npm install -g pm2
pm2 start ecosystem.config.cjs   # đã đặt NODE_ENV=production
pm2 save
```

Cập nhật code: `git pull && npm ci --omit=dev && pm2 reload demo-api-gdt`.
Sau khi deploy, khai báo `<PUBLIC_BASE_URL>/casso/callback` và `<PUBLIC_BASE_URL>/casso/webhook` trên credential (như mục 3).

<details>
<summary>Chạy dưới sub-path sau Nginx (VD <code>/demo-api-gdt/</code>)</summary>

Mọi đường dẫn trong app là tương đối. `.env`: `PUBLIC_BASE_URL=https://<domain>/demo-api-gdt`, `TRUST_PROXY_HOPS=1`.

```nginx
location = /demo-api-gdt {
    return 301 /demo-api-gdt/;
}

location ^~ /demo-api-gdt/ {
    # App tự gửi header bảo mật (CSP, frame-ancestors…); đừng ghi đè ở đây.
    add_header X-Content-Type-Options nosniff always;

    proxy_pass         http://localhost:3040/;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}
```

</details>

---

## Biến môi trường (`.env`, tuỳ chọn)

Tạo bằng `cp .env.example .env` khi cần đổi mặc định.

| Biến | Mặc định | Dùng cho |
|---|---|---|
| `PORT` | `3040` | cổng server |
| `CASSO_BASE_URL` | `https://api-console.casso.vn` | host API Casso |
| `CASSO_SANDBOX_BASE_URL` / `CASSO_PRODUCTION_BASE_URL` | = `CASSO_BASE_URL` | ghi đè host theo môi trường (hiếm khi cần) |
| `CASSO_TIMEOUT_MS` | `45000` | timeout khi gọi Casso |
| `PUBLIC_BASE_URL` | suy từ URL trang | domain (gồm sub-path) cho Redirect/Webhook URL — nên đặt khi deploy |
| `TRUST_PROXY_HOPS` | `1` | số reverse proxy phía trước được tin `X-Forwarded-*` |
| `RATE_LIMIT_PER_MIN` | `300` | số request `/api`, `/casso/*` mỗi IP mỗi phút |
| `GITHUB_URL` | `https://github.com` | nút "Mã nguồn" |
| `NGROK_DOMAIN` | (trống = domain ngẫu nhiên) | domain cho `npm run tunnel` |

## Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `Không tìm thấy ngrok` khi `npm run tunnel` | Cài ngrok (mục 2 ở trên) và đảm bảo lệnh `ngrok` chạy được trong terminal. |
| Cas Link không quay về demo | Kiểm tra đã dán đúng URL ở mục 3 và đang mở demo bằng đúng domain đó (không phải localhost). |
| `401` / sai credential | Kiểm tra Client ID, Secret key và chọn đúng Sandbox/Production. |
| `SERVICE_NOT_ALLOWED` | Credential chưa được cấp dịch vụ GDT Invoice — bật trong trang credential. |
| Lỗi do chưa có gói | Tổ chức cần mua gói GDT Invoice trên Casso Console. |
| Chưa có hoá đơn sau khi liên kết | Đồng bộ lần đầu mất vài phút — xem `sync-status` ở Bước 2 rồi gọi lại. |
| `400 DEMO_INVALID_INPUT` | Ngày phải dạng `YYYY-MM-DD`, loại hoá đơn là `sold` hoặc `purchase`. |
| `EADDRINUSE` | Cổng đã bị dùng — đổi `PORT` trong `.env`. |

## Ghi chú kỹ thuật

- Luồng liên kết: `grant/token` → (có `link_id` thì `grant/claim`, không thì widget Cas Link với `state` ký HMAC-SHA512 ở server → `grant/exchange`) → `identity`. Logic ở `public/link-flow.js`. Xem [tài liệu Liên kết tài khoản](https://console.casso.vn/docs/grant/link).
- `/casso/webhook` chỉ trả 200 và ghi log (không xác thực chữ ký) — ứng dụng thật cần xác thực chữ ký webhook.
- Khi được host cùng domain với Casso Console, demo có thể tự liệt kê credential của tổ chức đang đăng nhập; nếu không, nhập key thủ công.
- Server tự gửi CSP (tự cập nhật theo `CASSO_BASE_URL`) và các header bảo mật.

## Cấu trúc

```
server.js              proxy /api/gdt/*, /api/casso/* (grant), /casso/callback, /casso/webhook
mock-casso.js          Casso giả lập cho `npm run mock`
public/index.html      Hero (dashboard minh hoạ) → Cách hoạt động → 3 bước kết nối
public/app.js          logic giao diện, gọi API, bảng kê, API console
public/link-flow.js    luồng liên kết tài khoản thuế (claim / Cas Link / exchange / identity)
public/sample-data.js  hoá đơn minh hoạ (dữ liệu hư cấu), dùng cho hero và mock
public/style.css       giao diện theo brand Casso
scripts/tunnel.js      chạy ngrok theo PORT / NGROK_DOMAIN
ecosystem.config.cjs   cấu hình PM2
```

## Giấy phép

[MIT](LICENSE)
