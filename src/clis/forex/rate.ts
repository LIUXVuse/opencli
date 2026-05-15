/**
 * forex rate — 台灣 + 越南即時匯率比較，附最佳換錢策略
 *
 * 資料來源（台灣）：台灣銀行公開 CSV（rate.bot.com.tw）
 * 資料來源（越南）：Vietcombank 公開 XML（portal.vietcombank.com.vn）
 *                   注意：Vietcombank 限制每 5 分鐘一次請求
 */
import { CliError, EmptyResultError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';

// ─── 常數 ────────────────────────────────────────────────────────────────────

const CURRENCY_DISPLAY: Record<string, { name: string; flag: string }> = {
  VND: { name: '越南盾', flag: '🇻🇳' },
  THB: { name: '泰銖',   flag: '🇹🇭' },
  USD: { name: '美金',   flag: '🇺🇸' },
  JPY: { name: '日圓',   flag: '🇯🇵' },
  EUR: { name: '歐元',   flag: '🇪🇺' },
  KRW: { name: '韓元',   flag: '🇰🇷' },
  HKD: { name: '港幣',   flag: '🇭🇰' },
  AUD: { name: '澳幣',   flag: '🇦🇺' },
  GBP: { name: '英鎊',   flag: '🇬🇧' },
  SGD: { name: '新幣',   flag: '🇸🇬' },
  MYR: { name: '馬幣',   flag: '🇲🇾' },
};

// 旅遊常用幣別預設顯示順序
const TRAVEL_CURRENCIES = ['VND', 'THB', 'USD', 'JPY', 'KRW', 'EUR', 'HKD'];

// 大數字幣別（顯示整數，不顯示小數）
const BIG_NUMBER_CURRENCIES = new Set(['VND', 'KRW', 'IDR']);

// 共用瀏覽器 headers（避免被 bot 保護擋）
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// ─── 型別 ────────────────────────────────────────────────────────────────────

interface BOTRateEntry {
  iso: string;
  cashBuy: number;   // 現鈔買入（銀行向你買，你回國時賣剩餘外幣給銀行）
  cashSell: number;  // 現鈔賣出（銀行賣給你，出國前買外幣用這個）
}

interface VCBRateEntry {
  iso: string;
  buy: number;       // 銀行買入外幣（你帶現金去越南換，銀行給你這個價）
  sell: number;      // 銀行賣出外幣（你在越南買外幣用這個，通常用不到）
}

interface TWBankRate {
  bank: string;
  usdSell: number;  // 現鈔賣出（越低越好，花越少台幣買到 1 USD）
}

// ─── 台灣銀行 ────────────────────────────────────────────────────────────────

async function fetchBOTRates(): Promise<BOTRateEntry[]> {
  // CSV 格式：ISO,本行買入,[現金買入],[即期買入],...,本行賣出,[現金賣出],[即期賣出],...
  //           col:   0         2                            12
  let res: Response;
  try {
    res = await fetch('https://rate.bot.com.tw/xrt/flcsv/0/day', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' },
    });
  } catch {
    throw new CliError('FETCH_ERROR', '無法連線至台灣銀行', '請確認網路連線');
  }
  if (!res.ok) throw new CliError('FETCH_ERROR', `台灣銀行回應 ${res.status}`, '請稍後再試');

  const entries: BOTRateEntry[] = [];
  for (const raw of (await res.text()).split('\n')) {
    const cols = raw.replace(/^\uFEFF/, '').split(',').map((c) => c.trim());
    if (cols.length < 13) continue;
    const iso = cols[0].toUpperCase();
    if (!iso || iso === '幣別' || !cols[1].includes('買入')) continue;

    const cashBuy  = parseFloat(cols[2]);
    const cashSell = parseFloat(cols[12]);
    if (!isNaN(cashSell) && cashSell > 0) {
      entries.push({ iso, cashBuy: isNaN(cashBuy) ? 0 : cashBuy, cashSell });
    }
  }
  return entries;
}

