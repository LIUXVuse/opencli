/**
 * forex best — 多國換錢策略一覽
 *
 * 平行抓取所有目標幣別匯率，計算「台灣直換」vs「帶美金去當地換」，
 * 輸出排行表，讓你出發前一眼看出帶哪種幣最划算。
 *
 * 幣別來源：
 * - VND：Vietcombank + Agribank（真實銀行買入價）
 * - 其他：Wise 中間匯率 × 0.99（模擬換匯所現鈔手續費）
 */
import { EmptyResultError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';

// ─── 常數 ────────────────────────────────────────────────────────────────────

const CASH_SPREAD = 0.99; // 當地換匯所現鈔手續費估算（1%，優質換匯所約 0.5%）

const BIG_NUMBER = new Set(['VND', 'KRW', 'IDR']);

const TARGETS: Array<{
  iso: string; flag: string; name: string; tip: string;
}> = [
  { iso: 'VND', flag: '🇻🇳', name: '越南盾', tip: 'Vietcombank / 金舖' },
  { iso: 'THB', flag: '🇹🇭', name: '泰銖',   tip: 'SuperRich Thailand' },
  { iso: 'JPY', flag: '🇯🇵', name: '日圓',   tip: '7 Bank ATM / 大黑屋' },
  { iso: 'KRW', flag: '🇰🇷', name: '韓元',   tip: '明洞換匯所' },
  { iso: 'IDR', flag: '🇮🇩', name: '印尼盾', tip: 'Authorized Money Changer' },
  { iso: 'SGD', flag: '🇸🇬', name: '新加坡幣', tip: '牛車水換匯所' },
  { iso: 'MYR', flag: '🇲🇾', name: '馬幣',   tip: 'KLCC 商圈換匯所' },
  { iso: 'HKD', flag: '🇭🇰', name: '港幣',   tip: '台灣直換即可' },
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── 型別 ────────────────────────────────────────────────────────────────────

interface RateEntry { iso: string; cashSell: number; }
interface TWBankRate { bank: string; usdSell: number; }

// ─── 台灣銀行 ────────────────────────────────────────────────────────────────

async function fetchBOTRates(): Promise<RateEntry[]> {
  const res = await fetch('https://rate.bot.com.tw/xrt/flcsv/0/day', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' },
  });
  if (!res.ok) return [];
  const entries: RateEntry[] = [];
  for (const raw of (await res.text()).split('\n')) {
    const cols = raw.replace(/^\uFEFF/, '').split(',').map((c) => c.trim());
    if (cols.length < 13 || !cols[1].includes('買入')) continue;
    const iso = cols[0].toUpperCase();
    const cashSell = parseFloat(cols[12]);
    if (iso && !isNaN(cashSell) && cashSell > 0) entries.push({ iso, cashSell });
  }
  return entries;
}

async function fetchAllTaiwanBanksUSD(): Promise<TWBankRate[]> {
  const results = await Promise.allSettled([
    // 玉山銀行
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch('https://www.esunbank.com/zh-tw/personal/deposit/rate/forex/foreign-exchange-rates', { headers: BROWSER_HEADERS });
        if (!res.ok) return { bank: '玉山銀行', usdSell: 0 };
        const html = await res.text();
        const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
        let m: RegExpExecArray | null;
        let usdSell = 0;
        while ((m = ldRe.exec(html)) !== null) {
          if (!m[1].includes('ExchangeRateSpecification')) continue;
          const items = ((JSON.parse(m[1])?.mainEntity ?? {}) as Record<string, unknown>).itemListElement as Array<{ '@type': string; name: string; currency: string; currentExchangeRate: { price: string } }> ?? [];
          for (const item of items) {
            if (item.currency === 'USD' && item.name?.includes('現金匯率') && item.name?.includes('銀行賣出'))
              usdSell = parseFloat(item.currentExchangeRate?.price);
          }
          break;
        }
        return { bank: '玉山銀行', usdSell };
      } catch { return { bank: '玉山銀行', usdSell: 0 }; }
    })(),
    // 兆豐銀行
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch('https://www.megabank.com.tw/api/client/ExchangeRate/GetRateData?sc_lang=zh-TW&sc_site=bank-zh-tw&dic_lang=zh-TW', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } });
        if (!res.ok) return { bank: '兆豐銀行', usdSell: 0 };
        const json = await res.json() as { rates?: Array<{ currKey: string; cash: { ask: string } }> };
        const entry = (json.rates ?? []).find((r) => r.currKey.split('|')[0] === 'USD');
        const usdSell = entry ? parseFloat(entry.cash?.ask) : 0;
        return { bank: '兆豐銀行', usdSell: isNaN(usdSell) ? 0 : usdSell };
      } catch { return { bank: '兆豐銀行', usdSell: 0 }; }
    })(),
    // 土地銀行
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch('https://rate.landbank.com.tw/zh-TW/Foreign', { headers: BROWSER_HEADERS });
        if (!res.ok) return { bank: '土地銀行', usdSell: 0 };
        const html = await res.text();
        let usdSell = 0;
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let row: RegExpExecArray | null;
        while ((row = rowRe.exec(html)) !== null) {
          const cells: string[] = [];
          const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          let td: RegExpExecArray | null;
          while ((td = tdRe.exec(row[1])) !== null)
            cells.push(td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
          if (cells.length < 5) continue;
          if (cells[0].match(/\(([A-Z]{3})\)/)?.[1] === 'USD') { usdSell = parseFloat(cells[4]); break; }
        }
        return { bank: '土地銀行', usdSell: isNaN(usdSell) ? 0 : usdSell };
      } catch { return { bank: '土地銀行', usdSell: 0 }; }
    })(),
  ]);
  return results.map((r) => r.status === 'fulfilled' ? r.value : null).filter((r): r is TWBankRate => r !== null && r.usdSell > 0);
}

