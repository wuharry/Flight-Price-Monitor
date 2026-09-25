# 表單管理介面

在本機 PowerShell 執行：

```powershell
Set-Location E:\flight-monitor
pnpm admin
```

用瀏覽器開啟終端機顯示的完整網址（包含 `#` 後的臨時存取碼）。介面只監聽 127.0.0.1，不是公開網站。重新啟動後存取碼會更換；重新整理若顯示未授權，請重新使用終端機的完整網址。不要分享存取碼。

## 部署設定精靈

填入 Google Cloud 專案 ID、區域、Supabase API URL、伺服器端 key、Resend key、寄件人與收件人。儲存會更新本機 `.env`，不會自動改動雲端密鑰或部署。金鑰不回傳到瀏覽器，留空代表保留原值。

「產生 Cloud Shell 部署指令」使用已儲存設定。假設 Artifact Registry 的 `flight-monitor/monitor:v1` 映像、服務帳戶和 Supabase 資料表已建立。先透過介面中的連結到 Secret Manager 更新三筆密鑰，確認最新版本已啟用，再將產生的指令貼到 Cloud Shell。指令不含金鑰，固定以 preview 模式部署。不會自動建立排程或寄信。

## 監控設定頁

儲存位置選 Supabase 時，「讀取規則／測試資料庫連線」和「儲存監控規則」會直接存取所設定的雲端資料庫。可新增、編輯、停用規則。下一次 Job 執行使用新規則，不需要重新建置映像。收件人仍為全域設定，雲端收件信箱需更新 Secret Manager。

選本機 JSON 時只修改 WATCH_RULES_FILE 指定的檔案（預設 watch-rules.json）。不會影響 Cloud Run。日期、人數、機場代碼與價格由伺服器再次驗證。既有航線監控歷史依查詢條件隔離。

## 測試

```powershell
pnpm test
pnpm exec tsx scripts/test-admin-browser.ts
```

瀏覽器測試使用 Edge 與暫存資料夾，僅使用虛構金鑰、本機規則，不寄信、不改動真實 Supabase。截圖位於 artifacts/admin/desktop.png 與 mobile.png。

2026-09-25：30 項自動測試通過；瀏覽器實測完成設定儲存、金鑰清空且不回顯、產生部署指令、新增及編輯停用規則、390px 手機版面，無 JavaScript 錯誤。真實 Supabase 連線與雲端 Job 成功與否仍需實際環境驗證。