// ─── 台灣各銀行 USD 現鈔賣出（策略用）────────────────────────────────────────

async function fetchAllTaiwanBanksUSD(): Promise<TWBankRate[]> {
  // 平行抓取 3 家銀行的 USD 現鈔賣出，失敗不中斷整體
  const results = await Promise.allSettled([

    // 玉山銀行 — JSON-LD
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch(
          'https://www.esunbank.com/zh-tw/personal/deposit/rate/forex/foreign-exchange-rates',
          { headers: BROWSER_HEADERS },
        );
        if (!res.ok) return { bank: '玉山銀行', usdSell: 0 };
        const html  = await res.text();
        const ldRe  = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
        let ldMatch: RegExpExecArray | null;
        let usdSell = 0;
        while ((ldMatch = ldRe.exec(html)) !== null) {
          if (!ldMatch[1].includes('ExchangeRateSpecification')) continue;
          const json = JSON.parse(ldMatch[1]);
          const items = ((json?.mainEntity ?? {}) as Record<string, unknown>).itemListElement as Array<{
            '@type': string; name: string; currency: string; currentExchangeRate: { price: string };
          }> ?? [];
          for (const item of items) {
            if (item.currency === 'USD' && item.name?.includes('現金匯率') && item.name?.includes('銀行賣出')) {
              usdSell = parseFloat(item.currentExchangeRate?.price);
            }
          }
          break;
        }
        return { bank: '玉山銀行', usdSell };
      } catch { return { bank: '玉山銀行', usdSell: 0 }; }
    })(),

    // 兆豐銀行 — JSON API
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch(
          'https://www.megabank.com.tw/api/client/ExchangeRate/GetRateData?sc_lang=zh-TW&sc_site=bank-zh-tw&dic_lang=zh-TW',
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
        );
        if (!res.ok) return { bank: '兆豐銀行', usdSell: 0 };
        const json = await res.json() as {
          rates?: Array<{ currKey: string; cash: { bid: string; ask: string } }>;
        };
        const entry = (json.rates ?? []).find((r) => r.currKey.split('|')[0] === 'USD');
        const usdSell = entry ? parseFloat(entry.cash?.ask) : 0;
        return { bank: '兆豐銀行', usdSell: isNaN(usdSell) ? 0 : usdSell };
      } catch { return { bank: '兆豐銀行', usdSell: 0 }; }
    })(),

    // 土地銀行 — 靜態 HTML
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch('https://rate.landbank.com.tw/zh-TW/Foreign', { headers: BROWSER_HEADERS });
        if (!res.ok) return { bank: '土地銀行', usdSell: 0 };
        const html   = await res.text();
        let usdSell  = 0;
        const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let row: RegExpExecArray | null;
        while ((row = rowRe.exec(html)) !== null) {
          const cells: string[] = [];
          const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          let td: RegExpExecArray | null;
          while ((td = tdRe.exec(row[1])) !== null) {
            cells.push(td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
          }
          if (cells.length < 5) continue;
          const isoMatch = cells[0].match(/\(([A-Z]{3})\)/);
          if (isoMatch?.[1] === 'USD') {
            usdSell = parseFloat(cells[4]);
            break;
          }
        }
        return { bank: '土地銀行', usdSell: isNaN(usdSell) ? 0 : usdSell };
      } catch { return { bank: '土地銀行', usdSell: 0 }; }
    })(),

  ]);

  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is TWBankRate => r !== null && r.usdSell > 0);
}

// ─── Wise 中間匯率（各國本地換匯參考）────────────────────────────────────────

