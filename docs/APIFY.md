# Apify 手動查價與通知

這個私有 Actor 在 Apify 雲端執行，電腦關機後仍可由 Apify 主控台啟動。每次只執行一次；部署與執行程式不會建立排程、開啟桌面通知或購票。

2026-10-18 已在 Apify Free 完成真實查價與 Gmail 寄件接受驗證；收件匣送達另待收件人確認。執行識別碼與限制見 [實測紀錄](APIFY-TEST-RESULTS.md)。

網站使用者的單次查價串接與部署前提，另見 [叔叔使用的雲端網站](CLOUD-WEBSITE.md)。該功能必須先完成資料庫與後端部署；現有 Actor 的手動查價成功，不代表網站已串接完成。

報價來自未登入的 Google Flights，僅接受所選直飛台灣虎航行程中 `Tigerair Taiwan` 航空公司的含稅參考總價。這不是虎航 API，也未驗證 tigerLight、行李或付款手續費；Google 合作夥伴資訊可能有最多 24 小時延遲。Google 頁面未獨立驗證年份，請在訂票頁核對完整日期。這個價格來源的歷史與虎航官網歷史分開計算。

## 免費額度與費用限制

使用 Apify **Free、未綁付款方式**的帳戶。官方目前每個月度帳期提供 US$5 使用額度，不累積；用完會停止使用，直到下一帳期。程式建置、運算及儲存都會耗用免費額度，每次成本會隨載入時間與資源用量變動，不能保證無限免費。執行前應在 Billing 確認仍為 Free、沒有付款方式且額度足夠。

這是自製 Actor，`maxTotalChargeUsd` 不是所有平台資源費用的總額硬限制。零額外付款依賴帳戶的 Free 硬停政策與未啟用付費方案，不能只靠該 run 欄位。

預設每次 1 GB 記憶體、180 秒平台期限；程式 165 秒後終止。每次只允許一個查詢或一條監控規則。不使用付費 Actor、代理、Browserless、CAPTCHA 服務或重試循環。請保持 Restart on error 關閉、Standby 關閉。不要在 Schedules 建立排程。

官方說明：[Apify Pricing](https://apify.com/pricing)、[Actor 執行](https://docs.apify.com/platform/actors/running)、[環境變數與 Secret](https://docs.apify.com/actors/development/programming-interface/environment-variables)。

## 部署

原始碼入口是 `src/apify/main.ts`，部署描述是 `.actor/actor.json`。以此儲存庫作為建置來源，或執行 `pnpm build:apify`，使用 `artifacts/apify-deploy/` 內的 ESM bundle 與部署檔。Dockerfile 使用固定版本的 Playwright 映像；執行相依包含 `apify`、`playwright-core`、`nodemailer`、`zod`、`dotenv`。儲存庫建置使用 lockfile；bundle 部署固定上述直接相依版本，間接相依由 npm 解析。第三方授權保留在儲存庫的 notice 檔及部署 bundle 開頭。

不要上傳 `.env`、桌面 EXE 設定、Gmail 密碼、瀏覽器 Cookie 或本機監控歷史。`.actor/actor.json` 不包含 `environmentVariables`，以免後續建置覆寫主控台中的 Runtime Secret。

## Gmail Runtime Secret

在私有 Actor 的 Source → Environment variables 新增以下兩個變數，將 **Secret** 開啟；**Apply environment variables also to the build process** 維持關閉：

- `GMAIL_USER`：寄件 Gmail 帳號。
- `GMAIL_APP_PASSWORD`：該帳號的 Google 應用程式密碼，16 個英文字母。不要貼到聊天、Input、程式碼、Git 或建置紀錄。

其他一般 Runtime 變數：

- `EMAIL_PROVIDER=gmail`
- `NOTIFICATION_TO_EMAIL=recipient@example.com`（填入已確認的實際收件信箱；此處僅為範例）
- `EMAIL_MODE=preview`（預設不實寄；`test-email` 動作會要求可用的實寄設定）
- 可選 `EMAIL_FROM_NAME=Flight Monitor`、`EMAIL_REPLY_TO`。

如要執行真實監控通知，先將 `EMAIL_MODE=send`；只查價的 `check` 仍一律不寄信。這個 Actor 只有一個環境收件人，不接受帶 `userId` 的多人規則。

## 三個單次動作

查價時，在 Input 填入下列範例。使用自己的航線、日期與成人人數；這組只是測試條件。單程請省略 `returnDate`。目前金額單位限 TWD，旅客限 1～9 位成人。

```json
{
  "action": "check",
  "provider": "google-flights",
  "search": {
    "origin": "TPE",
    "destination": "NRT",
    "departureDate": "2027-02-10",
    "returnDate": "2027-02-16",
    "adults": 1,
    "currency": "TWD"
  }
}
```

按 Start 後等待該次完成，在 Storage → Key-value store → `OUTPUT` 查看完整結果。只有確定選到虎航且取得航空公司賣方參考價，才會回報成功；查詢受阻、條件不符或沒有可用報價會失敗，不會拿其他航空公司或旅行社價格代替。

將同一份 Input 的 `action` 改為 `test-email`，即可在**本次真實查價成功後**寄出一封查價與寄信測試。它不偽造降價、不依賴價格門檻、不更新監控歷史；查價失敗就不寄信。主旨含唯一測試 ID，`OUTPUT.email` 有該 ID 與寄件服務回執。

Gmail SMTP 或 Resend 回覆接受，只代表寄件服務接受這封信；**不代表收件人收件匣已送達**。請收件人用測試 ID 搜尋收件匣及垃圾郵件；必要時使用 `messageId` 查詢郵件紀錄。

執行一次正式監控時，將 `search` 移除、改成一條 `watchRules`：

```json
{
  "action": "monitor",
  "provider": "google-flights",
  "watchRules": [{
    "id": "uncle-tpe-nrt",
    "provider": "google-flights",
    "origin": "TPE",
    "destination": "NRT",
    "departureDate": "2027-02-10",
    "returnDate": "2027-02-16",
    "adults": 1,
    "currency": "TWD",
    "targetPrice": 6500,
    "notifyNewLow": true,
    "newLowDays": 30,
    "enabled": true
  }]
}
```

`id` 請穩定沿用，以便比較歷史。可選條件還有 `dropAmount` 或 `dropPercent`。只有符合原有警示條件，且 `EMAIL_MODE=send` 時才會實寄；首次查價不會自動認定為新低。

監控會使用以 Actor ID 區分的 named Key-value store 保留歷史與待寄通知，使用 named Request queue 的單一請求作原子鎖，避免同時執行覆寫資料。該虛擬鎖網址不會送出網路請求。先持久化價格及 outbox，再寄通知；同一規則、同一來源與條件、同價通知有 24 小時去重。程式崩潰後鎖最多保留 10 分鐘；不要手動把 run timeout 改到 10 分鐘以上。Gmail 本身無 API 冪等保證，寄件被接受與 outbox 更新之間若中斷，後續重試仍可能重複寄送。

未來若決定排程，必須另外確認免費額度、執行頻率與通知規則。本次部署不啟用任何排程。
