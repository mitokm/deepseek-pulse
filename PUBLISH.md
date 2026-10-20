# Đưa DeepSeek Pulse lên GitHub

Thư mục này đã sẵn sàng để thành root của một repo: có `package.json` (metadata, `exports`, `dsh`), `LICENSE`, `.gitignore`, README và ảnh chụp trong `docs/`.

## 1. Sửa 30 giây trước khi đăng

| Việc | Ở đâu |
| --- | --- |
| Điền tên bạn vào bản quyền | `LICENSE` — dòng `Copyright (c) 2026 <your name>` |
| (Tuỳ chọn) thêm `repository` / `homepage` | `package.json` |
| (Tuỳ chọn) đổi tên gói | `package.json` → `name`, và `cordis.patch.yml` → `name:` phải **giống hệt** |

Không có token hay mật khẩu trong repo: plugin đọc phiên đăng nhập từ `~/.dsh/.credentials.yaml` lúc chạy, không lưu gì.

## 2. Ba cách đưa lên

### Cách A — Upload bằng trình duyệt (không cần cài gì)

1. https://github.com/new → **Repository name**: `deepseek-pulse` → **Public** → *Create repository*.
2. Ở trang repo mới, bấm **uploading an existing file**.
3. Mở thư mục `deepseek-pulse` trong Explorer, `Ctrl+A` chọn **toàn bộ nội dung bên trong** rồi kéo vào trang.
   - Kéo *nội dung*, đừng kéo cả thư mục — nếu kéo cả thư mục, GitHub sẽ tạo thêm một cấp `deepseek-pulse/deepseek-pulse/`.
4. **Commit changes**.

Ưu: nhanh. Nhược: không có lịch sử commit, lần sau sửa phải upload lại.

### Cách B — GitHub Desktop (khuyến nghị nếu không quen git)

1. Tải **GitHub Desktop** (https://desktop.github.com), đăng nhập tài khoản GitHub.
2. Menu **File → Add local repository…** → chọn `C:\Users\<you>\Documents\deepseek-harness\default-workspace\deepseek-pulse`.
3. Hộp thoại báo chưa phải repo → bấm **create a repository** (để nguyên đường dẫn, bấm *Create repository*).
4. Ô summary nhập `DeepSeek Pulse 1.0.1` → **Commit to main**.
5. Nút **Publish repository** → **bỏ tick** *Keep this code private* → **Publish repository**.

Từ giờ mỗi lần sửa: mở GitHub Desktop → thấy thay đổi → viết summary → Commit → Push.

### Cách C — git CLI

Máy bạn chưa có git; cài bằng winget rồi mở cửa sổ PowerShell mới:

```powershell
winget install --id Git.Git -e --source winget

cd "$env:USERPROFILE\Documents\deepseek-harness\default-workspace\deepseek-pulse"
git init -b main
git add .
git commit -m "DeepSeek Pulse 1.0.1: dashboard token / giá cao điểm / số dư DeepSeek"
git remote add origin https://github.com/<user>/deepseek-pulse.git
git push -u origin main
```

Lần push đầu sẽ hỏi đăng nhập: dùng **Personal Access Token** (github.com → Settings → Developer settings → Tokens (classic) → scope `repo`) thay cho mật khẩu.

## 3. Sau khi có repo

Người khác (hoặc máy khác của bạn) cài bằng một lệnh trong agent Harness:

```
plugin_manager  action=install_bundle  target=github:<user>/deepseek-pulse
```

hoặc bằng pnpm trong profile:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "github:<user>/deepseek-pulse"
```

rồi thêm `"deepseek-pulse"` vào `dsh.profile.bundles` trong `package.json` của profile và khởi động lại Harness.

Cập nhật về sau: commit + push, người dùng chạy lại `install_bundle` (hoặc `pnpm update deepseek-pulse`).

## 4. Gợi ý cho repo "xịn" hơn

- Thêm topic trên GitHub: `deepseek-harness`, `dsh-plugin`, `dashboard`.
- Gắn tag phiên bản: `git tag v1.0.1 && git push --tags`, rồi tạo Release đính kèm mô tả thay đổi.
- Nếu sau này muốn phát hành npm: đổi `name` thành `@<user>/deepseek-pulse` (scope của bạn), chạy `npm publish --access public` — nhớ cập nhật `cordis.patch.yml` theo tên mới.
- Ảnh trong `docs/` chiếm ~1 MB; có thể nén hoặc bỏ nếu muốn repo nhẹ.

## 5. Checklist trước khi bấm Publish

- [ ] Đã điền tên trong `LICENSE`
- [ ] `package.json` không còn `private: true` (đã bỏ sẵn)
- [ ] Không có đường dẫn tuyệt đối của riêng bạn trong README/`config.json`
- [ ] `docs/*.png` là ảnh bạn muốn công khai (có tên phiên làm việc trong bảng — cân nhắc che nếu cần)
- [ ] `node server.mjs` vẫn chạy được từ thư mục này