async function fetchWiseRate(target: string): Promise<number> {
  // Wise 公開 API，無需認證，回傳 USD 兌目標幣別的中間匯率（市場真實價）
  // 注意：這是 mid-market rate，當地銀行/換匯所實際約 ±0.5-1%
  try {
    const res = await fetch(
      `https://wise.com/rates/live?source=USD&target=${target}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
    );
    if (!res.ok) return 0;
    const json = await res.json() as { value?: number };
    return json.value ?? 0;
  } catch {
    return 0;
  }
}

// ─── 越南銀行（Vietcombank）───────────────────────────────────────────────────

async function fetchVietcombankRates(): Promise<VCBRateEntry[]> {
  // XML 格式：<Exrate CurrencyCode="USD" Buy="26,112.00" Transfer="..." Sell="26,362.00" />
  // Buy  = 銀行向你買（你帶外幣現金去換越南盾，用這個價）
  // Sell = 銀行賣給你（你在越南買外幣，用這個價）
  // 單位：VND per 1 unit of foreign currency
  let res: Response;
  try {
    res = await fetch(
      'https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx?b=10',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
    );
  } catch {
    return []; // Vietcombank 失敗不中斷，策略計算降級
  }
  if (!res.ok) return [];

  const xml = await res.text();
  const entries: VCBRateEntry[] = [];

  // 用 regex 解析 XML attribute（Node.js 無內建 DOMParser）
  const pattern = /CurrencyCode="([A-Z]{3})"[^>]+Buy="([\d,.-]+)"[^>]+(?:Transfer="[^"]*")[^>]+Sell="([\d,.-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(xml)) !== null) {
    const iso  = m[1];
    const buy  = parseFloat(m[2].replace(/,/g, ''));
    const sell = parseFloat(m[3].replace(/,/g, ''));
    if (!isNaN(buy) && buy > 0) {
      entries.push({ iso, buy, sell });
    }
  }
  return entries;
}

// ─── 越南銀行（Agribank）────────────────────────────────────────────────────

async function fetchAgribankRates(): Promise<VCBRateEntry[]> {
  // 靜態 HTML 表格，欄位：Ngoại tệ | Mua tiền mặt | Mua chuyển khoản | Giá bán
  // 即：幣別 | 現金買入 | 電匯買入 | 賣出
  // 單位：VND per 1 unit of foreign currency
  try {
    const res = await fetch('https://www.agribank.com.vn/vn/ty-gia', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' },
    });
    if (!res.ok) return [];

    const html    = await res.text();
    const entries: VCBRateEntry[] = [];
    const rowRe   = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row: RegExpExecArray | null;

    while ((row = rowRe.exec(html)) !== null) {
      const cells: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let td: RegExpExecArray | null;
      while ((td = tdRe.exec(row[1])) !== null) {
        cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
      }
      if (cells.length < 4) continue;
      const iso = cells[0].toUpperCase();
      if (!/^[A-Z]{3}$/.test(iso)) continue;

      // 現金買入（Mua tiền mặt）= 旅客帶現金去換 VND 用這個
      const buy  = parseFloat(cells[1].replace(/,/g, ''));
      const sell = parseFloat(cells[3].replace(/,/g, ''));
      // 有些幣別只有電匯，無現金買入（如 KRW），fallback 用電匯
      const buyFallback = parseFloat(cells[2].replace(/,/g, ''));
      const effectiveBuy = (!isNaN(buy) && buy > 0) ? buy : buyFallback;

      if (!isNaN(effectiveBuy) && effectiveBuy > 0) {
        entries.push({ iso, buy: effectiveBuy, sell: isNaN(sell) ? 0 : sell });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─── 工具函式 ─────────────────────────────────────────────────────────────────

function fmtForeign(iso: string, amount: number): string {
  return BIG_NUMBER_CURRENCIES.has(iso)
    ? Math.round(amount).toLocaleString()
    : amount.toFixed(2);
}

// ─── 各國推薦換匯地點（確切去處）────────────────────────────────────────────

const LOCAL_EXCHANGE_TIPS: Record<string, string[]> = {
  THB: [
    '🏆 推薦：SuperRich Thailand（綠色招牌，匯率比銀行好）',
    '   地點：曼谷 Central World / Asok BTS 附近均有分店',
    '   注意：避開機場換匯亭（匯率差約 3-5%）',
  ],
  JPY: [
    '🏆 推薦：日本 7-Eleven ATM（7 Bank）或郵便局 ATM',
    '   用台灣玉山/國泰卡直接提領日圓，匯率接近中間匯率',
    '   換匯所：新宿・秋葉原的「大黑屋」「GPA」也不錯',
    '   注意：機場換匯差 2-3%，建議出關後再換',
  ],
  KRW: [
    '🏆 推薦：明洞（명동）換匯所，競爭激烈匯率最優',
    '   換匯前先查「하나은행 환율」當天牌告，作為比較基準',
    '   注意：首爾以外城市換匯條件較差',
  ],
  IDR: [
    '🏆 推薦：峇里島 Seminyak / 雅加達市中心有信譽換匯所',
    '   認明「Authorized Money Changer」官方標誌',
    '   注意：街頭小店常短斤少兩，一定要當面點鈔',
  ],
  SGD: [
    '🏆 推薦：牛車水（Chinatown）換匯所，匯率比銀行優',
    '   Lucky Plaza（幸運廣場）也有多家競爭，可比較',
  ],
  MYR: [
    '🏆 推薦：吉隆坡 KLCC / Bukit Bintang 商圈換匯所',
    '   Maybank ATM 也可直接提領令吉',
  ],
  HKD: [
    '💡 港幣與台幣差距小，台灣直換通常即可',
    '   在港可用 ATM 提領，匯率合理',
  ],
};

// ─── 通用旅遊換錢策略（Wise 中間匯率版）──────────────────────────────────────

function buildTravelStrategy(
  iso: string,
  wiseRate: number,
  botRates: BOTRateEntry[],
  twBankRates: TWBankRate[],
  twd: number,
): string[] {
  const targetBOT = botRates.find((r) => r.iso === iso);
  const usdBOT    = botRates.find((r) => r.iso === 'USD');
  if (!targetBOT || !usdBOT) return [];

  // 台灣各銀行 USD 匯率比較
  const twAll: TWBankRate[] = [
    { bank: '台灣銀行', usdSell: usdBOT.cashSell },
    ...twBankRates,
  ].filter((r) => r.usdSell > 0);
  twAll.sort((a, b) => a.usdSell - b.usdSell);
  const twBest  = twAll[0];
  const twWorst = twAll[twAll.length - 1];

  // 方案 A：台灣直換目標幣別（現鈔賣出，1 次換匯手續費）
  const directAmount = twd / targetBOT.cashSell;

  // 方案 B：台幣換美金（現鈔賣出）→ 目標國換（Wise 中間匯率）
  // 注意：Plan B 共有兩層換匯手續費：
  //   第1層：台幣→美金現鈔（用 twBest.usdSell，已含銀行利差）
  //   第2層：美金→目標幣現鈔（用 Wise 中間匯率 × 0.99，模擬換匯所現鈔手續費約 1%）
  //   SuperRich 等優質換匯所手續費約 0.3-0.5%，一般銀行約 1-2%
  const CASH_SPREAD = 0.99; // 當地換匯所現鈔手續費（保守估算 1%）
  const usdAmount       = twd / twBest.usdSell;
  const viaUSDIdeal     = wiseRate > 0 ? usdAmount * wiseRate : 0;           // 理論最高（無手續費）
  const viaUSDRealistic = wiseRate > 0 ? usdAmount * wiseRate * CASH_SPREAD : 0; // 實際估算（含換匯手續費）
  const diffB    = viaUSDRealistic - directAmount;
  const diffBPct = directAmount > 0 ? (diffB / directAmount) * 100 : 0;
  const winner   = diffB > 0 ? 'B' : 'A';

  const flag = { THB: '🇹🇭', JPY: '🇯🇵', KRW: '🇰🇷', IDR: '🇮🇩', SGD: '🇸🇬', MYR: '🇲🇾', HKD: '🇭🇰' }[iso] ?? '';
  const tips = LOCAL_EXCHANGE_TIPS[iso] ?? [`💡 建議到當地銀行或換匯所換匯，避開機場`];

  const lines: string[] = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💡 ${flag} ${iso} 換錢策略比較（${twd.toLocaleString()} 台幣）`,
    ``,
    // ── 第一層：快速摘要 ──
    `  方案A（台灣直換 ${iso}，1次手續費）：${fmtForeign(iso, directAmount)} ${iso}`,
  ];

  if (wiseRate > 0) {
    lines.push(
      `  方案B（換美金去當地換，2次手續費）：${fmtForeign(iso, viaUSDRealistic)} ${iso}`,
      `         理論最高（Wise 中間匯率）  ：${fmtForeign(iso, viaUSDIdeal)} ${iso}`,
      diffB > 0
        ? `  ➕ 方案B 多 ${fmtForeign(iso, diffB)} ${iso}（+${diffBPct.toFixed(1)}%），帶美金出發更划算`
        : `  ➖ 方案A 多 ${fmtForeign(iso, -diffB)} ${iso}（${diffBPct.toFixed(1)}%），在台灣直換比較好`,
    );
  } else {
    lines.push(`  方案B（Wise 匯率無法取得，僅供參考台灣直換）`);
  }

  lines.push(
    ``,
    // ── 第二層：台灣銀行明細 ──
    `  ── 台灣（換美金，現鈔賣出越低越省） ──`,
    ...twAll.map((r) => {
      if (r.bank === twBest.bank)  return `  - ✅ 最優：${r.bank} ${r.usdSell} TWD/USD`;
      if (r.bank === twWorst.bank) return `  - ❌ 最貴：${r.bank} ${r.usdSell} TWD/USD（貴 ${((r.usdSell - twBest.usdSell) / twBest.usdSell * 100).toFixed(1)}%）`;
      return                              `  -    ${r.bank} ${r.usdSell} TWD/USD`;
    }),
  );

  if (wiseRate > 0) {
    lines.push(
      ``,
      // ── 第二層：當地匯率 ──
      `  ── 當地（USD 換 ${iso}，Wise 中間匯率） ──`,
      `  - 參考匯率：1 USD = ${wiseRate.toLocaleString()} ${iso}`,
      `  - ⚠️  此為市場中間匯率，實際換匯所約 -0.5 至 +0.2%`,
      ``,
      // ── 第三層：具體去哪換 ──
      `  ── 去哪換最划算 ──`,
      ...tips,
      ``,
      `  ✅ 最佳路線：${twBest.bank} 換美金 → 當地換匯所換 ${iso} → ${fmtForeign(iso, viaUSDRealistic)} ${iso}`,
      `  ❌ 最差：${twWorst.bank} 換美金 → 機場換匯 → 差距可達 3-5%`,
    );
  } else {
    lines.push(``, ...tips);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  return lines;
}

// ─── 越南換錢策略 ─────────────────────────────────────────────────────────────

function buildVNDStrategy(
  botRates: BOTRateEntry[],
  vcbRates: VCBRateEntry[],
  agribankRates: VCBRateEntry[],
  twBankRates: TWBankRate[],
  twd: number,
): string[] {
  const vndBOT = botRates.find((r) => r.iso === 'VND');
  const usdBOT = botRates.find((r) => r.iso === 'USD');
  if (!vndBOT || !usdBOT) return [];

  // 比較 VCB vs Agribank 的 USD 現金買入價，取最優
  const vcbUSD       = vcbRates.find((r) => r.iso === 'USD');
  const agriUSD      = agribankRates.find((r) => r.iso === 'USD');

  // 沒有任何越南銀行資料，用估算
  if (!vcbUSD && !agriUSD) {
    const fallbackRate = 25500;
    const vndDirect    = twd / vndBOT.cashSell;
    const usdAmount    = twd / usdBOT.cashSell;
    const vndViaUSD    = usdAmount * fallbackRate;
    const diff         = vndViaUSD - vndDirect;
    const diffPct      = (diff / vndDirect) * 100;
    return [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `💡 越南換錢策略比較（${twd.toLocaleString()} 台幣）`,
      `⚠️  越南銀行資料無法取得，以下使用估算匯率（${fallbackRate.toLocaleString()} VND/USD）`,
      `方案A：${Math.round(vndDirect).toLocaleString()} VND（台銀直換）`,
      `方案B：${Math.round(vndViaUSD).toLocaleString()} VND（換美金再換，估算）`,
      `差異：${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString()} VND（${diffPct.toFixed(1)}%）`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ];
  }

  // ── 台灣銀行換 USD 比較（現鈔賣出，越低越好）──
  // 把台銀也加進來一起排序
  const twAll: TWBankRate[] = [
    { bank: '台灣銀行', usdSell: usdBOT.cashSell },
    ...twBankRates,
  ].filter((r) => r.usdSell > 0);
  twAll.sort((a, b) => a.usdSell - b.usdSell); // 低到高
  const twBest  = twAll[0];
  const twWorst = twAll[twAll.length - 1];

  // 用最優台灣銀行的匯率計算方案 B
  const usdAmount  = twd / twBest.usdSell;

  // ── 越南銀行換 VND 比較（USD 現金買入，越高越好）──
  const vnCandidates: Array<{ name: string; rate: number }> = [];
  if (vcbUSD)  vnCandidates.push({ name: 'Vietcombank', rate: vcbUSD.buy });
  if (agriUSD) vnCandidates.push({ name: 'Agribank',    rate: agriUSD.buy });
  vnCandidates.sort((a, b) => b.rate - a.rate); // 高到低
  const vnBest  = vnCandidates[0];
  const vnWorst = vnCandidates[vnCandidates.length - 1];

  // 方案 A：台灣直接換 VND（用台銀）
  const vndDirect = twd / vndBOT.cashSell;

  // 方案 B：最優台灣銀行換 USD → 越南最優銀行換 VND
  const vndViaUSD  = usdAmount * vnBest.rate;
  const diffB      = vndViaUSD - vndDirect;
  const diffBPct   = (diffB / vndDirect) * 100;
  const winner     = diffB > 0 ? 'B' : 'A';

  // ── 台灣銀行比較文字 ──
  const twCompareLines: string[] = [];
  if (twAll.length > 1) {
    const twDiffPct = ((twWorst.usdSell - twBest.usdSell) / twBest.usdSell) * 100;
    twCompareLines.push(`  台灣各銀行換美金比較（現鈔賣出，越低越省）：`);
    for (const r of twAll) {
      const tag = r.bank === twBest.bank ? '  ✅ 最優' : r.bank === twWorst.bank ? '  ❌ 最貴' : '     ';
      twCompareLines.push(`  ${tag} ${r.bank}：${r.usdSell} TWD/USD`);
    }
    twCompareLines.push(`  最貴比最優貴 ${twDiffPct.toFixed(1)}%，差 ${(twWorst.usdSell - twBest.usdSell).toFixed(2)} 元`);
  } else {
    twCompareLines.push(`  台灣銀行：${twBest.usdSell} TWD/USD（台銀）`);
  }

  // ── 越南銀行比較文字 ──
  const vnCompareLines: string[] = [];
  if (vnCandidates.length > 1) {
    const vnDiffPct = ((vnBest.rate - vnWorst.rate) / vnWorst.rate) * 100;
    const vnDiffAmt = (vnBest.rate - vnWorst.rate) * usdAmount;
    vnCompareLines.push(`  越南各銀行換越南盾比較（USD 買入，越高越省）：`);
    for (const r of vnCandidates) {
      const tag = r.name === vnBest.name ? '  ✅ 最優' : '  ❌ 最差';
      vnCompareLines.push(`  ${tag} ${r.name}：${r.rate.toLocaleString()} VND/USD`);
    }
    vnCompareLines.push(`  最優比最差多 ${vnDiffPct.toFixed(1)}%（多 ${Math.round(vnDiffAmt).toLocaleString()} VND）`);
  } else if (vnCandidates.length === 1) {
    vnCompareLines.push(`  來源：${vnBest.name} 即時（${vnBest.rate.toLocaleString()} VND/USD）`);
  }

  // ── 最差情境：最貴台灣銀行換 USD → 越南最差銀行換 VND ──
  const vndWorstCase = (twd / twWorst.usdSell) * vnWorst.rate;
  const diffWorstPct = ((vndViaUSD - vndWorstCase) / vndWorstCase) * 100;

  return [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💡 越南換錢策略比較（${twd.toLocaleString()} 台幣）`,
    ``,
    // ── 第一層：快速摘要 ──
    `  方案A（台灣直換 VND）        ：${Math.round(vndDirect).toLocaleString()} VND`,
    `  方案B（換美金去越南換）      ：${Math.round(vndViaUSD).toLocaleString()} VND`,
    diffB > 0
      ? `  ➕ 方案B 多 ${Math.round(diffB).toLocaleString()} VND（+${diffBPct.toFixed(1)}%），帶美金出發更划算`
      : `  ➖ 方案A 反而多 ${Math.round(-diffB).toLocaleString()} VND（${diffBPct.toFixed(1)}%），在台灣直換比較好`,
    ``,
    // ── 第二層：台灣銀行明細 ──
    `  ── 台灣（換美金，現鈔賣出越低越省） ──`,
    ...twAll.map((r) => {
      if (r.bank === twBest.bank)  return `  - ✅ 最優：${r.bank} ${r.usdSell} TWD/USD`;
      if (r.bank === twWorst.bank) return `  - ❌ 最貴：${r.bank} ${r.usdSell} TWD/USD（貴 ${((r.usdSell - twBest.usdSell) / twBest.usdSell * 100).toFixed(1)}%）`;
      return                              `  -    ${r.bank} ${r.usdSell} TWD/USD`;
    }),
    ``,
    // ── 第二層：越南銀行明細 ──
    `  ── 越南（換越南盾，USD 買入越高越省） ──`,
    ...vnCandidates.map((r) => {
      if (r.name === vnBest.name)  return `  - ✅ 最優：${r.name} ${r.rate.toLocaleString()} VND/USD`;
      const d = ((vnBest.rate - r.rate) / vnBest.rate * 100).toFixed(1);
      return                              `  - ❌ 最差：${r.name} ${r.rate.toLocaleString()} VND/USD（少 ${d}%）`;
    }),
    ``,
    // ── 第三層：最佳 vs 最差路線 ──
    `  ── 最佳 vs 最差路線比較 ──`,
    `  ✅ 最佳：${twBest.bank} 換美金 → ${vnBest.name} 換越南盾 → ${Math.round(vndViaUSD).toLocaleString()} VND`,
    `  ❌ 最差：方案A 直換（或 ${twWorst.bank}→${vnWorst.name}）→ ${Math.round(Math.min(vndDirect, vndWorstCase)).toLocaleString()} VND`,
    `  差距最多 +${Math.round(vndViaUSD - Math.min(vndDirect, vndWorstCase)).toLocaleString()} VND（+${Math.max(diffBPct, diffWorstPct).toFixed(1)}%）`,
    ``,
    `  方案C（越南金舖 tiệm vàng）：比 ${vnBest.name} 多 50–150 VND/USD，但需現場議價`,
    `  推薦：胡志明市 Hai Bà Trưng 街（第1郡）、河內 Hàng Bạc 街`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];
}

// ─── CLI 指令定義 ─────────────────────────────────────────────────────────────

cli({
  site: 'forex',
  name: 'rate',
  description: '查詢台灣銀行即時匯率，附各國換錢策略與最優銀行建議',
  strategy: Strategy.PUBLIC,
  access: 'read' as const,
  browser: false,
  args: [
    {
      name: 'currency',
      positional: true,
      required: false,
      help: '幣別代碼（如 VND、THB、USD），不填則顯示旅遊常用幣別',
    },
    {
      name: 'amount',
      type: 'int',
      default: 10000,
      help: '台幣金額，用於計算能換多少外幣（預設 10,000）',
    },
    {
      name: 'no-strategy',
      type: 'bool',
      default: false,
      help: '不顯示換錢策略建議',
    },
  ],
  columns: ['幣別', '名稱', '現鈔賣出(TWD)', '能換到', '現鈔買入(TWD)', '來源'],
  func: async (kwargs) => {
    const currencyArg  = kwargs.currency ? String(kwargs.currency).toUpperCase() : null;
    const amount       = Math.max(1, Number(kwargs.amount) || 10000);
    const noStrategy   = Boolean(kwargs['no-strategy']);

    // 有換錢策略的幣別（VND 用真實銀行資料，其他用 Wise 中間匯率）
    const STRATEGY_CURRENCIES = new Set(['VND', ...Object.keys(LOCAL_EXCHANGE_TIPS)]);
    const iso          = currencyArg ?? 'VND';
    const showStrategy = !noStrategy && (currencyArg ? STRATEGY_CURRENCIES.has(iso) : true);
    const isVND        = iso === 'VND';

    // 平行抓取：台銀 + 越南銀行（VND 專用）+ 其他台灣銀行 USD + Wise（非 VND 幣別）
    const [botRates, vcbRates, agribankRates, twBankRates, wiseRate] = await Promise.all([
      fetchBOTRates(),
      showStrategy && isVND ? fetchVietcombankRates()  : Promise.resolve([]),
      showStrategy && isVND ? fetchAgribankRates()     : Promise.resolve([]),
      showStrategy          ? fetchAllTaiwanBanksUSD() : Promise.resolve([]),
      showStrategy && !isVND ? fetchWiseRate(iso)      : Promise.resolve(0),
    ]);

    if (!botRates.length) {
      throw new EmptyResultError('forex rate', '無法解析台灣銀行匯率，格式可能已更新');
    }

    // 篩選幣別
    const targets  = currencyArg ? [currencyArg] : TRAVEL_CURRENCIES;
    const filtered = targets
      .map((isoCode) => botRates.find((r) => r.iso === isoCode))
      .filter((r): r is BOTRateEntry => r !== undefined);

    if (!filtered.length) {
      const avail = botRates.map((r) => r.iso).join(', ');
      throw new EmptyResultError('forex rate', `找不到 ${currencyArg}，可查幣別：${avail}`);
    }

    // 顯示換錢策略
    if (showStrategy) {
      const lines = isVND
        ? buildVNDStrategy(botRates, vcbRates, agribankRates, twBankRates, amount)
        : buildTravelStrategy(iso, wiseRate as number, botRates, twBankRates, amount);
      for (const line of lines) process.stderr.write(line + '\n');
    }

    return filtered.map((r) => {
      const info   = CURRENCY_DISPLAY[r.iso];
      const canGet = amount / r.cashSell;
      return {
        幣別:            `${info?.flag ?? ''} ${r.iso}`,
        名稱:            info?.name ?? r.iso,
        '現鈔賣出(TWD)': r.cashSell,
        能換到:          fmtForeign(r.iso, canGet),
        '現鈔買入(TWD)': r.cashBuy || '—',
        來源:            '台灣銀行',
      };
    });
  },
});
