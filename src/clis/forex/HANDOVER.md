# HANDOVER — forex 匯率指令

> 上次更新：2026-04-03
> 當前狀態：v0.7 穩定 — 完整多國換錢策略，含排行一覽

---

## ✅ 本次完成

### `forex best` — 多國換錢策略排行（新指令）

```bash
opencli forex best --amount 30000
```

輸出範例（3 萬台幣）：
```
幣別   方案A 直換       方案B 帶USD換(實際)  差距    推薦換匯地點
🇮🇩 IDR 13,761,468 IDR  15,657,276 IDR ⚠️  +13.8%  ✅ Authorized Money Changer（玉山銀行換USD）
🇻🇳 VND 21,739,130 VND  24,320,397 VND     +11.9%  ✅ Vietcombank / 金舖（玉山銀行換USD）
🇰🇷 KRW  1,283,148 KRW   1,389,704 KRW ⚠️   +8.3%  ✅ 明洞換匯所（玉山銀行換USD）
🇲🇾 MYR      3,557 MYR       3,716 MYR ⚠️   +4.5%  ✅ KLCC 商圈換匯所
🇹🇭 THB     28,780 THB      30,064 THB ⚠️   +4.5%  ✅ SuperRich Thailand
🇯🇵 JPY    146,987 JPY     147,057 JPY ⚠️   +0.0%  ✅ 在台灣直換即可
🇸🇬 SGD      1,190 SGD       1,185 SGD ⚠️   -0.4%  💡 台灣直換更划算
🇭🇰 HKD      7,266 HKD       7,226 HKD ⚠️   -0.5%  💡 台灣直換更划算
```

- ⚠️ = Wise 中間匯率估算（×0.99 模擬換匯所現鈔手續費）
- 無 ⚠️ = 真實銀行買入價（VND 用 Vietcombank + Agribank）
- 依差距排序，最划算的排最前面

### Plan B 手續費修正

Plan B 現在正確計算兩層手續費：
1. 台幣→美金現鈔（用台灣銀行現鈔賣出價，已含利差）
2. 美金→目標幣現鈔（Wise × 0.99，模擬換匯所手續費）

---

## 指令總覽

```bash
# 查詢單一幣別匯率 + 換錢策略
opencli forex rate VND --amount 30000
opencli forex rate THB --amount 30000
opencli forex rate JPY

# 多國一覽排行（出發前用這個）
opencli forex best --amount 30000

# 台灣各銀行橫向比較
opencli forex compare VND
opencli forex compare THB
```

---

## 檔案結構

```
opencli/src/clis/forex/
  rate.ts      ← 單一幣別查詢 + 各國換錢策略（含三層輸出）
  compare.ts   ← 4 家台灣銀行橫向比較（任意幣別）
  best.ts      ← 多國換錢策略排行一覽（新）
  HANDOVER.md  ← 本文件
```

---

## 資料來源總覽

### 台灣銀行（4 家）

| 銀行 | 用途 | 方式 |
|------|------|------|
| 台灣銀行 | 所有幣別現鈔賣出 | CSV API |
| 玉山銀行 | USD 現鈔賣出比較 | JSON-LD |
| 兆豐銀行 | USD 現鈔賣出比較 | JSON API |
| 土地銀行 | USD 現鈔賣出比較 | 靜態 HTML |

### 越南銀行（2 家，真實買入價）

| 銀行 | 方式 |
|------|------|
| Vietcombank | XML API |
| Agribank | 靜態 HTML |

### 其他國家（Wise 中間匯率）

| 幣別 | 來源 | 備註 |
|------|------|------|
| THB/JPY/KRW/IDR/SGD/MYR/HKD | Wise 公開 API | 乘以 0.99 模擬現鈔手續費 |

---

## 🔴 下個 session 可做的事

### 選項 1：找更多國家的真實銀行匯率（讓 ⚠️ 消失）

目前只有 VND 有真實銀行買入價。其他國家若能找到靜態 API：
- 泰國：嘗試泰國央行（BOT）API
- 日本：嘗試日本郵政銀行或其他靜態 HTML 來源
- 韓國：嘗試 KEB Hana 其他路徑

**調查方式**（先自己 curl，把結果貼給 Claude）：
```bash
curl -sL "https://www.bot.or.th/english/statistics/financialmarkets/exchangerate/_layouts/Application/ExchangeRate/ExchangeRate.aspx" | grep -iE "USD|rate|json" | head -20
```

### 選項 2：`opencli crypto` — 加密貨幣行情

來源：CoinGecko 公開 API，完全免費無需認證。
難度低，適合下一個開發項目。

```bash
opencli crypto price BTC ETH SOL
opencli crypto top --limit 20
```

### 選項 3：`opencli stock` — 台股行情

來源：TWSE 公開 CSV API。
```bash
opencli stock quote 2330 2317 0050
```

---

## ⚠️ 已知問題 / 注意事項

1. 玉山銀行不提供 VND、THB 現鈔（真實情況）
2. 台銀 CSV col[12] = 現鈔賣出，格式改版要更新
3. 兆豐 JSON `currKey` 格式是 `"USD|01"`，取 `|` 前的 ISO 碼
4. Agribank 部分幣別（KRW、NZD）無現金買入，fallback 到電匯買入
5. Vietcombank 限制每 5 分鐘一次請求
6. CASH_SPREAD = 0.99（1%）是保守估算，SuperRich 實際約 0.3-0.5%
7. 日本用 ATM 提領可能比換現金更划算，但這需要特定銀行卡

## 環境設定

- `~/.zshrc` 已設定 nvm，新終端機直接可用 `opencli`
- 若仍找不到指令：`source ~/.zshrc`
