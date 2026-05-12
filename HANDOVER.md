# HANDOVER — opencli 專案整體交接

> 上次更新：2026-05-12
> 當前狀態：v1.6，Worker 已部署，彈性方案精確 CP 值已上線

---

## ✅ 本次完成（2026-05-12）

- **sim-rank v1.5**：修補 8 種漏解析 GB 格式（`Total-30GB`、`7GB data/day`、`Total 0.5GB` 等），漏掉的真實方案重新進入排名
- **sim-rank v1.6**：精確天數查詢時（如 `?days=7`），自動對彈性方案抓產品詳細頁，找出目標天數 CP 最高的套餐並用真實價格排名
  - 實測：Vietnam 5G eSIM 7天 CP 從錯誤 2.778 → 正確 **6.167**
  - `plan` 欄顯示 `Day Pass / Total ✓Daily 3GB` 標示選中套餐
- **Cloudflare Worker 已部署**：`https://opencli-api.liupony2000.workers.dev`

### 自行新增的模組

| 模組 | 位置 | 狀態 |
|------|------|------|
| `opencli forex rate` | `src/clis/forex/rate.ts` | ✅ 穩定 |
| `opencli forex compare` | `src/clis/forex/compare.ts` | ✅ 穩定 |
| `opencli forex best` | `src/clis/forex/best.ts` | ✅ 穩定 |
| `opencli trip sim-rank` | `src/clis/trip/sim-rank.ts` | ✅ 穩定 v1.5（CLI 版） |
| Cloudflare Worker API | `api/worker.ts` + `api/lib/sim-rank.ts` | ✅ v1.6 已部署 |

---

## ✅ 本次完成（2026-05-12）

- **sim-rank v1.5**：修補 8 種漏解析 GB 格式（`Total-30GB`、`7GB data/day` 等）
- **sim-rank v1.6 Worker**：精確天數查詢時自動抓 detail 頁，彈性方案用真實 7 天套餐 CP 排名
- **sim-rank v1.6 CLI**：同步 Worker 邏輯，兩者現已對齊
- **Cloudflare 已部署**：老司機地圖網站直接受益，實測 Vietnam 7 天結果正確
  - #1 Da Nang 機場實體卡 CP~10.06（7GB/天，$4.87 total）
  - #2 Vietnam 5G eSIM CP 6.167（Daily 3GB，$3.40 total）

---

## 🔴 下一個對話要先做（高優先）

### Step 1：老司機地圖 SIM 卡頁面優化（可選）

網站 SIM 卡功能已可正常使用（老司機地圖已整合並實測通過）。
若要優化，可考慮：加入「最優推薦」說明文字、顯示 `plan` 欄的套餐標示（`✓Daily 3GB`）、加入 `no_real_name` 過濾選項。

---

## 🟡 待開發功能（按優先度）

### 1. `opencli crypto` — 加密貨幣行情（最簡單，推薦先做）

- **來源**：CoinGecko 公開 API，完全免費、無需 API key
- **指令設計**：
  ```bash
  opencli crypto price BTC ETH SOL
  opencli crypto top --limit 20
  ```
- **位置**：新建 `src/clis/crypto/`
- **難度**：低（1-2 小時）

---

### 2. `opencli stock` — 台股行情

- **來源**：TWSE 公開 CSV API（不需認證）
- **指令設計**：
  ```bash
  opencli stock quote 2330 2317 0050
  ```
- **位置**：新建 `src/clis/stock/`
- **難度**：低（2-3 小時）

---

### 3. forex — 補完其他國家真實銀行匯率

- **現況**：只有 VND 有真實銀行匯率（Vietcombank + Agribank），其他都用 Wise × 0.99 估算（帶 ⚠️）
- **目標**：找到泰國、日本、韓國的靜態 API，讓 ⚠️ 消失
- **調查順序**：
  1. 泰國央行（BOT）
  2. 日本郵政銀行
  3. KEB Hana 韓國
- **調查方式**：先 curl 測試，把結果貼給 Claude 分析，確定有真實匯率再整合
- **難度**：中（每個國家約 1-2 小時）

---

### 4. trip sim-rank — Days=? 解析改善

- **現況**：許多方案天數顯示 `?`，因為產品名稱格式多樣
- **目標**：從 `basicInfo.extras` 撈更多欄位，提高解析率
- **難度**：中（需要 API 探索）
- **詳細說明**：見 `src/clis/trip/HANDOVER.md`

---

### 5. trip sim-rank → 網站整合（較大）

- **網站路徑**：`/Users/liu/Documents/porject/肥宅老司機前進世界地圖`
- **架構**：React + TypeScript，已有 `exchangeRateService.ts`
- **先做**：測試 CORS
  ```bash
  curl -X POST https://www.trip.com/restapi/soa2/20684/json/productSearch \
    -H "Content-Type: application/json" \
    -d '{"client":{"currency":"USD","locale":"en-XX","platformId":24,"channel":118},"filtered":{"items":[],"pageIndex":1,"pageSize":5,"sort":"1","tab":"simcard"},"destination":{"keyword":"Vietnam SIM card"},"requestSource":"activity","productOption":{"needBasicInfo":true,"needPrice":true},"head":{"Locale":"en-XX","Currency":"USD"}}' | head -5
  ```
  - 成功 → 方案 A（前端直接呼叫，不需後端）
  - 被 CORS 擋 → 方案 B（Cloudflare Worker 或 Vercel Function 做代理）
- **難度**：高（半天以上）

---

## ⚠️ 注意事項

1. **fork 關係**：origin = 自己的 GitHub fork，upstream = jackwener/opencli。pull 要從 upstream，push 到 origin
2. **SSH 問題**（2026-04-18 發現）：Windows 這邊的公鑰還沒加到 Mac 的 authorized_keys，需手動加：
   ```bash
   # 在 Mac Terminal 執行
   echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIfQfXI8NAIu/T6m/bodNqic783dfLg3PrimIamw0WyB pony@windows-to-mac" >> ~/.ssh/authorized_keys
   ```
3. **SMB 沒有 git 寫入權限**：從 Windows 通過 `\\192.168.1.107\liu\...` 掛載，`.git/` 無法寫入，所有 git 操作必須在 Mac 本機執行
4. **nvm 環境**：Mac 的 `~/.zshrc` 已設定 nvm，新終端機直接可用 `opencli`
5. **API 等待限制**：Vietcombank 限制每 5 分鐘一次請求

---

## 模組各自的詳細 HANDOVER

- `src/clis/forex/HANDOVER.md` — forex 模組完整說明
- `src/clis/trip/HANDOVER.md` — trip sim-rank 完整說明
