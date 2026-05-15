/**
 * forex 核心邏輯（Worker 版，無 CLI 依賴）
 * 提取自 src/clis/forex/rate.ts，全部使用 fetch()，相容 Cloudflare Workers
 */

export interface BOTRateEntry {
  iso: string;
  cashSell: number; // 台灣銀行現鈔賣出（出國前買外幣用這個價）
}

export interface TWBankRate {
  bank: string;
  usdSell: number; // 美金現鈔賣出（越低越好）
}

export interface VCBRateEntry {
  iso: string;
  buy: number; // 越南銀行買入外幣（帶現金去越南換）
}

export interface ForexRates {
  fetchedAt: string;       // ISO 時間戳
  bot: BOTRateEntry[];     // 台灣銀行各幣別
  twBanksUSD: TWBankRate[]; // 台灣4家銀行 USD 現鈔賣出
  vcb: VCBRateEntry[];     // 越南 Vietcombank
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ── 台灣銀行 ──────────────────────────────────────────────────────────────────

export async function fetchBOTRates(): Promise<BOTRateEntry[]> {
  const res = await fetch('https://rate.bot.com.tw/xrt/flcsv/0/day', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' },
  });
  if (!res.ok) throw new Error(`台灣銀行 HTTP ${res.status}`);

  const entries: BOTRateEntry[] = [];
  for (const raw of (await res.text()).split('\n')) {
    const cols = raw.replace(/^\uFEFF/, '').split(',').map((c) => c.trim());
    if (cols.length < 13) continue;
    const iso = cols[0].toUpperCase();
    if (!iso || iso === '幣別' || !cols[1].includes('買入')) continue;
    const cashSell = parseFloat(cols[12]);
    if (!isNaN(cashSell) && cashSell > 0) {
      entries.push({ iso, cashSell });
    }
  }
  return entries;
}

// ── 台灣各銀行 USD 現鈔賣出 ───────────────────────────────────────────────────

export async function fetchAllTaiwanBanksUSD(): Promise<TWBankRate[]> {
  const results = await Promise.allSettled([

    // 玉山銀行
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch(
          'https://www.esunbank.com/zh-tw/personal/deposit/rate/forex/foreign-exchange-rates',
          { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-TW' } },
        );
        if (!res.ok) return { bank: '玉山銀行', usdSell: 0 };
        const html = await res.text();
        const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
        let ldMatch: RegExpExecArray | null;
        let usdSell = 0;
        while ((ldMatch = ldRe.exec(html)) !== null) {
          if (!ldMatch[1].includes('ExchangeRateSpecification')) continue;
          const json = JSON.parse(ldMatch[1]);
          const items = (json?.mainEntity?.itemListElement ?? []) as Array<{
            name: string; currency: string; currentExchangeRate: { price: string };
          }>;
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

    // 兆豐銀行
    (async (): Promise<TWBankRate> => {
      try {
        const res = await fetch(
          'https://www.megabank.com.tw/api/client/ExchangeRate/GetRateData?sc_lang=zh-TW&sc_site=bank-zh-tw&dic_lang=zh-TW',
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
        );
        if (!res.ok) return { bank: '兆豐銀行', usdSell: 0 };
        const json = await res.json() as { rates?: Array<{ currKey: string; cash: { ask: string } }> };
        const entry = (json.rates ?? []).find((r) => r.currKey.split('|')[0] === 'USD');
        const usdSell = entry ? parseFloat(entry.cash?.ask) : 0;
        return { bank: '兆豐銀行', usdSell: isNaN(usdSell) ? 0 : usdSell };
      } catch { return { bank: '兆豐銀行', usdSell: 0 }; }
    })(),

    // 台灣銀行 USD（從 BOT CSV 取）
    (async (): Promise<TWBankRate> => {
      try {
        const rates = await fetchBOTRates();
        const usd = rates.find((r) => r.iso === 'USD');
        return { bank: '台灣銀行', usdSell: usd?.cashSell ?? 0 };
      } catch { return { bank: '台灣銀行', usdSell: 0 }; }
    })(),

  ]);

  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is TWBankRate => r !== null && r.usdSell > 0);
}

// ── Vietcombank ───────────────────────────────────────────────────────────────

export async function fetchVietcombankRates(): Promise<VCBRateEntry[]> {
  const res = await fetch(
    'https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx?b=10',
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
  );
  if (!res.ok) return [];

  const xml = await res.text();
  const entries: VCBRateEntry[] = [];
  const re = /CurrencyCode="([^"]+)"[^/]*Buy="([\d,. ]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const buy = parseFloat(m[2].replace(/,/g, '').trim());
    if (!isNaN(buy) && buy > 0) entries.push({ iso: m[1], buy });
  }
  return entries;
}

// ── Wise 中間匯率 ─────────────────────────────────────────────────────────────

export async function fetchWiseRate(target: string): Promise<number> {
  try {
    const res = await fetch(
      `https://wise.com/rates/live?source=USD&target=${target}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; opencli-forex/1.0)' } },
    );
    if (!res.ok) return 0;
    const json = await res.json() as { value?: number };
    return json.value ?? 0;
  } catch { return 0; }
}

// ── 一次抓取所有匯率 ──────────────────────────────────────────────────────────

export async function fetchAllRates(): Promise<ForexRates> {
  const [bot, twBanksUSD, vcb] = await Promise.all([
    fetchBOTRates(),
    fetchAllTaiwanBanksUSD(),
    fetchVietcombankRates(),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    bot,
    twBanksUSD,
    vcb,
  };
}
