/**
 * trip/sim-rank — trip.com SIM 卡 CP 值排名查詢
 *
 * 從 trip.com 撈取指定國家的 SIM 卡方案，
 * 解析天數、流量、是否 eSIM、是否需要實名制，
 * 並依照 CP 值（每元可得流量）排名輸出。
 *
 * 用法:
 *   opencli trip sim-rank
 *   opencli trip sim-rank --country Vietnam --days 7
 *   opencli trip sim-rank --days 7 --sim-type esim
 *   opencli trip sim-rank --days 7 --sort cp -f json
 */

import { ArgumentError, CliError, EmptyResultError } from '../../errors.js';
import { cli, Strategy } from '../../registry.js';

// ── 型別定義 ──────────────────────────────────────────────────────────────────

interface TripProduct {
  id: string;
  basicInfo: {
    name: string;
    mainName?: string;
    detailUrl?: {
      URL?: string;
      ONLINE?: string;
    };
    extras?: Record<string, string>;
    statusInfo?: {
      isOnline?: boolean;
      isCanSale?: boolean;
    };
  };
  priceInfo: {
    price: number;
    originalPrice?: number;
    priceUnit?: string;
    minPriceRemarks?: string[];
  };
  statistics?: {
    commentScore?: number;
    salesVolume?: number;
  };
}

interface TripSearchResponse {
  ResponseStatus: {
    Ack: string;
    Errors?: Array<{ Message: string }>;
  };
  products?: TripProduct[];
  total?: number;
}

// ── 解析函式 ──────────────────────────────────────────────────────────────────

/**
 * 從產品名稱解析最小天數
 * 例如: "1-30 Days" → 1, "3-30 Days" → 3, "5 Days" → 5
 */
function parseDays(name: string): number | null {
  // 匹配 "N-M Days" 或 "N–M Days"（N=最小天數）
  const rangeMatch = name.match(/(\d+)\s*[-–]\s*\d+\s*days?/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);

  // 匹配 "N Days"
  const singleMatch = name.match(/(\d+)\s*days?/i);
  if (singleMatch) return parseInt(singleMatch[1], 10);

  return null;
}

/**
 * 從產品名稱解析每日流量 (GB)
 * 例如: "Daily 5GB" → 5, "Daily 0.5GB" → 0.5, "Daily 9GB" → 9
 * "Day Pass/Total Data Package" → null (彈性方案)
 *
 * 注意：超過 30GB/天 的宣稱通常是行銷說法（速度上限），不代表真實可用流量
 */
function parseDailyGb(name: string): number | null {
  // 匹配 "Daily XGB" 或 "Daily X GB"
  const dailyMatch = name.match(/daily\s+([\d.]+)\s*gb/i);
  if (dailyMatch) return parseFloat(dailyMatch[1]);

  // 匹配 "XGB/Day" 或 "X GB/Day"
  const perDayMatch = name.match(/([\d.]+)\s*gb\s*\/\s*day/i);
  if (perDayMatch) return parseFloat(perDayMatch[1]);

  return null;
}

/**
 * 從 minPriceRemarks 解析每日流量（備援方案）
 * trip.com remark 格式："Package QR code-1 day-Daily 0.5GB" 或 "Daily - 0.5GB"
 */
function parseDailyGbFromRemark(remark: string): number | null {
  // remark 格式："Package QR code-1 day-Daily 0.5GB"、"Daily - 0.5GB"、"DayPass - 500MB"
  const gbMatch = remark.match(/daily\s*[-–]?\s*([\d.]+)\s*gb/i);
  if (gbMatch) return parseFloat(gbMatch[1]);
  const mbMatch = remark.match(/(?:daily|daypass)\s*[-–]?\s*([\d.]+)\s*mb/i);
  if (mbMatch) return parseFloat((parseFloat(mbMatch[1]) / 1024).toFixed(3));
  return null;
}

/**
 * 每日流量是否為可疑的行銷宣稱（>30GB/天）
 * 超過此值通常是「速度上限描述」而非真實流量
 */
function isSuspiciousGb(gb: number | null): boolean {
  return gb !== null && gb > 30;
}

/**
 * 解析方案類型標籤
 * Day Pass → 彈性按日計費（價格即每日費用）
 * Total Data → 彈性總量計費
 * 兩者都有 → 兩種都支援
 * Calendar-Day Billing → Day Pass 的另一種說法
 */
function parsePlanType(name: string): string {
  const hasDayPass = /day\s*pass|calendar.?day\s*billing/i.test(name);
  const hasTotal = /total\s*(data)?\s*(package)?/i.test(name);
  if (hasDayPass && hasTotal) return 'Day Pass / Total';
  if (hasDayPass) return 'Day Pass';
  if (hasTotal) return 'Total Data';
  return 'Fixed';
}

