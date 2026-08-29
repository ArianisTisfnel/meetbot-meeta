# backend/assets

## NotoSansTC-Regular.otf

- 用途：`src/routes/pdf.ts` 產生繁體中文 PDF 的內嵌字型（PDFKit 內建 fontkit 會自動子集化，
  只把用到的字打包進 PDF，所以 5.4MB 的字型檔不會變成 5.4MB 的 PDF）。
- 來源：Google Noto CJK — https://github.com/notofonts/noto-cjk （Sans / TC，Regular，Static OTF）
- 授權：SIL Open Font License 1.1，全文見同目錄 `NotoSansTC-LICENSE.txt`
  （抓自 https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE ）。
- 只放 Regular 一種字重。加粗體要再進一個 5.4MB 檔，版面層次靠字級做就好。
