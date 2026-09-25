# Flight Price Monitor

TypeScript 機票價格監控器。目前以 Playwright 開啟台灣虎航的正常訂票頁，讀取官方頁面自己的 GraphQL 票價回應。已移除固定模擬票價；查不到、售完、驗證失敗或資料格式改變時回報失敗，不寫入假價格。

- 監控直飛 tigerLight：全部成人、去回程未稅價與稅費分開保存。未含付款手續費、加購行李、餐點、選位。
- 價格達標、近 30 日新低、約 24 小時跌幅金額／比例。首次觀測不當成新低。
- 通知去重、持久化待寄紀錄、寄送失敗重試與 Resend idempotency key。
- 本機 JSON 儲存，或 Supabase PostgreSQL；價格與待寄紀錄在同一交易寫入。
- 獨立 Provider 介面；新增航空公司時自行實作該公司的票價格式與驗證。
- 單次執行、常駐排程、GitHub Actions、Cloud Run Job 部署檔。

## 開始使用

需要 Node.js 22+、pnpm 10.23.0。在 PowerShell：

~~~powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
Copy-Item watch-rules.example.json watch-rules.json
pnpm exec playwright install chromium
pnpm test
pnpm monitor
~~~

修改 watch-rules.json 的日期、航線、人數與門檻。預設本地儲存與 Email 預覽；資料在 .data/，不會寄信。Windows 已安裝 Edge 時可設定 BROWSER_CHANNEL=msedge。

| 指令 | 用途 |
|---|---|
| pnpm build | 編譯 TypeScript |
| pnpm check-types | 型別檢查 |
| pnpm test | 編譯並執行離線測試（含 PGlite PostgreSQL） |
| pnpm monitor | 執行一次；任何規則或寄信失敗會 exit 1 |
| pnpm start | 每 180 分鐘執行，避免重疊 |
| pnpm dev | 原始碼開發模式 |
| pnpm test:browser --headed --interact | Edge 實際操作、票價核對與截圖 |
| pnpm test:browser --headed --adults 2 | 一般 Edge，兩位成人 |
| pnpm test:browser --headed --one-way | 一般 Edge，單程 |
| pnpm inspect:tigerair --headed --channel msedge | 擷取經遮蔽的官方 XHR/JSON 與截圖 |

一般 monitor 使用 .env 的瀏覽器設定；test:browser 預設使用本機 Edge，可傳 --channel chromium。有視窗模式需傳 --headed；省略時為無頭模式。此次無頭 Edge 被虎航回覆 Access Denied，有視窗模式通過；雲端部署使用 Xvfb，一定先手動驗證該環境。瀏覽器測試直接訪問航空公司；單元／資料庫測試不會查價或寄信。測試產物放在 artifacts/，不提交至 Git。

## 票價來源與限制

2026-09-25 的實測找到 https://api-book.tigerairtw.com/graphql 的 appFlightSearchResult，
內含 ADT 的 discountedTotalAmount、taxAmount、可售座位與票種。建立搜尋需要等待室及驗證 token，
目前使用隔離瀏覽器自動走官方流程；不硬編 token，也不宣稱支援未驗證的純 HTTP API。
不使用 HTML 正則抓價格，不重播其他使用者的 session。

監控只處理 TWD、1–9 位成人與直飛 tigerLight。比較口徑及航線／日期／人數有指紋，
設定改變後不會沿用不同條件的歷史。回程必須晚於去程抵達。官網未來更改 API 時需更新 parser，
雲端 IP 的驗證行為也需在部署後測試。查價與真實結帳價格可能不同。

[完整部署步驟](docs/DEPLOYMENT.md) · [測試結果與修正紀錄](docs/TEST-RESULTS.md)

## 主要檔案

~~~text
src/providers/tigerair.ts         正常瀏覽器查詢與 GraphQL 攔截
src/providers/tigerair-parser.ts  嚴格票價驗證與最低可售組合
src/services/price.service.ts     查價、持久化、通知與執行鎖
src/services/alert.service.ts     價格規則（純函式）
src/services/email.service.ts     Resend API 與通知預覽
src/db/local.repository.ts        本地原子寫入與檔案鎖
src/db/price.repository.ts        Supabase 倉儲
src/db/schema.sql                 可重跑的 schema／migration／RPC
src/db/seed.sql                   可修改的監控範例
tests/                           票價、告警、儲存、寄信、資料庫測試
Dockerfile                       Cloud Run Job 映像
.github/workflows/               CI 與可選排程
~~~