/**
 * 從 minPriceRemarks 解析天數（備援方案）
 * trip.com 的 minPriceRemarks[1] 格式通常為：
 *   "You can book \"Package QR code-7 days-Daily 5GB\" at this price..."
 * 從中萃取天數數字
 */
function parseDaysFromRemark(remark: string): number | null {
  // 匹配 "X days" 或 "X day"（排除 365 天長效卡）
  const m = remark.match(/[- "](\d+)\s*days?[- "]/i);
  if (m) {
    const d = parseInt(m[1], 10);
    // 365 天通常是「有效期」而非行程天數，跳過
    if (d > 90) return null;
    return d;
  }
  return null;
}

/**
 * 解析是否為 eSIM
 */
function parseIsEsim(name: string): boolean {
  return /\beSIM\b/i.test(name);
}

/**
 * 解析是否需要實名制
 * 線索：產品名稱或描述中出現 local IP / local SIM 通常需要實名
 * "Local IP" / "VNSKY" / "Real-name" 關鍵字
 */
function parseRealName(name: string): boolean {
  return /\blocal\s+(ip|sim|esim)\b/i.test(name) ||
    /\breal\s*-?\s*name\b/i.test(name) ||
    /\bregistration\s*required\b/i.test(name) ||
    /\bVNSKY\b/i.test(name) ||
    /\blocal\s+phone\s+number\b/i.test(name);
}

/**
 * 計算 CP 值
 *
 * 計算邏輯：
 * - Day Pass 方案：price 本身就是每日費用，直接使用
 * - Fixed 方案：price 除以「產品本身的天數」得每日費用
 *   - 天數已知（例如 days=3）→ pricePerDay = price / 3，精確
 *   - 天數未知（days=?）→ pricePerDay = price / userDays，估算，標示 ~
 *
 * CP 公式：CP = GB/日 ÷ 每日費用（越高越划算）
 *
 * 回傳：{ cpScore: number | null; formula: string; isEstimate: boolean }
 */
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
    // Day Pass：price 就是每日費用
    pricePerDay = price;
  } else if (productMinDays !== null && productMinDays > 0) {
    // Fixed，天數已知：price 除以產品自身天數
    pricePerDay = price / productMinDays;
  } else {
    // Fixed，天數不明：用 userDays 估算，標記為估算
    pricePerDay = price / (userDays ?? 1);
    isEstimate = true;
  }

  if (pricePerDay <= 0) return { cpScore: null, formula: 'N/A', isEstimate: false };

  const estimateNote = isEstimate ? `（估算，天數按 ${userDays ?? 1}天計）` : '';

  if (dailyGb !== null) {
    // 超過 30GB 的宣稱通常是行銷說法，CP 僅供參考
    const suspiciousNote = isSuspiciousGb(dailyGb) ? '⚠️ 宣稱流量偏高，CP 僅供參考' : '';
    const cp = parseFloat((dailyGb / pricePerDay).toFixed(3));
    const formula = suspiciousNote
      ? `${suspiciousNote}`
      : `${dailyGb}GB ÷ $${pricePerDay.toFixed(2)}/天 = ${cp}${estimateNote}`;
    // 可疑流量的 cpScore 仍保留讓排序參考，但 formula 顯示警告
    return { cpScore: cp, formula, isEstimate: isEstimate || isSuspiciousGb(dailyGb) };
  }

  if (planType.includes('Day Pass')) {
    const estimatedGb = 0.5;
    const cp = parseFloat((estimatedGb / pricePerDay).toFixed(3));
    const formula = `~${estimatedGb}GB ÷ $${pricePerDay.toFixed(2)}/天 ≈ ${cp}（估算）`;
    return { cpScore: cp, formula, isEstimate: true };
  }

  return { cpScore: null, formula: 'N/A', isEstimate: false };
}

/**
 * 從產品名稱萃取簡短的方案說明（去除重複詞、截短）
 */
function buildShortName(name: string): string {
  // 用 | 切分，取前兩段
  const parts = name.split(/\s*\|\s*/);
  return parts.slice(0, 2).join(' | ').substring(0, 60);
}

/**
 * 限制數字在合法範圍
 */
function clampLimit(raw: unknown, fallback = 20): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), 50));
}

// ── 主要查詢函式 ──────────────────────────────────────────────────────────────