// ─── 越南銀行（VND 真實買入價）────────────────────────────────────────────────

async function fetchVCBUSD(): Promise<number> {
  try {
    const res = await fetch('https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx?b=10', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } });
    if (!res.ok) return 0;
    const xml = await res.text();
    const m = /CurrencyCode="USD"[^>]+Buy="([\d,.-]+)"/.exec(xml);
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
  } catch { return 0; }
}

async function fetchAgribankUSD(): Promise<number> {
  try {
    const res = await fetch('https://www.agribank.com.vn/vn/ty-gia', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } });
    if (!res.ok) return 0;
    const html = await res.text();
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row: RegExpExecArray | null;
    while ((row = rowRe.exec(html)) !== null) {
      const cells: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let td: RegExpExecArray | null;
      while ((td = tdRe.exec(row[1])) !== null)
        cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
      if (cells.length < 4 || cells[0].toUpperCase() !== 'USD') continue;
      const buy = parseFloat(cells[1].replace(/,/g, '')) || parseFloat(cells[2].replace(/,/g, ''));
      if (buy > 0) return buy;
    }
    return 0;
  } catch { return 0; }
}

// ─── Wise 中間匯率 ────────────────────────────────────────────────────────────

async function fetchWiseRate(target: string): Promise<number> {
  try {
    const res = await fetch(`https://wise.com/rates/live?source=USD&target=${target}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } });
    if (!res.ok) return 0;
    const json = await res.json() as { value?: number };
    return json.value ?? 0;
  } catch { return 0; }
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function fmt(iso: string, n: number): string {
  return BIG_NUMBER.has(iso) ? Math.round(n).toLocaleString() : n.toFixed(2);
}

// ─── CLI 指令定義 ─────────────────────────────────────────────────────────────

cli({
  site: 'forex',
  name: 'best',
  description: '多國換錢策略一覽：台灣直換 vs 帶美金去當地換，找出最划算路線',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: 'amount',
      type: 'int',
      default: 10000,
      help: '台幣金額（預設 10,000）',
    },
  ],
  columns: ['幣別', '名稱', '方案A 直換', '方案B 帶USD換(實際)', '差距', '推薦換匯地點'],
  func: async (_page, kwargs) => {
    const twd = Math.max(1, Number(kwargs.amount) || 10000);

    // 平行抓取所有資料
    const [botRates, twBankRates, vcbUSD, agriUSD, thb, jpy, krw, idr, sgd, myr, hkd] = await Promise.all([
      fetchBOTRates(),
      fetchAllTaiwanBanksUSD(),
      fetchVCBUSD(),
      fetchAgribankUSD(),
      fetchWiseRate('THB'),
      fetchWiseRate('JPY'),
      fetchWiseRate('KRW'),
      fetchWiseRate('IDR'),
      fetchWiseRate('SGD'),
      fetchWiseRate('MYR'),
      fetchWiseRate('HKD'),
    ]);

    if (!botRates.length) throw new EmptyResultError('forex best', '無法取得台灣銀行匯率');

    // 台灣銀行 USD 現鈔賣出（取最優）
    const usdBOT = botRates.find((r) => r.iso === 'USD');
    if (!usdBOT) throw new EmptyResultError('forex best', '無法取得 USD 匯率');

    const twAll: TWBankRate[] = [
      { bank: '台灣銀行', usdSell: usdBOT.cashSell },
      ...twBankRates,
    ].filter((r) => r.usdSell > 0).sort((a, b) => a.usdSell - b.usdSell);
    const twBest = twAll[0];
    const usdAmount = twd / twBest.usdSell; // 用最優台灣銀行換到的美金數量

    // VND 本地匯率：取 VCB vs Agribank 最高
    const vndLocalRate = Math.max(vcbUSD, agriUSD);
    const vndLocalSource = vcbUSD >= agriUSD ? 'Vietcombank' : 'Agribank';

    // 各幣別的 Plan B 本地匯率來源
    const localRateMap: Record<string, { rate: number; isReal: boolean; source: string }> = {
      VND: { rate: vndLocalRate,    isReal: true,  source: vndLocalSource },
      THB: { rate: thb * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
      JPY: { rate: jpy * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
      KRW: { rate: krw * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
      IDR: { rate: idr * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
      SGD: { rate: sgd * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
      MYR: { rate: myr * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
      HKD: { rate: hkd * CASH_SPREAD, isReal: false, source: 'Wise×0.99' },
    };

    const rows = TARGETS.map(({ iso, flag, name, tip }) => {
      const bot = botRates.find((r) => r.iso === iso);
      if (!bot) return null;

      const planA = twd / bot.cashSell;
      const local = localRateMap[iso];
      const planB = local?.rate > 0 ? usdAmount * local.rate : 0;
      const diff  = planB > 0 ? planA > 0 ? ((planB - planA) / planA) * 100 : 0 : 0;

      return {
        iso,
        幣別:               `${flag} ${iso}`,
        名稱:               name,
        '方案A 直換':        `${fmt(iso, planA)} ${iso}`,
        '方案B 帶USD換(實際)': planB > 0 ? `${fmt(iso, planB)} ${iso}${local.isReal ? '' : ' ⚠️'}` : '—',
        差距:               planB > 0 ? (diff > 0 ? `+${diff.toFixed(1)}%` : `${diff.toFixed(1)}%`) : '—',
        推薦換匯地點:        diff > 0 ? `✅ ${tip}（${twBest.bank}換USD）` : `💡 ${tip}`,
        _diff: diff, // 排序用，不顯示
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);

    // 依差距由大到小排序（Plan B 最划算的排最前面）
    rows.sort((a, b) => b._diff - a._diff);

    // 去掉排序用欄位
    return rows.map(({ _diff: _, ...rest }) => rest);
  },
});
