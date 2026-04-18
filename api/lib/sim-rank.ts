/**
 * sim-rank 核心邏輯（Worker 版，無 CLI 依賴）
 * 提取自 src/clis/trip/sim-rank.ts
 */

export interface SimPlan {
  rank: number;
  name: string;
  type: 'eSIM' | 'SIM card';
  plan: string;
  days: number | '?';
  daily_gb: string;
  min_price_usd: number;
  formula: string;
  cp_score: string;
  real_name_req: 'Yes' | 'No';
  url: string;
}

// ── 解析函式 ─────────────────────────────────────────────────────────────────

function parseDays(name: string): number | null {
  const rangeMatch = name.match(/(\d+)\s*[-–]\s*\d+\s*days?/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const singleMatch = name.match(/(\d+)\s*days?/i);
  if (singleMatch) return parseInt(singleMatch[1], 10);
  return null;
}

function parseDailyGb(name: string): number | null {
  const dailyMatch = name.match(/daily\s+([\d.]+)\s*gb/i);
  if (dailyMatch) return parseFloat(dailyMatch[1]);
  const perDayMatch = name.match(/([\d.]+)\s*gb\s*\/\s*day/i);
  if (perDayMatch) return parseFloat(perDayMatch[1]);
  return null;
}

/**
 * 從產品名稱解析總流量（Total Data 方案）
 * 例如: "Total data 15GB/35GB/50GB/100GB" → 15（取最小選項）
 *      "Total data 30GB" → 30
 */
function parseTotalGb(name: string): number | null {
  // 匹配 "Total data XGB" 或 "Total XGB"，後面可能跟著 /YGB/ZGB...
  const totalMatch = name.match(/total\s*(?:data)?\s*([\d.]+)\s*gb/i);
  if (!totalMatch) return null;
  // 如果有多個選項（如 15GB/35GB），取第一個（最小）
  return parseFloat(totalMatch[1]);
}

function parsePlanType(name: string): string {
  const hasDayPass = /day\s*pass|calendar.?day\s*billing/i.test(name);
  const hasTotal = /total\s*(data)?\s*(package)?/i.test(name);
  if (hasDayPass && hasTotal) return 'Day Pass / Total';
  if (hasDayPass) return 'Day Pass';
  if (hasTotal) return 'Total Data';
  return 'Fixed';
}

function parseDaysFromRemark(remark: string): number | null {
  const m = remark.match(/[- "](\d+)\s*days?[- "]/i);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d > 90) return null;
    return d;
  }
  return null;
}

function parseIsEsim(name: string): boolean {
  return /\beSIM\b/i.test(name);
}

function parseRealName(name: string): boolean {
  return /\blocal\s+(ip|sim|esim)\b/i.test(name) ||
    /\breal\s*-?\s*name\b/i.test(name) ||
    /\bVNSKY\b/i.test(name);
}

function isSuspiciousGb(gb: number | null): boolean {
  return gb !== null && gb > 30;
}

function calcCpScore(
  dailyGb: number | null,
  price: number,
  productMinDays: number | null,
  planType: string,
  userDays?: number,
): { cpScore: number | null; formula: string; isEstimate: boolean } {
  if (price <= 0) return { cpScore: null, formula: 'N/A', isEstimate: false };

  let pricePerDay: number;
  let isEstimate = false;

  if (planType.includes('Day Pass')) {
    pricePerDay = price;
  } else if (productMinDays !== null && productMinDays > 0) {
    pricePerDay = price / productMinDays;
  } else {
    pricePerDay = price / (userDays ?? 1);
    isEstimate = true;
  }

  if (pricePerDay <= 0) return { cpScore: null, formula: 'N/A', isEstimate: false };

  const estimateNote = isEstimate ? `（估算，天數按 ${userDays ?? 1}天計）` : '';

  if (dailyGb !== null) {
    if (isSuspiciousGb(dailyGb)) {
      const cp = parseFloat((dailyGb / pricePerDay).toFixed(3));
      return { cpScore: cp, formula: '⚠️ 宣稱流量偏高，CP 僅供參考', isEstimate: true };
    }
    const cp = parseFloat((dailyGb / pricePerDay).toFixed(3));
    return { cpScore: cp, formula: `${dailyGb}GB ÷ $${pricePerDay.toFixed(2)}/天 = ${cp}${estimateNote}`, isEstimate };
  }

  // Day Pass 無流量資訊，無法可靠計算 CP（原 0.5GB 估算已移除）
  return { cpScore: null, formula: 'N/A（無流量資訊）', isEstimate: false };
}

// ── 查詢 trip.com ─────────────────────────────────────────────────────────────

