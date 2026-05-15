/**
 * forex compare — 多家台灣銀行匯率橫向比較
 *
 * 資料來源：
 * - 台灣銀行（BOT）：rate.bot.com.tw 公開 CSV
 * - 玉山銀行（ESun）：JSON-LD 嵌入 HTML（15 幣，無 VND）
 * - 兆豐銀行（Mega）：公開 JSON API（20 幣，含 VND/THB/MYR/KRW/IDR/PHP）
 * - 土地銀行（Land）：靜態 HTML table（14 幣，無 VND，THB 只有即期）
 *
 * 設計原則：
 * - 新增銀行只要加一個 fetch 函式 + 在 BANK_FETCHERS 陣列加一行
 * - 某家銀行失敗不影響其他銀行（降級顯示「無資料」）
 */
import { EmptyResultError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';

// ─── 型別 ────────────────────────────────────────────────────────────────────

interface RateMap {
  /** 銀行名稱（顯示用） */
  bank: string;
  /** ISO → { cashBuy, cashSell } */
  rates: Map<string, { cashBuy: number; cashSell: number }>;
}

// ─── 常數 ────────────────────────────────────────────────────────────────────

// 大數字幣別（能換到的數量顯示整數）
const BIG_NUMBER = new Set(['VND', 'KRW', 'IDR']);

// 共用 fetch headers（模擬一般瀏覽器，避免被 block）
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// ─── 台灣銀行 ────────────────────────────────────────────────────────────────

async function fetchBOT(): Promise<RateMap> {
  // CSV col 位置：0=ISO, 2=現鈔買入, 12=現鈔賣出
  try {
    const res = await fetch('https://rate.bot.com.tw/xrt/flcsv/0/day', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' },
    });
    if (!res.ok) return { bank: '台灣銀行', rates: new Map() };

    const map = new Map<string, { cashBuy: number; cashSell: number }>();
    for (const raw of (await res.text()).split('\n')) {
      const cols = raw.replace(/^\uFEFF/, '').split(',').map((c) => c.trim());
      if (cols.length < 13) continue;
      const iso = cols[0].toUpperCase();
      if (!iso || iso === '幣別' || !cols[1].includes('買入')) continue;
      const cashBuy  = parseFloat(cols[2]);
      const cashSell = parseFloat(cols[12]);
      if (!isNaN(cashSell) && cashSell > 0) {
        map.set(iso, { cashBuy: isNaN(cashBuy) ? 0 : cashBuy, cashSell });
      }
    }
    return { bank: '台灣銀行', rates: map };
  } catch {
    return { bank: '台灣銀行', rates: new Map() };
  }
}

// ─── 玉山銀行 ─────────────────────────────────────────────────────────────────

