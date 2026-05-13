# HANDOVER — opencli 專案整體交接

> 上次更新：2026-05-13
> 當前狀態：v1.7，Worker 新增機場接送 API，老司機地圖出發攻略功能上線

---

## ✅ 本次完成（2026-05-13）

- **Worker `/api/airport-transfer`**：新增機場接送端點，從 Trip.com CityPass tab 抓取，已部署並驗證（Hanoi 回傳 $16.99 接送選項）
- **`api/lib/airport-transfer.ts`**：新建接送查詢核心邏輯，過濾含 transfer/shuttle/taxi/pickup 關鍵字的產品，回傳前 5 筆
- 老司機地圖「出發攻略」整合此端點（機場接送卡片）

### 自行新增的模組

| 模組 | 位置 | 狀態 |
|------|------|------|
| `opencli forex rate` | `src/clis/forex/rate.ts` | ✅ 穩定 |
| `opencli forex compare` | `src/clis/forex/compare.ts` | ✅ 穩定 |
| `opencli forex best` | `src/clis/forex/best.ts` | ✅ 穩定 |
| `opencli trip sim-rank` | `src/clis/trip/sim-rank.ts` | ✅ 穩定 v1.5（CLI 版） |
| Cloudflare Worker API | `api/worker.ts` + `api/lib/sim-rank.ts` | ✅ v1.6 已部署 |
| Worker `/api/airport-transfer` | `api/lib/airport-transfer.ts` | ✅ v1.7 已部署 |

---

## 🔴 下一個對話要先做（高優先）

### Step 1：`opencli trip plan` CLI

把現有三個模組串成出發規劃一條龍：

```bash
opencli trip plan Vietnam --days 7 --budget 30000 --from TPE
```

輸出：匯率策略 + 最佳 SIM + 機場接送選項（CLI 版）
位置：`src/clis/trip/plan.ts`

---

## 🟡 待開發功能（按優先度）

### 1. `opencli crypto` — 加密貨幣行情（最簡單）
- 來源：CoinGecko 公開 API
- `opencli crypto price BTC ETH SOL`

### 2. `opencli stock` — 台股行情
- 來源：TWSE 公開 CSV API
- `opencli stock quote 2330 0050`

### 3. forex — 補完其他國家真實銀行匯率
- 目前只有 VND 有真實銀行匯率，其他用 Wise × 0.99 估算（帶 ⚠️）
- 調查順序：泰國央行（BOT）→ 日本郵政銀行 → KEB Hana

---

## ⚠️ 注意事項

1. **fork 關係**：origin = 自己的 GitHub fork，upstream = jackwener/opencli。pull 要從 upstream，push 到 origin
2. **SSH 已設定**：origin remote 已改為 SSH（`git@github.com:LIUXVuse/opencli.git`），不需 GH_TOKEN
3. **nvm 環境**：Mac 的 `~/.zshrc` 已設定 nvm，新終端機直接可用 `opencli`
4. **API 等待限制**：Vietcombank 限制每 5 分鐘一次請求
5. **Trip.com CityPass 資料稀少**：部分城市（如雅加達）可能查不到接送資料，前端已有 fallback 顯示

---

## Cloudflare Worker 端點總覽

| 端點 | 說明 |
|------|------|
| `GET /api/forex` | 今日匯率（KV 每日快取） |
| `GET /api/sim-rank` | SIM 卡 CP 值排名 |
| `GET /api/airport-transfer?city=Hanoi` | 機場接送選項（Trip.com） |

## 模組各自的詳細 HANDOVER

- `src/clis/forex/HANDOVER.md` — forex 模組完整說明
- `src/clis/trip/HANDOVER.md` — trip sim-rank 完整說明
