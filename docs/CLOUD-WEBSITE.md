# 叔叔使用的雲端查價網站

這次沿用 GitHub Pages 網站及 Supabase 的登入、資料庫與使用者資料隔離；Apify 負責執行已通過雲端實測的 Google Flights 查價。不新增 Google Cloud 服務。所有程式都是按需執行，這份設定不會建立或啟用排程。

## 使用方式

1. 用手機或電腦開網站，以自己的已驗證 Email 登入。
2. 填出發／抵達機場、去回程日期、成人人數與目標總價，按「儲存監控」。
3. 在該航線按「立即查價」。網站顯示執行中及完成結果，重新開網頁也能查看結果。

查價開始後在雲端繼續執行，使用者不需要保持電腦開機。**目前不會定時自動查價**；儲存條件、重新整理或打開網站，都不會開始下一次查價。通知顯示「預覽」時沒有寄信；「寄件服務已接受」也不等於收件匣已送達。

參考價格來源是 Google Flights 的台灣虎航直飛行程。它是選定行程的含稅參考總價，不保證是所有組合最低價，也未確認為 tigerLight 票種；來源資料可能延遲最多約 24 小時。付款、行李等選購項目及實際可售價格請以航空公司結帳頁為準。較舊的虎航官網紀錄與新來源分別標示，避免混為同一種票價。

## 服務連接方式

網站使用已登入帳號呼叫 Supabase Edge Function `cloud-check`，只提交自己已儲存的規則 ID。後端再次驗證登入、信箱、規則所有權、日期、啟用狀態及用量限制，再啟動私人 Apify Actor。前端不能指定任意 Actor input、收件人或雲端資源。結果寫回 Supabase，網站以使用者自己的 RLS 權限讀取。

Apify API token、Supabase server key 與 Gmail 應用程式密碼都只留在後端，不能放入網站 bundle、GitHub Pages 變數、公開儲存庫、網址或日誌。Apify Actor 的環境變數不得套用到建置環境。

## 免費用量與重複點擊

網站查價共用最多每日 8 次、每個台北時間曆月 240 次的保守限制；兩次啟動至少間隔 2 分鐘，同時間只允許一個網站工作。這些限制涵蓋所有允許的帳號及航線；刪除規則不會退還次數。等待逾時或雲端開始回應不明時，不自動重送，先查看工作狀態。

Actor 固定 1 GB、180 秒上限。按目前 Free 計價，跑滿 180 秒的運算約 US$0.01／次，31 天每天 8 次的運算約 US$2.48，另有建置、資料儲存、流量等用量。這些次數限制不是金額保證，Apify 主控台中的其他工作及手動啟動也會共用帳戶額度；曆月也不一定等於平台帳期。

不產生額外帳單的條件是保留 Apify **Free、不加付款方式、不升級**，額度耗盡後平台停止服務；Supabase 也維持 Free。不能為了恢復服務按升級或付費加購。Supabase Free 長期無活動可能暫停，需由管理員恢復；免費服務不提供不中斷保證。

官方說明：[Apify Free 額度耗盡行為](https://docs.apify.com/account/subscriptions)、[Apify 計價](https://apify.com/pricing)、[Supabase Free 額度及暫停](https://supabase.com/pricing)。

## 管理員部署前檢查

1. 確認目前可存取正確的 Supabase 專案，且組織為 Free。不要使用其他專案的資料庫替代。
2. 依序執行 `src/db/schema.sql`、`src/db/multi-user.sql`、`src/db/cloud-check.sql`。遷移可重跑，保留原規則及歷史；不會把原規則自動改成另一種來源。
3. 部署 `supabase/functions/cloud-check`，保留平台 JWT 驗證及函式內的 `auth.getUser()` 驗證。設定後端 `CLOUD_CHECK_ALLOWED_ORIGINS`（網站 origin，逗號分隔）及 `CLOUD_CHECK_ALLOWED_EMAILS`（已驗證帳號信箱，逗號分隔）；名單預設空白，不允許任何帳號啟動查價，初始僅加入叔叔及管理員。
4. 將僅供私人 Actor 的 Apify token 存入 Supabase Edge Secret `APIFY_CLOUD_CHECK_TOKEN`；以 `APIFY_CLOUD_CHECK_ACTOR_ID`、`APIFY_CLOUD_CHECK_BUILD` 固定本次 Actor 與建置版本。將正確的 `SUPABASE_URL` 及 `SUPABASE_SERVICE_ROLE_KEY` 存入私人 Apify Actor Runtime Secret。這是新的跨服務存取權，必須由帳號持有人確認後才儲存。不要整份上傳 `.env`。
5. 用 `pnpm build:apify` 產生白名單部署檔，更新 Actor；保留固定記憶體與逾時，不建立排程。Edge 設定應指向本次驗證完成的 Actor build。
6. 網站建置只使用該 Supabase 專案的 URL 與 publishable／anon 公開金鑰。
7. 在 Supabase → Authentication → URL Configuration，把 **Site URL** 設為正式 GitHub Pages 完整網址，並在 **Redirect URLs** 加入同一網址，例如 `https://wuharry.github.io/Flight-Price-Monitor/`。必須包含專案路徑與結尾 `/`，不能只填網域；若正式 deployment URL 不同，兩處都改用實際完整網址。這個網址用於註冊驗證及重設密碼返回網站。確認 Email provider、信箱驗證及驗證信投遞可用，實測登入／註冊後再發送連結給叔叔。
8. 從網站測試一個真實條件，確認只有該使用者的規則被查價、結果回寫、狀態可在重開網頁後恢復；另由收件人確認實際收信，才能記為送達驗證完成。

### 目前驗證狀態

截至 2026-10-18（Asia/Taipei），已恢復原 Supabase 專案的管理存取權，確認其組織為 Free，完成三份資料庫遷移及 `cloud-check` Edge Function 部署。沒有改用其他資料庫，也沒有建立排程或新增付費方案。

Google Flights 在 Apify 的真實查價與 Gmail 寄件服務接受已完成，見 [實測紀錄](APIFY-TEST-RESULTS.md)。支援網站工作的新版 Actor 原始碼已上傳，但尚未建置；新增跨服務 Secret 的儲存授權、設定及正式網站完整流程驗證仍待完成。這些前提完成前，不能將網站串接視為已上線，亦未宣稱收件匣送達。

2026-10-18 本次程式驗證：97 項核心／SQL／權限測試、5 項網站邏輯測試通過；型別檢查、Actor 打包與差異檢查通過。Chrome 本機模擬操作完成登入、建立 Google Flights 行程、單次查價、執行期間按鈕停用、票價與預覽狀態呈現、重載恢復結果、停用行程阻止查價、登出清除資料。手機寬度 390px 測試無橫向溢出，沒有瀏覽器警告或錯誤。這些網站操作使用虛構資料，不呼叫 Apify、不寄信；畫面留存於 `artifacts/website-cloud/`。
