# Google Flights / Apify 單次驗證

日期：2026-10-18（Asia/Taipei）。本功能以既有公開主線為基底實作，未改動原目錄的 Windows 打包修改。這份公開紀錄省略私人帳號、資源識別碼、Console 連結與郵件追蹤識別碼；完整驗證證據由部署管理員私下保存。

## 程式驗證

- 初次雲端查價及寄信版本：`pnpm test` 的 84 項測試通過。
- 後續網站串接版本：97 項核心／SQL／權限測試及 5 項網站邏輯測試通過。
- `pnpm check-types`、`pnpm build:apify` 與 `git diff --check` 通過。
- Google URL 驗證完整日期、旅客數、航點、直飛與航空公司；解析只接受 Tigerair Taiwan 航空公司賣方的含稅參考總價。
- 測試包括錯誤來源／日期／幣別不寄信、Google 價格模板、持久 outbox、並行鎖，以及寄件成功但儲存失敗時同次執行不重寄。

## 實際雲端查價

使用私人 Actor 與 Apify Free，以手動 Start 執行，沒有建立排程、Task、整合通知或付費代理。

測試條件：TPE → NRT，2027-02-10 出發、2027-02-16 回程，1 位成人，TWD。

- 成功執行狀態 Succeeded、exit 0、22 秒（含容器啟動），輸出 1 筆。
- 真實查價結果：**TWD 16,088**，價格來源 `google-flights-tigerair-reference-including-tax-v1`。
- 此次 `action=check`，`emailStatus=not-requested`，未寄信。
- 管理員保存了所用部署檔的雜湊及私人執行紀錄，以供追查版本。

部署後重新讀取帳戶 Billing：仍為 Free、沒有付款方式，月度使用顯示 US$0.06 / 5（包含先前測試），排程 0、Task 0、執行中的 run 0。建置與查詢扣免費額度，沒有升級或額外付款。

先前一般搜尋在雲端選完航班後，Google 的動態頁面顯示「系統發生錯誤」。已改成每次選取後，驗證動態公開行程網址並正常導覽至下一頁；最多三個 Google 公開頁面導覽，維持 80 秒查詢期限。沒有重放私人 API、登入、解驗證碼或購票。

這是所選虎航直飛行程的 Google 參考總價，未驗證 tigerLight、行李、稅費拆分或官網即時結帳價。Google 合作夥伴資料可能延遲最多 24 小時；完整年份由查詢及選定航班網址驗證，頁面僅顯示月日。

## 實際雲端寄信

使用者確認授權後，沿用既有 Gmail 寄件帳號及應用程式密碼，存入同一私人 Actor 的兩個加密 Runtime Secret。沒有上傳整份 `.env`；「Apply environment variables also to the build process」保持關閉。未在程式碼、Input 或紀錄中保存密碼。

- 套用寄信設定後的程式 bundle 與查價成功版本相同。
- 實寄執行狀態 Succeeded、exit 0、23 秒，輸出 1 筆。
- `action=test-email`，重新取得真實 **TWD 16,088** 報價後才寄信；不偽造門檻觸發或降價。
- 固定收件人為使用者本次指定信箱；Gmail SMTP 已接受，`emailStatus=accepted`。
- 主旨包含查價與寄信測試字樣、唯一測試識別碼及實際查價結果；完整主旨、測試識別碼與 Gmail Message-ID 僅保留於私人操作紀錄。

**SMTP 接受已驗證；收件匣送達仍待收件人確認。** 已請收件人檢查收件匣及垃圾郵件，尚未宣稱實際收到。

實寄後已把 Console 預設 Input 恢復為 `action=check`，沒有再啟動；`EMAIL_MODE=preview` 保留，明確選 `test-email` 才會實寄測試。實寄後重新確認仍為 Free、沒有付款方式、月度顯示 US$0.06 / 5、排程 0、Task 0、執行中 run 0。

上述查價與寄信實測不代表新版網站已完成正式端到端驗證。網站的資料庫、Edge Function、新版 Actor 建置與跨服務設定狀態見 [雲端網站說明](CLOUD-WEBSITE.md)；操作步驟見 [Apify 說明](APIFY.md)。
