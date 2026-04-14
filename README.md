# Bảng Tin — Hướng dẫn deploy Vercel

## Cấu trúc thư mục
```
bang-tin/
├── api/
│   ├── news.js          ← API lấy tin RSS + AI tóm tắt
│   └── summarize.js     ← API AI đọc bài từ URL
├── public/
│   ├── index.html       ← Giao diện chính
│   ├── data.json        ← Dữ liệu Lời Bác Dạy
│   ├── data_cauhoi.json ← Dữ liệu Câu Hỏi Ngày
│   └── data_tuanphapluat.json ← Dữ liệu Tuần Pháp Luật
├── vercel.json
└── package.json
```

## Deploy lên Vercel

1. Upload toàn bộ thư mục này lên GitHub
2. Vào vercel.com → Import project từ GitHub
3. Cấu hình Environment Variables:
   - `AI_API_KEY` = API key Anthropic của bạn
   - `AI_BASE_URL` = https://api.anthropic.com (hoặc gateway khác)
   - `AI_MODEL` = claude-haiku-4-5-20251001

## Các lỗi đã sửa
- Thiếu file `api/summarize.js` → nút AI tóm tắt bài báo bị lỗi 404
- `buildMonthChips` truyền class rỗng → chip Tháng không highlight khi active
- Cache news chỉ lưu khi không dùng AI → chuyển tab mất kết quả AI
- Xử lý `aiError` field từ news.js khi AI lỗi
- Thêm CSS `.red-chip` còn thiếu cho Tab 1 & Tab 2
- `vercel.json` thêm `outputDirectory: public` để Vercel serve đúng thư mục
