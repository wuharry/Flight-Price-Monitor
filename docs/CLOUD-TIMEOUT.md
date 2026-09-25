# Cloud Run 執行逾時排查（2026-09-25）

使用者提供的 flight-monitor-8zx6v 日誌顯示容器已啟動，但於 900 秒上限被終止。Completed=False、failedCount=1；訊息中的 exit code 0 不代表成功。提供的日誌只有系統與稽核紀錄，沒有應用程式輸出，因此尚不能確認卡在 Xvfb、Node 啟動、資料庫或查價。

本次修改：

- Docker 使用 tini 管理 PID 1、轉送信號及回收子程序，避免直接以 xvfb-run 作為容器主程序。
- 啟動腳本立即輸出日誌，Xvfb stderr 接到容器 stderr，整體 840 秒到期時輸出 timeout 診斷並結束，10 秒後仍未退出則強制終止。
- Node 啟動、資料庫鎖、規則載入、瀏覽器啟動及導航各有進度日誌，不輸出金鑰。
- 建置最後階段以 pwuser 實際啟動 Xvfb 與 headed Chromium、渲染本機頁面；45 秒上限。失敗則不產生成功建置。

驗證：本機 pnpm test 的 30 項測試全部通過。此 Windows 環境沒有 Docker，未在本機重現 Linux 容器問題。Linux 瀏覽器啟動測試會在下一次 Cloud Build 執行；雲端查價仍需更新映像後手動驗證。本次是啟動層修正與診斷增強，尚未證實逾時根因已解除。

參考：https://playwright.dev/docs/docker （建議 init 程序）、https://github.com/krallin/tini。