async function fetchESun(): Promise<RateMap> {
  // 頁面內嵌 JSON-LD（application/ld+json）包含結構化匯率資料
  // 格式：{ "@type": "ExchangeRateSpecification", "name": "美元 現金匯率 銀行賣出", "currency": "USD",
  //         "currentExchangeRate": { "price": "32.21" } }
  // 注意：玉山銀行不提供 VND，只有 15 種主要幣別
  try {
    const res = await fetch(
      'https://www.esunbank.com/zh-tw/personal/deposit/rate/forex/foreign-exchange-rates',
      { headers: BROWSER_HEADERS },
    );
    if (!res.ok) return { bank: '玉山銀行', rates: new Map() };

    const html = await res.text();

    // 頁面有多個 JSON-LD 區塊，找出含有 ExchangeRateSpecification 的那個
    const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
    let ldMatch: RegExpExecArray | null;
    let json: Record<string, unknown> | null = null;
    while ((ldMatch = ldRe.exec(html)) !== null) {
      if (ldMatch[1].includes('ExchangeRateSpecification')) {
        json = JSON.parse(ldMatch[1]);
        break;
      }
    }
    if (!json) return { bank: '玉山銀行', rates: new Map() };
    const mainEntity = (json?.mainEntity ?? {}) as Record<string, unknown>;
    const items = (mainEntity.itemListElement ?? []) as Array<{
      '@type': string; name: string; currency: string; currentExchangeRate: { price: string };
    }>;

    const map = new Map<string, { cashBuy: number; cashSell: number }>();

    for (const item of items) {
      if (item['@type'] !== 'ExchangeRateSpecification') continue;
      const { name, currency } = item;
      const price = parseFloat(item.currentExchangeRate?.price);
      if (!currency || isNaN(price) || price <= 0) continue;

      const existing = map.get(currency) ?? { cashBuy: 0, cashSell: 0 };
      if (name.includes('現金匯率') && name.includes('銀行買入')) {
        map.set(currency, { ...existing, cashBuy: price });
      } else if (name.includes('現金匯率') && name.includes('銀行賣出')) {
        map.set(currency, { ...existing, cashSell: price });
      }
    }

    // 過濾掉 cashSell 為 0 的幣別（JSON-LD 可能只有部分資料）
    for (const [iso, r] of map) {
      if (r.cashSell === 0) map.delete(iso);
    }

    return { bank: '玉山銀行', rates: map };
  } catch {
    return { bank: '玉山銀行', rates: new Map() };
  }
}

// ─── 兆豐銀行 ─────────────────────────────────────────────────────────────────

async function fetchMega(): Promise<RateMap> {
  // 公開 JSON API，無需登入，支援 20 種幣別（含 VND、THB、MYR、KRW、IDR、PHP）
  // 格式：{ rates: [{ currKey: "USD|01", cash: { bid: "31.58", ask: "32.25" } }] }
  try {
    const res = await fetch(
      'https://www.megabank.com.tw/api/client/ExchangeRate/GetRateData?sc_lang=zh-TW&sc_site=bank-zh-tw&dic_lang=zh-TW',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
    );
    if (!res.ok) return { bank: '兆豐銀行', rates: new Map() };

    const json = await res.json() as {
      rates?: Array<{ currKey: string; cash: { bid: string; ask: string } }>;
    };
    const map = new Map<string, { cashBuy: number; cashSell: number }>();

    for (const entry of json.rates ?? []) {
      // currKey 格式："USD|01"，取 | 前的 ISO 碼
      const iso      = entry.currKey.split('|')[0].toUpperCase();
      const cashBuy  = parseFloat(entry.cash?.bid);
      const cashSell = parseFloat(entry.cash?.ask);
      if (!isNaN(cashSell) && cashSell > 0) {
        map.set(iso, { cashBuy: isNaN(cashBuy) ? 0 : cashBuy, cashSell });
      }
    }
    return { bank: '兆豐銀行', rates: map };
  } catch {
    return { bank: '兆豐銀行', rates: new Map() };
  }
}

// ─── 土地銀行 ─────────────────────────────────────────────────────────────────

