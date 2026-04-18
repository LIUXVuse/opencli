# HANDOVER — trip sim-rank 指令

> 上次更新：2026-04-18
> 當前狀態：v1.3 穩定 — CP 值排名修正，彈性方案 GB 從 remark 解析，3GB 最低門檻過濾

---

## ✅ 本次完成（v1.3，2026-04-18）

### CP 值排名真實化

1. **`parseDailyGbFromRemark`** — 從 `minPriceRemarks[1]` 解析每日 GB（支援 `Daily 0.5GB`、`Daily - 0.5GB`、`500MB` 格式），解決「彈性方案 CP=N/A 被埋到後面」問題
2. **`min_daily_gb` 過濾** — Worker 預設 3GB/天門檻，過濾低流量垃圾方案
3. **自動降級策略** — 3GB 無結果 → 降 1GB → 再降全開，確保任何國家都有結果（中國只有 0.5GB 方案也能顯示）

### Worker 架構說明（重要）

網站用的是 `api/lib/sim-rank.ts`（Worker 版），不是本 CLI。改邏輯時**兩份都要改**，改完 `npx wrangler deploy`。

---

## ✅ 本次完成（v1.2，2026-04-18）

### Days=? 解析改善

1. **`parsePlanType` 加入 Calendar-Day Billing 識別** — 符合此關鍵字的方案現在被正確標記為 Day Pass，而非 Fixed
2. **新增 `parseDaysFromRemark`** — Fixed 方案名稱無天數時，從 `minPriceRemarks[1]` 備援解析天數（例如 Da Nang 機場 SIM 卡 `days=7`）
3. **`priceInfo.minPriceRemarks` 加入 interface** — TypeScript 型別補全

### 根本問題修正（重要）

4. **`build-manifest.ts` 額外掃描 `dist/src/clis/`** — `src/clis/` 的 TypeScript CLI 在 build 後編譯到 `dist/src/clis/`，但 manifest 只掃 `clis/`（root），導致 `opencli trip sim-rank` 不存在。現在 manifest 也掃 dist/src/clis/，並把 modulePath 存成相對於 `clis/` 的路徑。

---

## ✅ 本次完成（v1.1，2026-04-04）

### Bug 修正（三個）

1. **Day Pass 每日費用計算錯誤** — price 本身就是每日費用，不應再除以 userDays
2. **Fixed 方案天數計算邏輯反轉** — 應優先用產品自身天數（productMinDays），天數不明才用 userDays 估算
3. **100GB 等可疑宣稱未警示** — 超過 30GB/天 的方案在 Formula 欄顯示 `⚠️ 宣稱流量偏高，CP 僅供參考`

### 新功能

- **`--days` 支援範圍格式**：`--days 7-9` 表示查詢適合 7～9 天行程的方案
  - 天數已知且不在範圍內的方案會被過濾掉
  - 天數未知（`?`）的方案保留，讓使用者自行確認
  - CP 計算用範圍的最小天數（保守估算）

### CP 值可信度標示規則

| 顯示 | 意思 |
|------|------|
| `9.259`（無符號） | 天數、流量均已知，精確計算 |
| `~9.259` | 有估算成分（天數不明 or Day Pass 流量估算） |
| Formula 顯示 `⚠️` | 流量宣稱超過 30GB/天，不可信 |
| `N/A` | 無法計算（無流量資訊且非 Day Pass） |

---

## 指令總覽

```bash
# 基本（預設越南，全部類型，CP 排名）
opencli trip sim-rank

# 日本 7 天 eSIM
opencli trip sim-rank --country Japan --days 7 --sim_type esim

# 越南 7-9 天，不需實名制（最推薦的查詢方式）
opencli trip sim-rank --days 7-9 --sim_type esim --no_real_name

# 按價格排序
opencli trip sim-rank --country Thailand --days 7 --sort price

# 輸出 JSON
opencli trip sim-rank --days 7 -f json
```

---

## 檔案結構

```
opencli/src/clis/trip/
  sim-rank.ts   ← 主程式
  HANDOVER.md   ← 本文件
```

---

## CP 值計算邏輯

```
Day Pass 方案：
  pricePerDay = price（price 本身是每日費）
  CP = 0.5GB（估算） ÷ pricePerDay

Fixed 方案（天數已知）：
  pricePerDay = price ÷ productMinDays
  CP = dailyGB ÷ pricePerDay

Fixed 方案（天數不明）：
  pricePerDay = price ÷ userDays（估算）
  CP = dailyGB ÷ pricePerDay，標記 ~
```

---

## 資料來源

- **trip.com** `POST /restapi/soa2/20684/json/productSearch`
- 幣別：USD，語言：en-XX
- 天數過濾：`filtered.items type=47`（API hint，不強制）

---

## 🔴 下次可做的事

1. ~~**Days=? 解析改善**~~ ✅ 已完成（v1.2）
2. ~~**CP=N/A 彈性方案問題**~~ ✅ 已完成（v1.3）
2. **與網站整合**：見下方整合評估

---

## 整合評估（網站：肥宅老司機前進世界地圖）

**可行性：高。** 網站是 React + TypeScript，已有 `exchangeRateService.ts`，架構相符。

### 方案 A：前端直接呼叫 API（最簡單）

網站直接呼叫 trip.com API，把 `sim-rank.ts` 的邏輯搬進 React component。
- 優點：不需要後端
- 缺點：trip.com 可能限制 CORS，需要測試

### 方案 B：加一個輕量後端 API

用 Node.js（Express 或 Vercel Function）包裝 opencli 邏輯，網站呼叫自己的 API endpoint。
- 優點：穩定，可加快取，不受 CORS 限制
- 缺點：需要部署後端

### 建議起始點

先測試 CORS：
```bash
curl -X POST https://www.trip.com/restapi/soa2/20684/json/productSearch \
  -H "Content-Type: application/json" \
  -d '{"client":{"currency":"USD","locale":"en-XX","platformId":24,"channel":118},"filtered":{"items":[],"pageIndex":1,"pageSize":5,"sort":"1","tab":"simcard"},"destination":{"keyword":"Vietnam SIM card"},"requestSource":"activity","productOption":{"needBasicInfo":true,"needPrice":true},"head":{"Locale":"en-XX","Currency":"USD"}}' | head -100
```
如果成功回傳資料，方案 A 可行。

---

## ⚠️ 已知問題

1. `--days` 傳給 API 的 type=47 是 hint，API 仍可能回傳不符天數的方案
2. Day Pass 的 0.5GB 估算是保守值，實際使用量視廠商而定
3. 100GB 宣稱雖加了警告，CP score 仍計算並用於排序（讓使用者自己決定）
4. 網站後台路徑：`/Users/liu/Documents/porject/肥宅老司機前進世界地圖`
