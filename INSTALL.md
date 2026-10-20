# Cài đặt DeepSeek Pulse trên máy khác

Hướng dẫn này dành cho người **clone repo này về máy của họ**. Có hai kiểu dùng:

| Kiểu | Dùng khi | Cần gì |
| --- | --- | --- |
| **A. Plugin DeepSeek Harness** (khuyến nghị) | Muốn panel Pulse + dock + cảnh báo cao điểm ngay trong app Harness | DeepSeek Harness đã cài và đã đăng nhập DeepSeek |
| **B. Chạy độc lập** | Không dùng Harness, hoặc chỉ muốn mở bằng trình duyệt | Node.js ≥ 24 |

---

## 0. Yêu cầu chung

- **Windows / macOS / Linux** đều chạy được (thuần Node, không phụ thuộc native module).
- **Node.js ≥ 24** nếu chạy độc lập — cần `zlib.zstdDecompressSync` để đọc log phiên của Harness.
  Kiểm tra: `node -v`. Nếu chưa có, tải ở https://nodejs.org hoặc dùng Node đi kèm Harness.
- **Đã đăng nhập DeepSeek trong Harness** (nếu muốn xem số dư). Dashboard đọc lại đúng phiên đăng nhập đó từ `~/.dsh/.credentials.yaml`, **không cần API key riêng**.
- Không cần Python, không cần build, không có dependency npm nào.

---

## A. Cài như plugin DeepSeek Harness

### A1. Cài từ GitHub (một lệnh)

Mở một phiên agent trong Harness và yêu cầu:

```
plugin_manager  action=install_bundle  target=github:<tài-khoản>/deepseek-pulse
```

> Thay `<tài-khoản>` bằng username GitHub của repo (ví dụ `github:alice/deepseek-pulse`).

Lệnh này thêm gói vào profile hiện tại và bật plugin luôn.

### A2. Hoặc cài từ thư mục đã clone

```bash
git clone https://github.com/<tài-khoản>/deepseek-pulse.git
```

Rồi trong Harness:

```
plugin_manager  action=install_bundle  target=file:/đường/dẫn/tới/deepseek-pulse
```

### A3. Hoặc cài tay bằng pnpm

```bash
cd ~/.dsh/profiles/desktop          # Windows: %USERPROFILE%\.dsh\profiles\desktop
pnpm add "github:<tài-khoản>/deepseek-pulse"
```

Sau đó thêm vào `package.json` của profile:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "deepseek-pulse"]
    }
  }
}
```

### A4. Khởi động lại và bật giao diện

1. **Thoát hẳn** DeepSeek Harness rồi mở lại (host half chỉ nạp khi khởi động).
2. Trong cửa sổ Harness nhấn **Ctrl+R** để nạp client half.
3. Kết quả mong đợi:
   - mục **Pulse** ở sidebar (dưới *Plugins*);
   - **dock** nhỏ ở góc trái dưới, ngay trên thanh Settings;
   - bấm dock hoặc mục Pulse → mở dashboard đầy đủ.

Kiểm tra nhanh bằng trình duyệt: mở `http://127.0.0.1:<cổng-Harness>/pulse/` — cổng hiện ở đầu cửa sổ Harness (thanh địa chỉ panel Browser), dạng `http://127.0.0.1:1843`.

### A5. Cấu hình (tuỳ chọn)

Sửa `~/.dsh/profiles/<profile>/cordis.patch.yml` (Windows: `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`):

```yaml
- id: deepseek-pulse
  config:
    peakWarningMinutes: 15          # cảnh báo trước bao nhiêu phút khi sắp vào cao điểm
    displayTimeZone: Asia/Ho_Chi_Minh
    defaultRangeDays: 14
    # sessionDir: /home/<bạn>/.dsh/sessions    # chỉ đặt nếu DSH dùng thư mục khác
```

Lưu file rồi khởi động lại Harness.

### A6. Gỡ cài đặt

```
plugin_manager  action=remove_bundle  target=deepseek-pulse
```

hoặc tắt trong **Settings → Plugins → deepseek-pulse**.

---

## B. Chạy độc lập (không cần Harness)

```bash
git clone https://github.com/<tài-khoản>/deepseek-pulse.git
cd deepseek-pulse
node server.mjs
```

Mở **http://127.0.0.1:4577**.

- Đổi cổng: `set PORT=5000` (Windows) / `PORT=5000 node server.mjs` (macOS, Linux) hoặc sửa `config.json`.
- Windows có thể nhấp đôi `start.cmd` (tự tìm Node, kể cả Node đi kèm Harness).
- Server chỉ nghe `127.0.0.1`, không mở ra mạng.

---

## C. Dữ liệu lấy từ đâu (đọc trước khi cài)

| Số liệu | Nguồn | Ghi chú |
| --- | --- | --- |
| Số dư, tổng chi tiêu | `https://platform.deepseek.com/api/v0/users/get_user_summary` | Dùng grant DSH đã lưu trong `~/.dsh/.credentials.yaml` |
| Token theo phiên | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | Log cục bộ của Harness trên **chính máy đó** |
| Giá, khung giờ | `config.json` | Chép từ tài liệu giá DeepSeek |

Hệ quả khi cài trên máy khác:

- Dashboard **chỉ thấy usage phát sinh trên máy đó**. Muốn theo dõi máy khác thì cài ở máy khác.
- Không có dữ liệu lịch sử token của DeepSeek từ xa — API công khai chỉ có `/user/balance`.
- Chưa đăng nhập DeepSeek trong Harness thì card số dư báo "chưa kết nối", phần token vẫn chạy bình thường.

---

## D. Xử lý sự cố

| Hiện tượng | Cách xử lý |
| --- | --- |
| Cài xong nhưng không thấy mục Pulse | Thoát hẳn và mở lại Harness, sau đó Ctrl+R. Kiểm tra Settings → Plugins có `deepseek-pulse` và đang bật. |
| Panel trống / trắng | Mở `http://127.0.0.1:<cổng>/pulse/` trực tiếp. Nếu 404 → plugin chưa nạp (khởi động lại Harness). |
| Dock không hiện | Dock tự ẩn khi sidebar thu gọn (rail); mở rộng sidebar là thấy. |
| Card số dư "Chưa tìm thấy phiên đăng nhập" | Đăng nhập DeepSeek trong Harness (Settings → Account) rồi bấm **Cập nhật** trong dashboard. |
| "Phiên đăng nhập đã hết hiệu lực" | Đăng xuất rồi đăng nhập lại trong Harness. |
| Bảng phiên trống, 0 phiên | Máy đó chưa có phiên Harness nào, hoặc `DSH_HOME` trỏ nơi khác. |
| Lỗi `zstd` khi chạy độc lập | Dùng Node ≥ 24 (`node -v`). |
| Cổng 4577 bận | Server tự nhảy cổng kế tiếp và in URL thật ra console. |

---

## E. Quyền riêng tư

- Token đăng nhập chỉ đọc từ đĩa và gửi tới `platform.deepseek.com`; không trả về trình duyệt, không ghi log, không gửi chỗ khác.
- Route `/pulse` không hỏi đăng nhập (giống các route phụ khác của Harness) và chỉ phục vụ trên `127.0.0.1`. Đừng mở Harness ra mạng ngoài nếu không muốn chia sẻ số dư.
- Không có telemetry, không gọi mạng nào khác ngoài DeepSeek Platform khi cập nhật số dư.
