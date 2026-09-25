# 改用 Gmail SMTP

需要更新 Cloud Run Job 的映像與環境變數；網站與資料庫不需變更。預設仍為 Resend，只有 EMAIL_PROVIDER=gmail 才啟用 Gmail。Gmail 固定使用 smtp.gmail.com:465 TLS，寄件地址等於 GMAIL_USER。Gmail 模式不使用 NOTIFICATION_FROM_EMAIL。

## 1. 應用程式密碼

用寄件帳號（例如 whw880218cool@gmail.com）登入 Google，啟用兩步驟驗證，在 https://myaccount.google.com/apppasswords 建立應用程式密碼。不要使用 Google 登入密碼或網站會員密碼；不要把它貼到聊天、GitHub 或公開網站。

到 Google Cloud Secret Manager 的 gen-lang-client-0118434625 專案，建立 `flight-monitor-gmail-password`，密鑰值為應用程式密碼。若已存在，新增啟用中的版本。以下 Cloud Shell 命令不包含密碼。

```bash
gcloud secrets add-iam-policy-binding flight-monitor-gmail-password --project=gen-lang-client-0118434625 --member=serviceAccount:flight-monitor@gen-lang-client-0118434625.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
```

## 2. 從 GitHub 建置新版

第一次使用此資料夾：

```bash
git clone https://github.com/wuharry/Flight-Price-Monitor.git "$HOME/flight-monitor-github"
cd "$HOME/flight-monitor-github"
```

若資料夾已存在，只需進入後更新：

```bash
cd "$HOME/flight-monitor-github"
git pull --ff-only
```

建置：

```bash
gcloud builds submit --project=gen-lang-client-0118434625 --tag=asia-east1-docker.pkg.dev/gen-lang-client-0118434625/flight-monitor/monitor:gmail .
```

必須顯示 SUCCESS 才繼續。若應用程式密碼由其他 Gmail 帳號建立，以下 GMAIL_USER 必須換成那個帳號。

## 3. 寄一封測試信

獨立測試 Job 不存取監控規則、不寫入票價，也不需要 Supabase 密鑰。只掛載 Gmail 密碼，固定零重試。下方收件地址請換成要測試的信箱：

```bash
export TEST_RECIPIENT="你的收件信箱"
gcloud run jobs deploy flight-monitor-mail-test --project=gen-lang-client-0118434625 --region=asia-east1 --image=asia-east1-docker.pkg.dev/gen-lang-client-0118434625/flight-monitor/monitor:gmail --service-account=flight-monitor@gen-lang-client-0118434625.iam.gserviceaccount.com --command=node --args=dist/scripts/test-gmail.js --tasks=1 --parallelism=1 --cpu=1 --memory=512Mi --task-timeout=120s --max-retries=0 --set-env-vars="STORAGE=local,EMAIL_PROVIDER=gmail,EMAIL_MODE=send,GMAIL_USER=whw880218cool@gmail.com,NOTIFICATION_TO_EMAIL=$TEST_RECIPIENT,TEST_EMAIL_TO=$TEST_RECIPIENT" --set-secrets=GMAIL_APP_PASSWORD=flight-monitor-gmail-password:latest
gcloud run jobs execute flight-monitor-mail-test --project=gen-lang-client-0118434625 --region=asia-east1 --wait
gcloud run jobs logs read flight-monitor-mail-test --project=gen-lang-client-0118434625 --region=asia-east1 --limit=30
```

每次執行會真的寄一封「可以訂機票」測試信，不代表票價達標。Gmail 接受郵件不代表已送入收件匣，請收件人檢查垃圾郵件。

## 4. 更新正常查價 Job

```bash
gcloud run jobs update flight-monitor --project=gen-lang-client-0118434625 --region=asia-east1 --image=asia-east1-docker.pkg.dev/gen-lang-client-0118434625/flight-monitor/monitor:gmail --update-env-vars=EMAIL_PROVIDER=gmail,GMAIL_USER=whw880218cool@gmail.com,EMAIL_MODE=preview --update-secrets=GMAIL_APP_PASSWORD=flight-monitor-gmail-password:latest
```

保留原有 Supabase 及其他設定。先完成真實查價測試，確認網站使用者的規則與目標價格後才啟用通知：

```bash
gcloud run jobs update flight-monitor --project=gen-lang-client-0118434625 --region=asia-east1 --update-env-vars=EMAIL_MODE=send
```

有擁有者的規則會寄到 Supabase Auth 中該使用者當下已驗證的信箱。舊版無擁有者規則才使用全域 NOTIFICATION_TO_EMAIL。Supabase 註冊／重設密碼信不受這次改動影響。

## 寄送可靠性

保留既有 outbox、價格通知去重與 23 小時重試期限。SMTP 沒有 Resend 的 idempotency API；固定 Message-ID 不保證收件服務去重。若 Gmail 已接受郵件但資料庫寫入失敗，重試仍可能重複寄送。Gmail 也可能限制雲端來源登入或寄信流量，此方案適合少量通知。

驗證：35 項自動測試通過；真實 Gmail 驗證及送達需要應用程式密碼設定後另行測試。