async function fetchLandBank(): Promise<RateMap> {
  // 靜態 HTML 表格，欄位順序：幣別 | 即期買 | 即期賣 | 現鈔買 | 現鈔賣 | 查詢
  // 格式範例：['美元 (USD)', '31.912', '32.062', '31.574', '32.284', '查詢']
  // 注意：部分幣別現鈔欄位為 '--'（只有即期，無現鈔服務）
  try {
    const res = await fetch(
      'https://rate.landbank.com.tw/zh-TW/Foreign',
      { headers: BROWSER_HEADERS },
    );
    if (!res.ok) return { bank: '土地銀行', rates: new Map() };

    const html  = await res.text();
    const map   = new Map<string, { cashBuy: number; cashSell: number }>();

    // 逐行取出 <tr>，再取各 <td> 的純文字
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row: RegExpExecArray | null;
    while ((row = rowRe.exec(html)) !== null) {
      const cells: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let td: RegExpExecArray | null;
      while ((td = tdRe.exec(row[1])) !== null) {
        cells.push(td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      }
      if (cells.length < 5) continue;

      // 第一格格式："美元 (USD)"，取括號內 ISO 碼
      const isoMatch = cells[0].match(/\(([A-Z]{3})\)/);
      if (!isoMatch) continue;
      const iso = isoMatch[1];

      const cashBuy  = parseFloat(cells[3]);
      const cashSell = parseFloat(cells[4]);
      // '--' 代表沒有現鈔服務，跳過
      if (!isNaN(cashSell) && cashSell > 0) {
        map.set(iso, { cashBuy: isNaN(cashBuy) ? 0 : cashBuy, cashSell });
      }
    }
    return { bank: '土地銀行', rates: map };
  } catch {
    return { bank: '土地銀行', rates: new Map() };
  }
}

// ─── 銀行清單（往後新增銀行只需在這裡加一行） ──────────────────────────────────

const BANK_FETCHERS: Array<() => Promise<RateMap>> = [
  fetchBOT,
  fetchESun,
  fetchMega,
  fetchLandBank,
  // fetchCathay,     // 國泰世華（JS 渲染，需要瀏覽器）
  // fetchFirstBank,  // 第一銀行（待查 API）
];

// ─── 工具函式 ─────────────────────────────────────────────────────────────────

function fmtAmount(iso: string, amount: number): string {
  return BIG_NUMBER.has(iso) ? Math.round(amount).toLocaleString() : amount.toFixed(2);
}

// ─── CLI 指令定義 ─────────────────────────────────────────────────────────────

cli({
  site: 'forex',
  name: 'compare',
  description: '橫向比較多家台灣銀行的現鈔賣出匯率，找出最划算的換匯銀行',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: 'currency',
      positional: true,
      required: true,
      help: '幣別代碼（如 VND、THB、USD、JPY）',
    },
    {
      name: 'amount',
      type: 'int',
      default: 10000,
      help: '台幣金額，用於計算能換多少外幣（預設 10,000）',
    },
  ],
  columns: ['銀行', '匯率(TWD/1外幣)', '能換到', '差距', '備註'],
  func: async (_page, kwargs) => {
    const iso    = String(kwargs.currency).toUpperCase();
    const amount = Math.max(1, Number(kwargs.amount) || 10000);

    // 平行抓取所有銀行
    const allMaps = await Promise.all(BANK_FETCHERS.map((fn) => fn()));

    // 收集有此幣別的銀行
    const available: Array<{ bank: string; cashBuy: number; cashSell: number }> = [];
    const unavailable: string[] = [];

    for (const { bank, rates } of allMaps) {
      const r = rates.get(iso);
      if (r) {
        available.push({ bank, cashBuy: r.cashBuy, cashSell: r.cashSell });
      } else {
        unavailable.push(bank);
      }
    }

    if (!available.length) {
      throw new EmptyResultError(
        'forex compare',
        `沒有銀行提供 ${iso} 的匯率資料，請確認幣別代碼是否正確`,
      );
    }

    // 找最優：現鈔賣出最低（你花最少台幣換到同樣外幣）
    available.sort((a, b) => a.cashSell - b.cashSell);
    const bestSell = available[0].cashSell;

    const rows = available.map((r, idx) => {
      const canGet  = amount / r.cashSell;
      const diffPct = ((r.cashSell - bestSell) / bestSell) * 100;
      return {
        銀行:              r.bank,
        '匯率(TWD/1外幣)': r.cashSell,
        能換到:            `${fmtAmount(iso, canGet)} ${iso}`,
        差距:              idx === 0 ? '✅ 最優' : `+${diffPct.toFixed(1)}%（較貴）`,
        備註:              '',
      };
    });

    // 不提供此幣別的銀行也列出來
    for (const bank of unavailable) {
      rows.push({
        銀行:             bank,
        '匯率(TWD/1外幣)': '—' as unknown as number,
        能換到:           '—',
        差距:             '—',
        備註:             '不提供此幣別',
      });
    }

    return rows;
  },
});
