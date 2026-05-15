# HANDOVER — opencli 專案整體交接

> 上次更新：2026-05-15
> 當前狀態：v1.7.21，已合併 upstream，所有自訂 CLI 與最新版相容

---

## ✅ 本次完成（2026-05-15）

- **合併 upstream v1.7.21**（317 commits，從 v1.6 升到 v1.7.21）
- **打 tag `v1.6-liu-stable`**：合併前的安全點，隨時可 `git checkout v1.6-liu-stable` 回去
- **解決 3 個 merge 衝突**：
  - `src/build-manifest.ts`：保留 COMPILED_CLIS_DIR 掃描邏輯，整合進 upstream 新架構
  - `docs/adapters/index.md`：保留 forex 條目，同時加入 upstream 新增的 adapter 列表
  - `cli-manifest.json`：接受 upstream 版本，重跑 build 補回自訂 adapter
- **修正型別相容性**（upstream v1.7 新增必填欄位）：
  - 所有自訂 CLI 加 `access: 'read'`
  - `func` 簽名從 `(_page, kwargs)` 改為 `(kwargs)`（非瀏覽器指令正確簽名）
- **安裝 `@types/jsdom`**：upstream 新增測試依賴
- **Build 成功**：817 entries，trip/forex 全部正常載入
- **記憶系統**：存入「用 osascript 丟垃圾桶」的 feedback，下次 agent 直接可用
- **`.gitignore` 更新**：排除 `*.png`、`*.tgz`、`.playwright-mcp/`

### 自行新增的模組

| 模組 | 位置 | 狀態 |
|------|------|------|
| `opencli forex rate` | `src/clis/forex/rate.ts` | ✅ 穩定，已升級至 v1.7 型別 |
| `opencli forex compare` | `src/clis/forex/compare.ts` | ✅ 穩定，已升級至 v1.7 型別 |
| `opencli forex best` | `src/clis/forex/best.ts` | ✅ 穩定，已升級至 v1.7 型別 |
| `opencli trip sim-rank` | `src/clis/trip/sim-rank.ts` | ✅ 穩定，已升級至 v1.7 型別 |
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
- 來源：CoinGecko 公開 API（upstream 現在已有 coingecko adapter 可參考）
- `opencli crypto price BTC ETH SOL`

### 2. `opencli stock` — 台股行情
- 來源：TWSE 公開 CSV API
- `opencli stock quote 2330 0050`

### 3. forex — 補完其他國家真實銀行匯率
- 目前只有 VND 有真實銀行匯率，其他用 Wise × 0.99 估算（帶 ⚠️）
- 調查順序：泰國央行（BOT）→ 日本郵政銀行 → KEB Hana

---

## ⚠️ 注意事項

1. **fork 關係**：origin = 自己的 GitHub fork（`LIUXVuse/opencli`），upstream = `jackwener/opencli`。pull 要從 upstream，push 到 origin
2. **SSH 已設定**：origin remote 已改為 SSH（`git@github.com:LIUXVuse/opencli.git`），不需 GH_TOKEN
3. **安全點**：tag `v1.6-liu-stable` 是合併前的穩定版本
4. **nvm 環境**：Mac 的 `~/.zshrc` 已設定 nvm，新終端機直接可用 `opencli`
5. **升級 pattern**：未來再 merge upstream 時，自訂 CLI 要補的欄位通常在 `src/registry.ts` 的 `RequiredCliOptions` 型別
6. **API 等待限制**：Vietcombank 限制每 5 分鐘一次請求
7. **Trip.com CityPass 資料稀少**：部分城市可能查不到接送資料，前端已有 fallback

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
