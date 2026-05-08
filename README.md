# Meta Invoice Campaign Extractor Apps Script

Folder này chứa code Google Apps Script để extract campaign-level amount từ PDF
invoice Meta đã được Chrome extension ghi vào tab `Master`.

Rule hiện tại: script chỉ extract invoice khi dòng trong `Master` có đủ:

- `Payment Status` = `Paid`
- `VAT invoice ID` không rỗng
- `Link` PDF Google Drive không rỗng

Dòng `Failed`, dòng chưa có `VAT invoice ID`, hoặc dòng chưa có `Link` sẽ không
gọi Gemini API.

## Files

- `Code.gs` - paste file này vào Apps Script bound với Google Sheet.
- `appsscript.json` - manifest tùy chọn nếu muốn khai báo scope rõ ràng.

## Setup Lần Đầu

1. Mở Google Sheet `Meta Ad Invoice 2026`.
2. Vào `Extensions > Apps Script`.
3. Paste toàn bộ nội dung `apps-script/Code.gs` vào file `Code.gs`.
4. Nếu muốn dùng manifest:
   - Vào `Project Settings`.
   - Bật `Show "appsscript.json" manifest file in editor`.
   - Mở `appsscript.json`.
   - Paste nội dung `apps-script/appsscript.json`.
5. Vào `Project Settings > Script properties`.
6. Thêm property:
   - Name: `GEMINI_API_KEY`
   - Value: API key Gemini paid tier của bạn
7. Quay lại editor, chọn function `setup`.
8. Bấm `Run`.
9. Approve quyền Spreadsheet, Drive, external request, và trigger.
10. Reload Google Sheet.
11. Kiểm tra trên thanh menu có menu `Invoice Extractor`.

## Ý Nghĩa Các Function Trong Invoice Extractor

### `setup()`

Dùng khi setup lần đầu hoặc muốn cài lại trigger.

Function này sẽ:

- Tạo tab `_Extraction_Log` nếu chưa có.
- Set header cho `_Extraction_Log`.
- Hide tab `_Extraction_Log` nếu có thể.
- Xóa trigger cũ của `processPendingInvoices`.
- Cài lại trigger chạy mỗi 5 phút.
- Kiểm tra có `GEMINI_API_KEY` trong Script Properties chưa.

Thao tác:

1. Trong Google Sheet, bấm `Invoice Extractor > Setup / install 5-min trigger`.
2. Nếu Apps Script hỏi quyền, approve.
3. Sau khi xong, vào Apps Script `Triggers` để confirm có trigger:
   `processPendingInvoices` chạy time-driven mỗi 5 phút.

### `processPendingInvoices()`

Dùng để scan tab `Master` và xử lý các invoice hợp lệ đang chờ.

Function này sẽ:

- Scan tối đa 5 dòng pending mỗi lần chạy.
- Chỉ lấy dòng `Payment Status = Paid`.
- Chỉ lấy dòng có `VAT invoice ID`.
- Chỉ lấy dòng có Drive PDF `Link`.
- Bỏ qua dòng đã `SUCCESS`.
- Gọi Gemini để extract campaign trong PDF.
- Ghi kết quả vào tab tháng `YYYY-MM`.
- Log trạng thái vào `_Extraction_Log`.

Thao tác test thủ công:

1. Bấm `Invoice Extractor > Process pending invoices now`.
2. Chờ Apps Script chạy xong.
3. Kiểm tra tab tháng, ví dụ `2026-04`.
4. Mở `_Extraction_Log` nếu cần debug.

Khi trigger 5 phút chạy tự động, function này cũng chính là function được gọi.
Nếu không có dòng pending hợp lệ, Gemini API không được gọi.

### `processSelectedMasterRow()`

Dùng để test đúng 1 dòng bạn đang chọn trong tab `Master`.

Function này rất hữu ích khi test invoice đầu tiên.

Thao tác:

1. Vào tab `Master`.
2. Chọn bất kỳ cell nào trên dòng invoice muốn test.
3. Dòng đó phải có:
   - `Payment Status` = `Paid`
   - `VAT invoice ID` không rỗng
   - `Link` không rỗng
4. Bấm `Invoice Extractor > Process selected Master row`.
5. Nếu thành công:
   - Tab tháng tương ứng sẽ được tạo nếu chưa có.
   - Dữ liệu được ghi theo format:
     `Date`, `VAT invoice ID`, `Campaign`, `Amount (chưa VAT)`.
   - `_Extraction_Log` có status `SUCCESS`.
6. Chạy lại cùng dòng lần nữa để test duplicate.
7. Kết quả mong đợi: không nhân đôi dòng; script replace output cũ của cùng
   `VAT invoice ID`.

Nếu chọn dòng `Failed`, script sẽ không gọi Gemini và log:
`SKIPPED_PAYMENT_STATUS`.

Nếu chọn dòng `Paid` nhưng chưa có `VAT invoice ID`, script sẽ không gọi Gemini
và log: `WAITING_FOR_VAT_INVOICE_ID`.

### `resetSelectedInvoice()`

Dùng để xóa output và log của 1 invoice để test lại từ đầu.

Thao tác:

1. Vào tab `Master`.
2. Chọn bất kỳ cell nào trên dòng invoice muốn reset.
3. Bấm `Invoice Extractor > Reset selected invoice`.
4. Script sẽ:
   - Xóa các dòng trong tab tháng có cùng `VAT invoice ID`.
   - Xóa dòng tương ứng trong `_Extraction_Log`.
5. Sau đó có thể chạy lại `Process selected Master row`.

### `onOpen()`

Function này tự chạy khi mở Google Sheet.

Nó tạo menu `Invoice Extractor` trên thanh menu Google Sheet. Bạn không cần chạy
thủ công, chỉ cần reload Sheet nếu chưa thấy menu.

## Trạng Thái Trong `_Extraction_Log`

- `SUCCESS`: đã extract xong và ghi vào tab tháng.
- `PROCESSING`: đang xử lý dòng đó.
- `WAITING_FOR_LINK`: dòng chưa có Drive PDF link, chưa gọi Gemini.
- `WAITING_FOR_VAT_INVOICE_ID`: dòng chưa có VAT invoice ID, chưa gọi Gemini.
- `SKIPPED_PAYMENT_STATUS`: Payment Status không phải `Paid`, chưa gọi Gemini.
- `ERROR`: có lỗi khi đọc Drive PDF, gọi Gemini, parse JSON, hoặc ghi Sheet.

Dòng `ERROR` sẽ retry đến khi `Retry Count` đạt 2. Sau đó script bỏ qua dòng đó
cho tới khi bạn reset bằng `Reset selected invoice`.

## Manual Test Flow Đề Xuất

1. Chọn dòng `Master` có `Payment Status = Paid` và có `VAT invoice ID`.
2. Chạy `Invoice Extractor > Process selected Master row`.
3. Confirm tab tháng có campaign rows.
4. Chạy lại cùng dòng.
5. Confirm không duplicate.
6. Chọn dòng `Payment Status = Failed`.
7. Chạy `Process selected Master row`.
8. Confirm tab tháng không có row mới và `_Extraction_Log` là
   `SKIPPED_PAYMENT_STATUS`.
9. Chọn dòng `Paid` nhưng xóa tạm `VAT invoice ID`.
10. Chạy `Process selected Master row`.
11. Confirm không gọi Gemini và `_Extraction_Log` là
    `WAITING_FOR_VAT_INVOICE_ID`.
12. Restore lại `VAT invoice ID` nếu bạn đã xóa để test.