async function fetchSimCards(country: string, pageSize: number, days?: number): Promise<TripProduct[]> {
  const keyword = `${country} SIM card`;

  const filteredItems: Array<{ type: string; values: string[] }> = [];

  // 如果指定了天數，加入天數過濾 (type=47 是天數過濾器)
  if (days !== undefined && days > 0) {
    filteredItems.push({ type: '47', values: [String(days)] });
  }

  const response = await fetch('https://www.trip.com/restapi/soa2/20684/json/productSearch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      client: {
        currency: 'USD',
        locale: 'en-XX',
        platformId: 24,
        channel: 118,
      },
      filtered: {
        items: filteredItems,
        pageIndex: 1,
        pageSize,
        sort: '1',
        tab: 'simcard',
      },
      destination: {
        keyword,
      },
      requestSource: 'activity',
      productOption: {
        needBasicInfo: true,
        needPrice: true,
        needRanking: true,
      },
      head: {
        Locale: 'en-XX',
        Currency: 'USD',
      },
    }),
  });

  if (!response.ok) {
    throw new CliError(
      'FETCH_ERROR',
      `trip.com API 回應失敗，狀態碼 ${response.status}`,
      '請確認網路連線，或稍後再試',
    );
  }

  const payload = (await response.json()) as TripSearchResponse;

  if (payload.ResponseStatus?.Ack !== 'Success') {
    const errMsg = payload.ResponseStatus?.Errors?.[0]?.Message ?? 'Unknown API error';
    throw new CliError('API_ERROR', `trip.com API 錯誤: ${errMsg}`, '請確認參數是否正確');
  }

  return payload.products ?? [];
}

// ── 指令註冊 ──────────────────────────────────────────────────────────────────