export async function fetchAndRankSimCards(opts: {
  country?: string;
  minDays?: number;
  maxDays?: number;
  simType?: 'all' | 'esim' | 'physical';
  noRealName?: boolean;
  limit?: number;
}): Promise<SimPlan[]> {
  const country = opts.country ?? 'Vietnam';
  const minDays = opts.minDays;
  const maxDays = opts.maxDays;
  const simType = opts.simType ?? 'all';
  const noRealName = opts.noRealName ?? false;
  const limit = Math.min(opts.limit ?? 10, 20);
  const fetchSize = Math.min(limit * 3, 50);

  const filteredItems: Array<{ type: string; values: string[] }> = [];
  if (minDays !== undefined) {
    filteredItems.push({ type: '47', values: [String(minDays)] });
  }

  const res = await fetch('https://www.trip.com/restapi/soa2/20684/json/productSearch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      client: { currency: 'USD', locale: 'en-XX', platformId: 24, channel: 118 },
      filtered: { items: filteredItems, pageIndex: 1, pageSize: fetchSize, sort: '1', tab: 'simcard' },
      destination: { keyword: `${country} SIM card` },
      requestSource: 'activity',
      productOption: { needBasicInfo: true, needPrice: true, needRanking: true },
      head: { Locale: 'en-XX', Currency: 'USD' },
    }),
  });

  if (!res.ok) throw new Error(`trip.com API HTTP ${res.status}`);
  const payload = await res.json() as {
    ResponseStatus: { Ack: string };
    products?: Array<{
      id: string;
      basicInfo: { name: string; detailUrl?: { URL?: string; ONLINE?: string } };
      priceInfo: { price: number; minPriceRemarks?: string[] };
    }>;
  };
  if (payload.ResponseStatus?.Ack !== 'Success') throw new Error('trip.com API error');

  const products = payload.products ?? [];

  const parsed = products.map((p) => {
    const name = p.basicInfo?.name ?? '';
    const isEsim = parseIsEsim(name);
    const planType = parsePlanType(name);
    const daysFromName = parseDays(name);
    const remark = p.priceInfo?.minPriceRemarks?.[1] ?? '';
    const days = daysFromName ?? (planType === 'Fixed' ? parseDaysFromRemark(remark) : null);
    const realNameReq = parseRealName(name);
    const price = p.priceInfo?.price ?? 0;
    const url = p.basicInfo?.detailUrl?.URL ?? p.basicInfo?.detailUrl?.ONLINE ?? '';

    // 計算每日流量：優先解析 "Daily XGB"，其次從 Total Data 總量推算
    let dailyGb = parseDailyGb(name);
    let dailyGbIsFromTotal = false;
    if (dailyGb === null && planType.includes('Total Data')) {
      const totalGb = parseTotalGb(name);
      if (totalGb !== null) {
        if (days !== null && days > 0) {
          // 產品本身標了天數 → 精確計算，任何 totalGb 都可用
          dailyGb = parseFloat((totalGb / days).toFixed(3));
          dailyGbIsFromTotal = false;
        } else if (totalGb <= 30 && minDays) {
          // totalGb 合理（≤30GB）且只有用戶天數 → 估算，標記 ~
          // 超過 30GB 時拒絕用用戶天數估算，因為方案實際天數可能遠大於查詢天數
          dailyGb = parseFloat((totalGb / minDays).toFixed(3));
          dailyGbIsFromTotal = true;
        }
        // totalGb > 30 且產品天數未知 → 保持 dailyGb = null，不亂猜
      }
    }

    const { cpScore, formula, isEstimate } = calcCpScore(dailyGb, price, days, planType, minDays);
    const cpDisplay = cpScore !== null ? ((isEstimate || dailyGbIsFromTotal) ? `~${cpScore}` : String(cpScore)) : 'N/A';

    return {
      name: name.split(/\s*\|\s*/).slice(0, 2).join(' | ').substring(0, 60),
      type: (isEsim ? 'eSIM' : 'SIM card') as 'eSIM' | 'SIM card',
      plan: planType,
      days: (days ?? '?') as number | '?',
      daily_gb: dailyGb !== null ? String(dailyGb) : '彈性',
      min_price_usd: price,
      formula,
      cpDisplay,
      real_name_req: (realNameReq ? 'Yes' : 'No') as 'Yes' | 'No',
      url,
      _isEsim: isEsim,
      _realName: realNameReq,
      _cpScore: cpScore,
      _productDays: days,
    };
  });

  let filtered = parsed.filter((item) => {
    if (simType === 'esim' && !item._isEsim) return false;
    if (simType === 'physical' && item._isEsim) return false;
    if (noRealName && item._realName) return false;
    if (minDays !== undefined && maxDays !== undefined) {
      const d = item._productDays;
      if (d !== null && (d < minDays || d > maxDays)) return false;
    }
    return true;
  });

  // 計算每日費用，用於 CP 相同或無 CP 時的次要排序
  function pricePerDay(item: typeof filtered[0]): number {
    if (item.plan.includes('Day Pass')) return item.min_price_usd; // Day Pass price 本身就是每日費用
    const d = item._productDays ?? minDays ?? 1;
    return item.min_price_usd / d;
  }

  filtered.sort((a, b) => {
    // 有 CP 值的排前面
    if (a._cpScore !== null && b._cpScore !== null) {
      const diff = (b._cpScore ?? 0) - (a._cpScore ?? 0);
      if (diff !== 0) return diff;
      return pricePerDay(a) - pricePerDay(b); // CP 相同時比每日費用
    }
    if (a._cpScore === null && b._cpScore === null) {
      return pricePerDay(a) - pricePerDay(b); // 兩者都無 CP，改比每日費用（低→高）
    }
    if (a._cpScore === null) return 1;
    return -1;
  });

  return filtered.slice(0, limit).map((item, index) => ({
    rank: index + 1,
    name: item.name,
    type: item.type,
    plan: item.plan,
    days: item.days,
    daily_gb: item.daily_gb,
    min_price_usd: item.min_price_usd,
    price_per_day: parseFloat(pricePerDay(item).toFixed(3)),
    formula: item.formula,
    cp_score: item.cpDisplay,
    real_name_req: item.real_name_req,
    url: item.url,
  }));
}
