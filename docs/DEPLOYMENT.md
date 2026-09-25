# 部署 Flight Price Monitor

這是定時執行的 Node.js worker，沒有網頁伺服器。本機有視窗 Edge 已通過實測；無頭 Edge 被虎航回覆 Access Denied。可先用 Windows 工作排程器執行。雲端提供 **Cloud Run Job + Cloud Scheduler + Supabase + Resend** 與 GitHub Actions，使用一般瀏覽器搭配 Xvfb 虛擬顯示器；雲端來源 IP 尚未驗證，先手動確認再啟用排程。

## 1. 本機確認

需要 Node.js 22+、pnpm 10.23.0：

~~~powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
Copy-Item watch-rules.example.json watch-rules.json
pnpm exec playwright install chromium
pnpm test
pnpm monitor
~~~

修改 watch-rules.json 的航線、日期、人數與門檻。.env 預設 STORAGE=local、EMAIL_MODE=preview，只保存真實查價與輸出通知預覽。Windows 若已有 Edge，可改 BROWSER_CHANNEL=msedge，不必安裝 Chromium。pnpm test 會先 build；後續改程式請先 pnpm build。

資料保存在 .data/monitor.json，重啟後仍會沿用歷史。若程序遭強制終止留下 .data/monitor.lock，先確認沒有 monitor 正在執行，再刪除該鎖檔。pnpm start 為常駐模式；pnpm monitor 執行一次，失敗時 exit code 1。

### Windows 工作排程器（已有實測的本機模式）

先確認 .env 設為 BROWSER_CHANNEL=msedge、BROWSER_HEADLESS=false，並完成 pnpm build。開啟 Windows「工作排程器」→ 建立工作：

1. 一般：選「只有使用者登入時才執行」，讓 Edge 能開啟視窗。
2. 觸發程序：每天；重複工作間隔 3 小時、持續時間「無限期」。
3. 動作：程式填 powershell.exe；引數填 -NoProfile -File "E:\flight-monitor\scripts\run-monitor.ps1"；開始位置填 E:\flight-monitor。
4. 設定：工作已執行時「不要啟動新執行個體」，可啟用錯過排程後儘快執行。
5. 按「執行」驗證，最後執行結果應為 0x0，.data/monitor.json 應有新價格。

專案放在別處時替換路徑。電腦必須開機且使用者已登入；睡眠或登出期間不會持續監控。通知送出前仍須完成下方 Resend 設定，EMAIL_MODE 改 send。

## 2. Supabase 與寄信設定

1. 建立 Supabase 專案，在 SQL Editor 執行 [schema.sql](../src/db/schema.sql)。可重跑，既有資料會保留。新版不會使用舊版缺少 search_key 的模擬歷史。
2. 修改 [seed.sql](../src/db/seed.sql) 的日期、人數、目標後執行，或直接在 watch_rules 新增資料。seed 可重跑，不會重複新增相同 ID。
3. 取得專案 URL 與 **service role key**。此 key 只放伺服器端 Secret，不能放前端，也不能改用 anon key。
4. 在 Resend 驗證自己的寄件網域，建立 API key，決定收件信箱。
5. 正式環境設定以下變數：

| 變數 | 值 |
|---|---|
| STORAGE | supabase |
| SUPABASE_URL | https://你的專案.supabase.co |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key |
| EMAIL_MODE | 先 preview，確認成功後改 send |
| RESEND_API_KEY | Resend API key |
| NOTIFICATION_FROM_EMAIL | Flight Monitor <alerts@你的已驗證網域> |
| NOTIFICATION_TO_EMAIL | 你的收件信箱 |
| BROWSER_CHANNEL | chromium |
| BROWSER_HEADLESS | false（Linux 搭配 xvfb-run） |

監控價格為全部成人的直飛 tigerLight 含稅合計，**未含付款手續費、加購行李、餐點與選位**。target_price 必須填全部旅客合計。修改日期或人數會自動隔離舊價格；新增不同旅程通常直接新增一列更方便。

## 3. Cloud Run Job

以下命令在 **Google Cloud Shell / Bash** 執行，先將程式上傳或 clone 到 Cloud Shell。需啟用帳單。將 PROJECT_ID 換成自己的專案；建置與 IAM 變更需具備相應權限。

~~~bash
export PROJECT_ID="your-project-id"
export REGION="asia-east1"
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

gcloud artifacts repositories create flight-monitor \
  --repository-format=docker --location="$REGION"

gcloud iam service-accounts create flight-monitor
gcloud iam service-accounts create flight-monitor-scheduler

gcloud builds submit \
  --tag "$REGION-docker.pkg.dev/$PROJECT_ID/flight-monitor/monitor:latest" .
~~~

