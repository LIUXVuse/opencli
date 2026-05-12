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

function parseDailyGbFromRemark(remark: string): number | null {
  // remark 格式："Package QR code-1 day-Daily 0.5GB"、"Daily - 0.5GB"、"DayPass - 500MB"
  const gbMatch = remark.match(/daily\s*[-–]?\s*([\d.]+)\s*gb/i);
  if (gbMatch) return parseFloat(gbMatch[1]);
  const mbMatch = remark.match(/(?:daily|daypass)\s*[-–]?\s*([\d.]+)\s*mb/i);
  if (mbMatch) return parseFloat((parseFloat(mbMatch[1]) / 1024).toFixed(3));
  // "7GB data/day" 或 "7GB/day" 格式
  const perDayMatch = remark.match(/([\d.]+)\s*gb\s*(?:data\s*)?\/\s*day/i);
  if (perDayMatch) return parseFloat(perDayMatch[1]);
  return null;
}

/**
 * 從 remark 解析總流量（Total 方案）
 * 結合 parseDaysFromRemark 可推算每日流量
 * 例如: "Total-30GB"、"Total - 30GB"、"Total 0.5GB" → 30 / 0.5
 */
function parseTotalGbFromRemark(remark: string): number | null {
  const m = remark.match(/total\s*[-–]?\s*([\d.]+)\s*gb/i);
  if (m) return parseFloat(m[1]);
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

// ── Trip.com 產品詳細頁解析（取得精確套餐價格）────────────────────────────────

/** 從 HTML 字串中提取第一個完整 JSON 陣列 */
function extractJsonArray(html: string, key: string): unknown[] | null {
  const keyIdx = html.indexOf(`"${key}":`);
  if (keyIdx === -1) return null;
  const start = html.indexOf('[', keyIdx);
  if (start === -1) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  try { return JSON.parse(html.slice(start, end)) as unknown[]; } catch { return null; }
}

interface RawPackage {
  packageId: number;
  salesProperties: Array<{
    saleProperty: { name: string };
    salePropertyValues: Array<{ name: string }>;
  }>;
  resourceIds: number[];
}

interface RawResource {
  resourceId: number;
  basicInfo: { minPrice: number };
}

/**
 * 抓取產品詳細頁，找出指定天數中 CP 最高的套餐
 * 回傳 null 表示找不到或 fetch 失敗
 */
async function fetchBestPackage(
  productId: string,
  targetDays: number,
): Promise<{ dailyGb: number; totalPrice: number; gbLabel: string } | null> {
  try {
    const res = await fetch(
      `https://www.trip.com/things-to-do/detail/${productId}?language=EN&locale=en_xx`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
    );
    if (!res.ok) return null;
    const html = await res.text();

    // 折扣比例（每個產品各自的促銷折扣）
    const discountMatch = html.match(/"startPriceInfo":\{"originalPrice":([\d.]+),"price":([\d.]+)/);
    if (!discountMatch) return null;
    const discountRatio = parseFloat(discountMatch[2]) / parseFloat(discountMatch[1]);

    const packages = extractJsonArray(html, 'packages') as RawPackage[] | null;
    const resources = extractJsonArray(html, 'resourceInfos') as RawResource[] | null;
    if (!packages || !resources) return null;

    // resourceId → 實際售價
    const priceMap = new Map<number, number>(
      resources.map(r => [r.resourceId, parseFloat((r.basicInfo.minPrice * discountRatio).toFixed(3))]),
    );

    let best: { dailyGb: number; totalPrice: number; gbLabel: string; cp: number } | null = null;

    for (const pkg of packages) {
      const daysProp = pkg.salesProperties.find(sp => sp.saleProperty.name === 'Days');
      const gbProp = pkg.salesProperties.find(sp => sp.saleProperty.name === 'Package Contents');
      if (!daysProp || !gbProp) continue;

      // 解析天數
      const daysLabel = daysProp.salePropertyValues[0]?.name ?? '';
      const daysMatch = daysLabel.match(/^(\d+)\s*days?$/i);
      if (!daysMatch || parseInt(daysMatch[1], 10) !== targetDays) continue;

      const gbLabel = gbProp.salePropertyValues[0]?.name ?? '';
      const totalPrice = priceMap.get(pkg.resourceIds[0]);
      if (!totalPrice || totalPrice <= 0) continue;

      // 解析每日 GB
      let dailyGb: number | null = null;
      const dailyMatch = gbLabel.match(/daily\s+([\d.]+)\s*gb/i);
      if (dailyMatch) { dailyGb = parseFloat(dailyMatch[1]); }
      else {
        const totalMatch = gbLabel.match(/total\s*([\d.]+)\s*gb/i);
        if (totalMatch) { dailyGb = parseFloat((parseFloat(totalMatch[1]) / targetDays).toFixed(3)); }
      }
      if (dailyGb === null || dailyGb > 30) continue; // 跳過可疑高流量

      const cp = dailyGb / (totalPrice / targetDays);
      if (best === null || cp > best.cp) {
        best = { dailyGb, totalPrice, gbLabel, cp };
      }
    }

    return best ? { dailyGb: best.dailyGb, totalPrice: best.totalPrice, gbLabel: best.gbLabel } : null;
  } catch {
    return null;
  }
}

// ── 查詢 trip.com ─────────────────────────────────────────────────────────────

export async function fetchAndRankSimCards(opts: {
  country?: string;
  minDays?: number;
  maxDays?: number;
  simType?: 'all' | 'esim' | 'physical';
  noRealName?: boolean;
  limit?: number;
  minDailyGb?: number;
}): Promise<SimPlan[]> {
  const country = opts.country ?? 'Vietnam';
  const minDays = opts.minDays;
  const maxDays = opts.maxDays;
  const simType = opts.simType ?? 'all';
  const noRealName = opts.noRealName ?? false;
  const limit = Math.min(opts.limit ?? 10, 20);
  const minDailyGb = opts.minDailyGb ?? 3;
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

  // 精確天數查詢時，對彈性方案預先抓取詳細套餐（最多 8 個並行）
  const isExactDays = minDays !== undefined && maxDays !== undefined && minDays === maxDays;
  const detailMap = new Map<string, { dailyGb: number; totalPrice: number; gbLabel: string }>();
  if (isExactDays) {
    const flexProducts = products
      .filter(p => {
        const pt = parsePlanType(p.basicInfo?.name ?? '');
        return pt.includes('Day Pass') || pt.includes('Total Data');
      })
      .slice(0, 8);
    const results = await Promise.allSettled(
      flexProducts.map(p => fetchBestPackage(p.id, minDays!)),
    );
    flexProducts.forEach((p, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value) detailMap.set(p.id, r.value);
    });
  }

  const parsed = products.map((p) => {
    const name = p.basicInfo?.name ?? '';
    const isEsim = parseIsEsim(name);
    const planType = parsePlanType(name);
    const daysFromName = parseDays(name);
    const remark = p.priceInfo?.minPriceRemarks?.[1] ?? '';
    const days = daysFromName ?? (planType === 'Fixed' ? parseDaysFromRemark(remark) : null);
    const realNameReq = parseRealName(name);
    const url = p.basicInfo?.detailUrl?.URL ?? p.basicInfo?.detailUrl?.ONLINE ?? '';

    // 有 detail 資料（精確天數查詢）→ 用真實套餐價格覆蓋，planType 視為 Fixed 計算
    const detail = detailMap.get(p.id);
    const price = detail ? detail.totalPrice : (p.priceInfo?.price ?? 0);
    const detailDays = detail ? minDays! : null;

    // 計算每日流量：優先解析名稱，其次從 remark 備援，最後從 Total Data 總量推算
    let dailyGb: number | null = detail ? detail.dailyGb : (parseDailyGb(name) ?? parseDailyGbFromRemark(remark));
    let dailyGbIsFromTotal = false;
    const dailyGbIsFromRemark = !detail && dailyGb !== null && parseDailyGb(name) === null;
    // remark 明確標示 Total XGB + N days → 精確計算每日流量（不估算）
    if (dailyGb === null) {
      const totalGbFromRemark = parseTotalGbFromRemark(remark);
      const remarkDays = parseDaysFromRemark(remark);
      if (totalGbFromRemark !== null && remarkDays !== null && remarkDays > 0) {
        dailyGb = parseFloat((totalGbFromRemark / remarkDays).toFixed(3));
      }
    }
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

    // detail 有資料時視為 Fixed（天數和價格都精確），直接覆蓋 days 和 planType
    const effectiveDays = detailDays ?? days;
    const effectivePlanType = detail ? 'Fixed' : planType;
    const { cpScore, formula, isEstimate } = calcCpScore(dailyGb, price, effectiveDays, effectivePlanType, minDays);
    const cpDisplay = cpScore !== null
      ? ((isEstimate || dailyGbIsFromTotal || dailyGbIsFromRemark) ? `~${cpScore}` : String(cpScore))
      : 'N/A';

    return {
      name: name.split(/\s*\|\s*/).slice(0, 2).join(' | ').substring(0, 60),
      type: (isEsim ? 'eSIM' : 'SIM card') as 'eSIM' | 'SIM card',
      plan: detail ? `${planType} ✓${detail.gbLabel}` : planType,
      days: (effectiveDays ?? '?') as number | '?',
      daily_gb: dailyGb !== null ? String(dailyGb) : '彈性',
      min_price_usd: price,
      formula,
      cpDisplay,
      real_name_req: (realNameReq ? 'Yes' : 'No') as 'Yes' | 'No',
      url,
      _isEsim: isEsim,
      _realName: realNameReq,
      _cpScore: cpScore,
      _productDays: effectiveDays,
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
    // 過濾每日流量不足的方案（dailyGb 已知且低於門檻）
    const gb = parseFloat(item.daily_gb);
    if (!isNaN(gb) && gb < minDailyGb) return false;
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
