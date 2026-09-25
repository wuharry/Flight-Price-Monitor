# 測試結果與修正紀錄

測試日期：2026-09-25（Asia/Taipei）  
環境：Windows、Node.js 22.17.0、pnpm 10.23.0、Playwright 1.63.0、已安裝的 Microsoft Edge。

## 最終結果

| 測試 | 結果 |
|---|---|
| TypeScript 編譯 | 通過 |
| pnpm test | **29 項通過、0 失敗** |
| PostgreSQL/PGlite schema 重跑、seed 去重 | 通過 |
| 資料庫交易回滾、通知去重、鎖與到期、service_role／anon 權限 | 通過 |
| CLI 查價失敗退出碼 | 正確為 1 |
| 真實瀏覽器：1 位成人來回、展開票種 | 通過 |
| 真實瀏覽器：2 位成人來回 | 通過 |
| 真實瀏覽器：1 位成人單程 | 通過 |
| 完整 CLI：瀏覽器查價 → 本地儲存 → Email 預覽 | 通過，exit 0 |
| 無頭 Edge 真實查詢 | **未通過：虎航 HTTP 403 Access Denied** |
| 無頭遭拒後錯誤處理重測 | 正確立即回報 HTTP 403、不記錄價格 |
| 真實 Supabase／Resend／Cloud Run／Docker 映像 | 尚未執行；未提供雲端憑證，本機未安裝 Docker |

離線測試中的「injected mail failure」「injected unavailable」是刻意注入的故障，測試確認它們不會污染價格或偽裝成成功。

## 真實查價

TPE → NRT，去程 2027-02-10、回程 2027-02-16，TWD、直飛 tigerLight。
以下為本次觀測，不能視為未來保證票價。

| 查詢 | 去程未稅 | 回程未稅 | 稅費 | 含稅合計 | 航班 |
|---|---:|---:|---:|---:|---|
| 1 位成人來回 | 7,399 | 6,399 | 2,759 | **16,557** | IT202 / IT201 |
| 2 位成人來回 | 14,798 | 12,798 | 5,518 | **33,114** | IT202 / IT201 |
| 1 位成人單程 | 7,399 | — | 1,200 | **8,599** | IT202 |

金額是全部旅客合計；未含付款手續費、加購行李、餐點及選位。官方 GraphQL 的 ADT ticketPrice 提供稅額與折扣後含稅合計，parser 驗證兩者一致。

已實際操作：開啟官方帶入條件的訂票頁、等待正常等待室流程、接受 Cookie、查看航班、點擊 IT202 的價格按鈕、展開 tigerLight／tigerSmart／tigerPro 票種。未進入付款或完成訂位。

[1 位成人航班畫面](test-assets/round-trip.png) · [實際展開票種](test-assets/fare-options.png) · [2 位成人結果 JSON](test-assets/two-adults.json) · [單程結果 JSON](test-assets/one-way.json) · [無頭模式被拒畫面](test-assets/headless-denied.png)

## 最後一次完整流程輸出

為驗證郵件預覽，這次使用隔離測試規則 targetPrice=20000；正式範例仍為 6500。EMAIL_MODE=preview，未寄出信件。

~~~text
[Email preview — not sent]
✈ tigerair TPE → NRT NT$16,557
含稅票價 NT$16,557 已達目標 NT$20,000

去程未稅：NT$7399
回程未稅：NT$6399
稅費：NT$2759
含稅總價：NT$16557
查詢時間：2026-09-25T06:07:48.768Z

[Price] live-browser-check: TWD 16557; tax/fees 2759; IT202 / IT201
[Monitor] {"checked":1,"skipped":0,"failed":0}
~~~

已核對 artifacts/live-monitor/data/monitor.json 保存 1 筆真實價格、0 筆已寄通知，執行鎖已釋放。

## 發現並修正的問題

| 原問題 | 修正 |
|---|---|
| provider 固定回傳 3599／3899／1200 模擬價格 | 替換成真實官方頁面的 GraphQL 解析；不存在成功假資料 |
| API／瀏覽器未真正實作 | 找到 appFlightSearchResult，透過正常瀏覽器流程取得；不儲存或重播 token |
| 查價不核對人數、日期、稅額、可售座位 | 加入驗證；只比較直飛 tigerLight，選最低可售且時序合理的組合 |
| 記憶體資料每次排程重啟消失 | 本地原子 JSON 寫入；雲端使用 Supabase |
| 寄信失敗可能丟失新低通知 | 票價與通知 outbox 同交易保存，下次重試 |
| 預覽被當成寄送成功；Resend 回傳錯誤可能被忽略 | preview 不標記已寄；非成功回應會拋錯 |
| 只檢查最後一封信，可能重複通知 | 同條件同價格 24 小時去重，加上持久化 idempotency key |
| 新低是全歷史，跌幅是上一筆 | 新低使用可設定天數；跌幅比較約 24 小時前 |
| setInterval 可能重疊、任何查價失敗仍 exit 0 | 序列排程、執行鎖、15 分鐘上限、正確非零退出碼 |
| 舊探測日期已過期、瀏覽器核心不存在 | 可傳日期與 channel，使用本機 Edge 完成實測 |
| 瀏覽器測試點擊卡片文字未展開票種 | 改點卡片內真正的價格按鈕，重測通過 |
| UI 操作逾時被誤標為查價逾時 | 區分票價已取得後的測試錯誤 |
| 無頭被拒仍等 90 秒 | 導航後檢查 HTTP／Access Denied；重測立即回報 HTTP 403 |

無頭模式的拒絕屬航空公司端行為，沒有假裝已修好，也沒有繞過驗證。部署預設改用一般瀏覽器；Linux 使用 Xvfb。雲端 IP 能否正常查價仍需實際部署後確認，見 [部署文件](DEPLOYMENT.md)。

## 重現方式

~~~powershell
pnpm test
pnpm test:browser --headed --interact
pnpm test:browser --headed --adults 2
pnpm test:browser --headed --one-way
~~~

需先安裝 Node.js／pnpm 與 Edge。若用 Playwright Chromium，先 pnpm exec playwright install chromium，再增加 --channel chromium。這些瀏覽器指令會重新查詢真實航空公司，價格與阻擋結果可能改變。
