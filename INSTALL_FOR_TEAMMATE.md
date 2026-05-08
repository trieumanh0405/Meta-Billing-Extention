# Hướng Dẫn Cài Meta Billing Scraper Cho Teammate

## 1. Load Extension

1. Giải nén file zip được gửi.
2. Mở Chrome.
3. Vào `chrome://extensions`.
4. Bật `Developer mode`.
5. Bấm `Load unpacked`.
6. Chọn folder vừa giải nén, folder này phải chứa `manifest.json`.
7. Pin extension lên toolbar nếu cần.

## 2. Google OAuth

Nếu teammate bấm extension mà Google auth fail, làm như sau:

1. Vào `chrome://extensions`.
2. Copy `Extension ID`.
3. Vào GCP Console → `APIs & Services > Credentials`.
4. Tạo OAuth Client ID loại `Chrome Extension`.
5. Dán Extension ID vào OAuth client.
6. Copy OAuth Client ID mới.
7. Mở `manifest.json`.
8. Thay `oauth2.client_id`.
9. Reload extension trong `chrome://extensions`.

## 3. Cấu Hình Options

Right-click extension icon → `Options`, rồi điền:

- `Google Sheet ID`: ID của file Google Sheet.
- `Google Drive Folder ID`: folder để upload invoice PDFs.
- `Business Manager ID`: business ID nếu chạy multi-account.
- `Meta Token`: optional, chỉ cần nếu dùng auto-detect.
- `Delay Between Accounts`: để `20000` hoặc cao hơn.

Bấm `Save`.

## 4. Sheet Master

Google Sheet cần có tab `Master` với header dòng 1:

```text
Date | Ad Account Name | Transaction ID | Link | Amount (có VAT) | Payment Method | Payment Status | VAT invoice ID
```

## 5. Cách Chạy An Toàn

### Single Page

1. Login Meta Business Suite.
2. Mở billing page của 1 ad account.
3. Click extension.
4. Chọn `Current Page`.
5. Bấm `Scrape This Page`.

### Multi Account

1. Click extension.
2. Chọn tab `Multi Account`.
3. Chọn date range.
4. Nên nhập account IDs thủ công, 3-5 accounts/lần.
5. Bấm `Start Scraping`.
6. Theo dõi log.

Không nên auto-detect rồi chạy toàn bộ 30-40 accounts một lượt nếu vừa bị Meta temporary block.

## 6. Nếu Meta Temporarily Blocked

Nếu thấy trang `You're Temporarily Blocked`:

1. Dừng scrape ngay.
2. Không resume job cũ.
3. Bấm `Refresh Session` sau khi mở lại popup.
4. Chờ ít nhất 24h trước khi scrape lại.
5. Lần sau chạy batch nhỏ hơn, nghỉ 30-60 phút giữa các batch.

## 7. Duplicate Safety

Chạy lại cùng invoice không tạo duplicate trong `Master`.

Extension upsert theo `Transaction ID`:

- Có Transaction ID rồi → update dòng cũ.
- Chưa có → append dòng mới.