cli({
  site: 'trip',
  name: 'sim-rank',
  aliases: ['sim', 'simrank'],
  description: '查詢 trip.com SIM 卡方案並依 CP 值排名（預設：越南）',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: 'country',
      type: 'str',
      default: 'Vietnam',
      positional: false,
      help: '查詢的國家名稱（英文），例如：Vietnam, Japan, Thailand',
    },
    {
      name: 'days',
      type: 'str',
      positional: false,
      help: '查詢天數，支援單一天數或範圍，例如：7、7-9、10-14',
    },
    {
      name: 'limit',
      type: 'int',
      default: 20,
      help: '顯示筆數（最多 50）',
    },
    {
      name: 'sim_type',
      type: 'str',
      default: 'all',
      choices: ['all', 'esim', 'physical'],
      help: 'SIM 卡類型：all（全部）、esim（純 eSIM）、physical（實體卡）',
    },
    {
      name: 'sort',
      type: 'str',
      default: 'cp',
      choices: ['cp', 'price', 'name'],
      help: '排序方式：cp（CP 值，預設）、price（價格低→高）、name（名稱）',
    },
    {
      name: 'no_real_name',
      type: 'bool',
      default: false,
      help: '只顯示不需要實名制的方案',
    },
  ],
  columns: ['rank', 'name', 'type', 'plan', 'days', 'daily_gb', 'min_price_usd', 'formula', 'cp_score', 'real_name_req', 'url'],
  func: async (_page, kwargs) => {
    const country = String(kwargs.country || 'Vietnam').trim();
    if (!country) throw new ArgumentError('國家名稱不可為空，例如：Vietnam');

    // 解析天數：支援 "7" 或 "7-9" 格式
    let minDays: number | undefined;
    let maxDays: number | undefined;
    if (kwargs.days) {
      const daysStr = String(kwargs.days).trim();
      const rangeMatch = daysStr.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      const singleMatch = daysStr.match(/^(\d+)$/);
      if (rangeMatch) {
        minDays = parseInt(rangeMatch[1], 10);
        maxDays = parseInt(rangeMatch[2], 10);
        if (minDays > maxDays) [minDays, maxDays] = [maxDays, minDays];
      } else if (singleMatch) {
        minDays = parseInt(singleMatch[1], 10);
        maxDays = minDays;
      } else {
        throw new ArgumentError(`天數格式錯誤，請使用數字（如 7）或範圍（如 7-9），收到：${daysStr}`);
      }
    }

    const limit = clampLimit(kwargs.limit, 20);
    const simType = String(kwargs.sim_type ?? 'all');
    const sortBy = String(kwargs.sort ?? 'cp');
    const noRealName = Boolean(kwargs.no_real_name);

    // 多撈一些讓過濾後還夠
    const fetchSize = Math.min(limit * 3, 50);
    const products = await fetchSimCards(country, fetchSize, minDays);

    if (!products.length) {
      throw new EmptyResultError(
        'trip sim-rank',
        `找不到 ${country} 的 SIM 卡方案，請確認國家名稱（英文）是否正確`,
      );
    }

    // 解析每個產品
    const parsed = products.map((p) => {
      const name = p.basicInfo?.name ?? '';
      const isEsim = parseIsEsim(name);
      const planType = parsePlanType(name);
      // 優先從名稱解析天數，Day Pass 類方案不需要天數
      const daysFromName = parseDays(name);
      const remark = p.priceInfo?.minPriceRemarks?.[1] ?? '';
      // Fixed 方案名稱解析失敗時，嘗試從 minPriceRemarks 提取
      const days = daysFromName ?? (planType === 'Fixed' ? parseDaysFromRemark(remark) : null);
      // 每日流量：優先從名稱解析，名稱沒有時從 remark 備援
      const dailyGb = parseDailyGb(name) ?? parseDailyGbFromRemark(remark);
      const dailyGbIsFromRemark = dailyGb !== null && parseDailyGb(name) === null;
      const realNameReq = parseRealName(name);
      const price = p.priceInfo?.price ?? 0;
      const { cpScore, formula, isEstimate } = calcCpScore(dailyGb, price, days, planType, minDays);
      const url = p.basicInfo?.detailUrl?.URL ?? p.basicInfo?.detailUrl?.ONLINE ?? '';
      const cpDisplay = cpScore !== null
        ? ((isEstimate || dailyGbIsFromRemark) ? `~${cpScore}` : String(cpScore))
        : 'N/A';

      return {
        id: p.id,
        name: buildShortName(name),
        type: isEsim ? 'eSIM' : 'SIM card',
        plan: planType,
        days: days ?? '?',
        daily_gb: dailyGb !== null ? `${dailyGb}` : '彈性',
        min_price_usd: price,
        formula,
        cpDisplay,
        real_name_req: realNameReq ? 'Yes' : 'No',
        url,
        _isEsim: isEsim,
        _realName: realNameReq,
        _cpScore: cpScore,
      };
    });

    // 過濾
    let filtered = parsed.filter((item) => {
      if (simType === 'esim' && !item._isEsim) return false;
      if (simType === 'physical' && item._isEsim) return false;
      if (noRealName && item._realName) return false;
      // 天數範圍過濾：只有在方案天數已知且明確超出範圍時才排除
      // 天數未知（?）的方案保留，讓使用者自行確認
      if (minDays !== undefined && maxDays !== undefined) {
        const productDays = typeof item.days === 'number' ? item.days : null;
        if (productDays !== null && (productDays < minDays || productDays > maxDays)) return false;
      }
      return true;
    });

    // 排序
    if (sortBy === 'cp') {
      filtered.sort((a, b) => {
        // 有 CP 值的排前面，沒有的排後面
        if (a._cpScore === null && b._cpScore === null) return 0;
        if (a._cpScore === null) return 1;
        if (b._cpScore === null) return -1;
        return (b._cpScore ?? 0) - (a._cpScore ?? 0);
      });
    } else if (sortBy === 'price') {
      filtered.sort((a, b) => a.min_price_usd - b.min_price_usd);
    } else if (sortBy === 'name') {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    }

    const result = filtered.slice(0, limit).map((item, index) => ({
      rank: index + 1,
      name: item.name,
      type: item.type,
      plan: item.plan,
      days: item.days,
      daily_gb: item.daily_gb,
      min_price_usd: item.min_price_usd,
      formula: item.formula,
      cp_score: item.cpDisplay,
      real_name_req: item.real_name_req,
      url: item.url,
    }));

    if (!result.length) {
      throw new EmptyResultError(
        'trip sim-rank',
        `篩選後沒有符合條件的 ${country} SIM 卡方案，請調整 --sim-type 或 --no-real-name 參數`,
      );
    }

    return result;
  },

  footerExtra: (kwargs) => {
    const country = kwargs.country ?? 'Vietnam';
    const sort = kwargs.sort ?? 'cp';
    const daysRaw = kwargs.days ? String(kwargs.days) : '';
    const sortLabel = sort === 'cp' ? 'CP 值（越高越划算）' : sort === 'price' ? '價格低→高' : '名稱';
    const daysLabel = daysRaw ? `／天數：${daysRaw}天` : '';
    return `資料來源：trip.com ／ 國家：${country}${daysLabel} ／ 排序：${sortLabel}`;
  },
});

export const __test__ = {
  parseDays,
  parseDaysFromRemark,
  parseDailyGb,
  parsePlanType,
  parseIsEsim,
  parseRealName,
  calcCpScore,
  buildShortName,
};
