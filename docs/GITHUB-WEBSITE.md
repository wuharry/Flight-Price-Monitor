# GitHub 部署多人網站

網站使用 GitHub Pages；Supabase Auth 處理登入，PostgreSQL RLS 隔離每位使用者資料；既有 Cloud Run Job 查價。網站不包含 service_role、Secret key 或 Resend key，也不提供管理員部署設定給一般使用者。

## 一次性設定

1. Supabase SQL Editor：先執行 `src/db/schema.sql`，再執行完整 `src/db/multi-user.sql`。既有無 user_id 的規則保留為管理員專用，不會分配給第一位註冊者。以後若重跑 schema.sql，也要再跑 multi-user.sql 才會恢復網站權限。
2. Supabase 專案 API Keys 複製 **Publishable key**（`sb_publishable_...`）或舊版 `anon` key。
3. GitHub repository → Settings → Secrets and variables → Actions → Variables，新增 `SUPABASE_PUBLISHABLE_KEY`。選填 `SUPABASE_URL`（預設此專案的 API URL）。不能填 secret/service_role；建置會拒絕非公開 key。
4. GitHub → Settings → Pages → Source 選 GitHub Actions。
5. Actions → Deploy website → Run workflow。之後推送 main 會自動測試並部署。
6. 網址預期為 `https://wuharry.github.io/Flight-Price-Monitor/`，實際網址以 Deploy website 的 deployment URL 為準。
7. Supabase → Authentication → URL Configuration：Site URL 和 Redirect URLs 加入上面的完整網址（包括結尾 `/`）。開啟 Email provider 與 email confirmation。

第一位使用者開啟網站後自行註冊、設定密碼並驗證信箱。沒有共用預設密碼，也沒有第一人自動取得管理員權限。每人最多 10 條規則，通知寄到目前已驗證的帳號信箱。

Supabase 預設寄信服務限制可寄送對象與流量；公開註冊前請配置 Authentication 的 Custom SMTP。使用 Resend SMTP 須先驗證寄件網域。Resend 測試寄件人 onboarding@resend.dev 也不能用來寄通知給任意使用者。這兩種郵件（帳號驗證與票價通知）是不同設定。

## 更新背景查價程式（多人收件人支援）

網站部署不會自動更新 Cloud Run Job。原本的 v2 worker 仍使用全域收件信箱，所以請維持 preview，直到更新到本次程式。Cloud Shell 可直接從 GitHub 取得程式，不必再上傳壓縮包：

```bash
git clone https://github.com/wuharry/Flight-Price-Monitor.git "$HOME/flight-monitor-github"
cd "$HOME/flight-monitor-github"
gcloud builds submit --project=gen-lang-client-0118434625 --tag=asia-east1-docker.pkg.dev/gen-lang-client-0118434625/flight-monitor/monitor:multiuser .
```

若該資料夾已存在，進入後使用 `git pull --ff-only`，不要重複 clone。建置成功後：

```bash
gcloud run jobs update flight-monitor --project=gen-lang-client-0118434625 --region=asia-east1 --image=asia-east1-docker.pkg.dev/gen-lang-client-0118434625/flight-monitor/monitor:multiuser --update-env-vars=EMAIL_MODE=preview
gcloud run jobs execute flight-monitor --project=gen-lang-client-0118434625 --region=asia-east1 --wait
gcloud run jobs logs read flight-monitor --project=gen-lang-client-0118434625 --region=asia-east1 --limit=80
```

完成真實查價、設定正式寄件網域後，才將 EMAIL_MODE 更新為 send。確認每位使用者只收到自己的通知後再啟用排程。已有 Cloud Scheduler 時不要同時開啟 GitHub 的 Flight monitor 排程，以免重複執行。

## 驗證

- `pnpm test`：含兩個使用者的資料庫 RLS 測試，涵蓋跨帳號讀寫、冒用 owner、歷史資料、通知資料與工作函式權限；寄件測試確保不回退至管理員信箱。
- `node scripts/test-web-browser.mjs`：Edge 瀏覽器登入、建立規則、停用、登出清除資料、手機版面測試。Supabase HTTP 使用明確模擬資料，不代表真實帳號驗證及寄信已測通。
- 真實環境：第一位使用者註冊並驗證 → 新增未來航線 → 手動執行 Job → 網站重新整理看到票價。再用第二帳號確認看不到第一位使用者的規則。

尚未驗證雲端真實查價、SMTP 送達、排程及長期多使用者負載。現有單一 Job 有 14 分鐘執行上限；使用者增多需再改成分批查價。
