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
 * 解析方案類型標籤
 * Day Pass → 彈性按日計費（價格即每日費用）
 * Total Data → 彈性總量計費
 * 兩者都有 → 兩種都支援
 */
function parsePlanType(name: string): string {
  const hasDayPass = /day\s*pass/i.test(name);
  const hasTotal = /total\s*(data)?\s*(package)?/i.test(name);
  if (hasDayPass && hasTotal) return 'Day Pass / Total';
  if (hasDayPass) return 'Day Pass';
  if (hasTotal) return 'Total Data';
  return 'Fixed';
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
 * - 有 userDays：按用戶指定的 N 天計算
 * - 無 userDays：按產品的「最低天數」計算（因為起售价是對應最短天數的最低流量）
 *
 * CP 公式：
 * - 有明確 GB/日：CP = GB/日 ÷ 每日費用
 * - 無明確 GB/日（Day Pass）：以 0.5GB 估算
 *
 * 回傳：{ cpScore: number | null, formula: string }
 */
function calcCpScore(
  dailyGb: number | null,
  price: number,
  productMinDays: number | null,
  planType: string,
  userDays?: number,
): { cpScore: number | null; formula: string } {
  if (price <= 0) return { cpScore: null, formula: 'N/A' };

  // 如果有指定天數，使用指定天數；否則用產品最低天數（起售价對應的天數）
  const calcDays = userDays ?? productMinDays ?? 1;
  const pricePerDay = price / calcDays;
  if (pricePerDay <= 0) return { cpScore: null, formula: 'N/A' };

  if (dailyGb !== null) {
    const cp = parseFloat((dailyGb / pricePerDay).toFixed(3));
    const formula = `${dailyGb}GB ÷ $${pricePerDay.toFixed(2)}/天 = ${cp}`;
    return { cpScore: cp, formula };
  }

  if (planType.includes('Day Pass')) {
    const estimatedGb = 0.5;
    const cp = parseFloat((estimatedGb / pricePerDay).toFixed(3));
    const formula = `~${estimatedGb}GB ÷ $${pricePerDay.toFixed(2)}/天 ≈ ${cp}`;
    return { cpScore: cp, formula };
  }

  return { cpScore: null, formula: 'N/A' };
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
      type: 'int',
      positional: false,
      help: '查詢天數（1-30天），按天數過濾並計算該天數下的 CP 值',
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

    const userDays = typeof kwargs.days === 'number' ? kwargs.days : undefined;
    const limit = clampLimit(kwargs.limit, 20);
    const simType = String(kwargs.sim_type ?? 'all');
    const sortBy = String(kwargs.sort ?? 'cp');
    const noRealName = Boolean(kwargs.no_real_name);

    // 多撈一些讓過濾後還夠
    const fetchSize = Math.min(limit * 3, 50);
    const products = await fetchSimCards(country, fetchSize, userDays);

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
      const days = parseDays(name);
      const dailyGb = parseDailyGb(name);
      const planType = parsePlanType(name);
      const realNameReq = parseRealName(name);
      const price = p.priceInfo?.price ?? 0;
      const { cpScore, formula } = calcCpScore(dailyGb, price, days, planType, userDays);
      const url = p.basicInfo?.detailUrl?.URL ?? p.basicInfo?.detailUrl?.ONLINE ?? '';
      const cpDisplay = cpScore !== null
        ? (dailyGb === null ? `~${cpScore}` : String(cpScore))
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
    const userDays = kwargs.days;
    const sortLabel = sort === 'cp' ? 'CP 值（越高越划算）' : sort === 'price' ? '價格低→高' : '名稱';
    const daysLabel = userDays ? `／天數：${userDays}天` : '';
    return `資料來源：trip.com ／ 國家：${country}${daysLabel} ／ 排序：${sortLabel}`;
  },
});

export const __test__ = {
  parseDays,
  parseDailyGb,
  parsePlanType,
  parseIsEsim,
  parseRealName,
  calcCpScore,
  buildShortName,
};
