# HANDOVER — trip sim-rank 指令

> 上次更新：2026-04-19
> 當前狀態：v1.4 穩定（SIM 卡 + 飯店比價功能上線）

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

## ✅ 本次完成（v1.4，2026-04-19）

### 飯店比價功能（一鍵開多平台）

- **新增 `HotelComparePanel.tsx`**（`/Users/liu/Documents/porject/肥宅老司機前進世界地圖/components/`）
  - 使用者輸入城市 + 飯店名稱 + 入退房日期 + 人數
  - 預設勾選：Booking.com、Agoda、Trip.com
  - 可加選：Expedia、Hotels.com、易遊網
  - 一鍵同時開所有勾選平台的新分頁，讓使用者自己比價
- **整合進 `AboutOverlay.tsx`** 的旅遊預訂 tab，新增「飯店比價」按鈕

### 為何不做自動爬取比較

- Agoda GraphQL 需要 session headers，headless 被 block
- Booking.com 同房型有合作商價 vs 標準價（抓哪個？）
- 「一鍵開多分頁」比爬蟲可靠、零維護、不違規

### RB Resort Pattaya 實測比價（6/22-24，2晚）

| 房型（35m² 陽台） | Trip.com | Agoda | Booking.com |
|-----------------|---------|-------|-------------|
| Deluxe Balcony | $114 | ~$100 | $167（合作商）/ $366（標準） |

| 房型（32m² 池畔） | Trip.com | Agoda | Booking.com |
|-----------------|---------|-------|-------------|
| Poolside Room | $142 | ~$134 | $472 |

**結論：Booking.com 標準價貴 3-4 倍，Trip.com ≈ Agoda**

---

## ✅ 本次完成（v1.5，2026-05-12）

### GB 解析補漏（修掉假資料問題）

發現 8 種 remark 格式無法解析出 GB，導致真實方案 CP=N/A 被埋到後面：

1. **新增 `parseDailyGbFromRemark` 補漏**：加入 `XGB data/day` / `XGB/day` 格式
   - 範例：`[Vinaphone] 7GB data/day` → 7GB/天
2. **新增 `parseTotalGbFromRemark`**：從 remark 的 `Total XGB + N days` 精確推算每日流量
   - 範例：`Package 5 days-Total - 30GB` → 30 ÷ 5 = 6GB/天
   - 範例：`Package Pick-up-7 days-Mobifone-Total-30GB` → 30 ÷ 7 = 4.286GB/天
   - 365 天長效卡、MB-GB range 格式 → 正確略過，不亂猜

同步修改 Worker (`api/lib/sim-rank.ts`) 與 CLI (`src/clis/trip/sim-rank.ts`)。

---

## 🔴 下次可做的事

1. ~~**Days=? 解析改善**~~ ✅ 已完成（v1.2）
2. ~~**CP=N/A 彈性方案問題**~~ ✅ 已完成（v1.3）
3. ~~**飯店跨平台比價**~~ ✅ 已完成（v1.4，一鍵開多平台）
4. ~~**驗證易遊網 URL 格式**~~ — 已確認易遊網需要數字 CityID，無法只靠城市名稱搜尋，已從比價功能移除
5. **選項 B（備用）**：為 Agoda / 易遊網 建立 city ID 對照表，讓搜尋直接跳出結果頁，不需使用者再按 Enter。已知：Agoda Pattaya=8584、易遊網 Pattaya=15267。詳見 memory `project_hotel_compare_future.md`

---

## 飯店比價研究筆記（2026-04-18）

### 結論

- **Trip.com 多幣別套利：無效**。Trip.com 匯率轉換很精準，USD/TWD/VND 換算後差距 < $1，沒有套利空間。
- **跨平台比價（Trip.com vs Agoda vs Booking）：有意義**，是下一步要做的方向。
- **不需要做 CLI**：飯店比價情境是網站功能，不是命令列工具。

### Trip.com 飯店資料抓取方式（已驗證）

**URL 格式**：
```
https://www.trip.com/hotels/list?city={cityId}&cityName={城市}&checkin=YYYY%2FMM%2FDD&checkout=YYYY%2FMM%2FDD&adult=2&children=0&curr=USD&locale=en-XX
```

**資料位置**：`window.IBU_HOTEL.initData.firstPageList.hotelList`

**每間飯店包含**：
- `hotelBasicInfo.hotelId` — 唯一 ID
- `hotelBasicInfo.hotelName` — 名稱
- `hotelBasicInfo.price` — 每晚價格（指定幣別）
- `hotelStarInfo.star` — 星級
- `commentInfo.commentScore` — 評分

**重要**：SEO 頁面（`/hotels/hanoi-hotels-list-286/`）用的是 Next.js，沒有 IBU_HOTEL，**必須用 `/hotels/list?city=...` 格式**。

### 城市 ID（已確認）
- 河內 (Hanoi): **286**
- 曼谷 (Bangkok): **359**
- 普吉 (Phuket): **725**
- 清邁 (Chiang Mai): **623**
- 蘇梅島 (Koh Samui): **1229**
- 甲米 (Krabi): **1405**
- 胡志明市: 396（待確認）
- 芭堤雅 (Pattaya): **622** ✅

### 芭堤雅 City ID 問題（2026-04-18 踩坑紀錄）

**已試但失敗的方法：**
- 暴力試 ID（359 附近、400-600、700-1000 等範圍）—— ID 無規律，跨國家跳
- 直接呼叫 Trip.com 內部 API（`/htls/hotel/list`、`/htls/search/suggest` 等）—— 全部返回 `method not support`，需要 SSR session
- JS 合成事件觸發 autocomplete —— React 組件不響應 synthetic events，只認真實鍵盤輸入

**正確的找法（下次進來第一件事）：**
1. 打開 Trip.com 飯店頁面
2. 搜尋框輸入「Pattaya」（手動或用 Playwright `browser_type` + 正確 ref）
3. 點選 autocomplete 下拉選項 → 頁面 URL 或 IBU_HOTEL 裡會有 city ID
4. 把 city ID 補進上方城市對照表

**正確方式**：用 Playwright 導到 trip.com，搜城市名後讀 URL `?city=XXX`，不要用 JS 合成事件。

## ✅ RB Resort Pattaya 比價驗證（2026-04-18，5/8-5/11，3晚）

| 平台 | 每晚 | 評分 |
|------|------|------|
| Trip.com | **$60** | 8.8 / 3星 |
| Booking.com | **$248** | 7.1 |

**價差 $188/晚（Trip.com 便宜 75%）** ← 比價功能值得做

### 網站功能設計建議（2026-04-18 更新）

**比對流程（正確設計）：**
- 使用者選城市（下拉選單，有預設城市 + city ID 對照表）
- 使用者輸入飯店名稱
- 系統同時查 Trip.com（city list）+ Booking.com（DOM）
- 飯店名稱模糊比對，找相同飯店，顯示價差

**不要** 讓使用者直接輸入任意城市名稱然後自動找 city ID——city ID 無法自動查詢。

### 技術路線

Playwright（瀏覽器）比 curl 可靠，因為有些頁面需要 JS 執行後才有 IBU_HOTEL 資料。

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