Dockerfile 使用與套件相同版本的 Playwright 映像，執行測試後僅保留 production 依賴。映像版本與套件必須一起更新，見 [Playwright Docker 文件](https://playwright.dev/docs/docker)。

在 Google Cloud Console → Secret Manager 建立以下三個 Secret，直接貼入值：

- flight-monitor-supabase-key
- flight-monitor-resend-key
- flight-monitor-recipient

授權執行身分讀取這三個 Secret：

~~~bash
for SECRET in flight-monitor-supabase-key flight-monitor-resend-key flight-monitor-recipient; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:flight-monitor@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

gcloud run jobs deploy flight-monitor \
  --image="$REGION-docker.pkg.dev/$PROJECT_ID/flight-monitor/monitor:latest" \
  --region="$REGION" \
  --service-account="flight-monitor@$PROJECT_ID.iam.gserviceaccount.com" \
  --tasks=1 --parallelism=1 --cpu=1 --memory=1Gi \
  --task-timeout=900s --max-retries=0 \
  --set-env-vars="STORAGE=supabase,EMAIL_MODE=preview,SUPABASE_URL=https://YOUR_PROJECT.supabase.co,NOTIFICATION_FROM_EMAIL=Flight Monitor <alerts@YOUR_DOMAIN>,BROWSER_HEADLESS=false,BROWSER_CHANNEL=chromium" \
  --set-secrets="SUPABASE_SERVICE_ROLE_KEY=flight-monitor-supabase-key:latest,RESEND_API_KEY=flight-monitor-resend-key:latest,NOTIFICATION_TO_EMAIL=flight-monitor-recipient:latest"

gcloud run jobs execute flight-monitor --region="$REGION" --wait
~~~

替換 Supabase URL 和寄件網域後再執行。若組織自訂了 Cloud Build 權限，建置服務帳號也需要 Artifact Registry 的寫入權限。Secret 設定方式見 [Cloud Run Job secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets)。

開啟 Cloud Run → Jobs → flight-monitor → Executions → Logs。確認 [Monitor] 的 checked 大於 0、failed=0，且 Supabase price_history 有一筆真實資料。雲端 IP 的等待室或驗證情況可能與本機不同，因此先手動跑一次。

確認後開啟寄信：

~~~bash
gcloud run jobs update flight-monitor --region="$REGION" \
  --update-env-vars="EMAIL_MODE=send"

gcloud run jobs add-iam-policy-binding flight-monitor --region="$REGION" \
  --member="serviceAccount:flight-monitor-scheduler@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http flight-monitor-every-3h \
  --location="$REGION" --schedule="17 */3 * * *" --time-zone="Asia/Taipei" \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/flight-monitor:run" \
  --http-method=POST --message-body='{}' \
  --headers="Content-Type=application/json" \
  --oauth-service-account-email="flight-monitor-scheduler@$PROJECT_ID.iam.gserviceaccount.com" \
  --max-retry-attempts=0
~~~

Cloud Scheduler 呼叫 Google Run API 使用 OAuth。也可在 Job 的 Triggers 分頁建立排程，見 [官方排程文件](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)。不需要公開 /monitor HTTP endpoint。

更新部署時重新執行 gcloud builds submit，再執行 gcloud run jobs update，指定同一映像路徑。

## 4. GitHub Actions（另一選項）

1. 將專案推到自己的 GitHub repo，保留 .github/workflows/。
2. Settings → Secrets and variables → Actions → Secrets 新增 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、RESEND_API_KEY、NOTIFICATION_TO_EMAIL。
3. Variables 新增 NOTIFICATION_FROM_EMAIL、EMAIL_MODE=preview、MONITOR_ENABLED=true。
4. Actions → Flight monitor → Run workflow，檢查票價與資料庫。
5. 確認後將 EMAIL_MODE 改 send；排程已設定每 3 小時一次，UTC 的第 17 分鐘。
6. 停用時將 MONITOR_ENABLED 改 false。

排程只在預設分支執行，也可能延遲；公開 repo 長期無活動時排程可能停用。額度取決於帳號與 repo，見 [GitHub schedule 文件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。GitHub runner 為暫存環境，必須用 Supabase。

## 5. 驗證通知與故障處理

- 寄信驗證：建立一條暫時測試規則，目標價設為高於真實含稅價格，手動執行一次。確認收信與 alerts.status=sent，再停用測試規則。這個步驟會真的寄信。
- 不達門檻沒有信是正常狀況；第一筆價格不當作新低。新低比較近 new_low_days 日；跌幅比較約 24 小時前、最舊 48 小時的歷史樣本。
- 相同查詢條件、相同價格在上次寄送後 24 小時內不重複通知。不同價格仍可通知。
- 寄信失敗的 pending 紀錄在下次執行重試，使用相同 Idempotency-Key。超過 23 小時改為 expired，避免超出 [Resend 的 24 小時冪等窗口](https://resend.com/docs/dashboard/emails/idempotency-keys) 後重複寄信。
- 查價遇到等待室、驗證或 API 變更會讓該規則失敗且不寫價格。使用 pnpm inspect:tigerair --headed --channel msedge 手動重現，不使用代理輪替或驗證繞過。
- Supabase monitor_locks 租約為 20 分鐘，程序最多執行 15 分鐘。被強制終止後等租約到期再手動重跑。
- 建議在所選平台設定執行失敗通知。Cloud Scheduler 成功觸發不代表 Job 內的查價成功。
- 目前尚未建立雲端資源、設定真實憑證或寄送測試信；已完成的本機實測見 [TEST-RESULTS.md](TEST-RESULTS.md)。
