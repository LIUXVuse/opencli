/**
 * opencli API — Cloudflare Worker
 *
 * 端點：
 *   GET /api/forex          → 今日所有匯率（每天快取一次）
 *   GET /api/sim-rank       → SIM 卡 CP 值排名
 *     ?country=Vietnam      → 國家（預設 Vietnam）
 *     ?days=7               → 天數（可用範圍 7-9）
 *     ?sim_type=esim        → esim / physical / all（預設 all）
 *     ?no_real_name=true    → 過濾需要實名制的方案
 *     ?limit=10             → 回傳筆數（預設 10，最多 20）
 */

import { fetchAllRates } from './lib/forex';
import { fetchAndRankSimCards } from './lib/sim-rank';

// Cloudflare Workers 環境型別
export interface Env {
  RATE_CACHE: KVNamespace; // Cloudflare KV，存每日匯率快取
}

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function error(message: string, status = 500): Response {
  return json({ error: message }, status);
}

// ── 匯率快取（一天一次）──────────────────────────────────────────────────────

// KV key 格式：forex-2026-04-04（台北時間日期）
function todayKey(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `forex-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getForexRates(kv: KVNamespace) {
  const key = todayKey();

  // 先查快取
  const cached = await kv.get(key, 'json');
  if (cached) return { ...cached as object, cached: true };

  // 快取沒有，即時抓取
  const rates = await fetchAllRates();

  // 存入 KV，TTL 設 26 小時（確保跨日時舊 key 自動清除）
  await kv.put(key, JSON.stringify(rates), { expirationTtl: 26 * 60 * 60 });

  return { ...rates, cached: false };
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 處理 CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/forex
    if (path === '/api/forex') {
      try {
        const rates = await getForexRates(env.RATE_CACHE);
        return json(rates);
      } catch (e) {
        return error(`匯率抓取失敗：${(e as Error).message}`);
      }
    }

    // GET /api/sim-rank
    if (path === '/api/sim-rank') {
      try {
        const country = url.searchParams.get('country') ?? 'Vietnam';
        const daysParam = url.searchParams.get('days');
        const simType = (url.searchParams.get('sim_type') ?? 'all') as 'all' | 'esim' | 'physical';
        const noRealName = url.searchParams.get('no_real_name') === 'true';
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10'), 20);

        let minDays: number | undefined;
        let maxDays: number | undefined;
        if (daysParam) {
          const rangeMatch = daysParam.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          const singleMatch = daysParam.match(/^(\d+)$/);
          if (rangeMatch) {
            minDays = parseInt(rangeMatch[1]);
            maxDays = parseInt(rangeMatch[2]);
            if (minDays > maxDays) [minDays, maxDays] = [maxDays, minDays];
          } else if (singleMatch) {
            minDays = parseInt(singleMatch[1]);
            maxDays = minDays;
          }
        }

        // 自動降級：先試 3GB，沒結果降 1GB，再沒結果全開（同一批資料，不重複打 API）
        const fallbacks = [3, 1, 0];
        let plans = await fetchAndRankSimCards({ country, minDays, maxDays, simType, noRealName, limit: 50, minDailyGb: 0 });
        let actualMinGb = 0;
        for (const threshold of fallbacks) {
          const filtered = plans.filter(p => {
            const gb = parseFloat(p.daily_gb);
            return isNaN(gb) || gb >= threshold;
          });
          if (filtered.length > 0 || threshold === 0) {
            plans = filtered.slice(0, limit).map((p, i) => ({ ...p, rank: i + 1 }));
            actualMinGb = threshold;
            break;
          }
        }
        return json({ country, days: daysParam ?? null, total: plans.length, plans });
      } catch (e) {
        return error(`SIM 卡查詢失敗：${(e as Error).message}`);
      }
    }

    // 首頁說明
    if (path === '/' || path === '/api') {
      return json({
        name: 'opencli API',
        version: '1.0.0',
        endpoints: {
          'GET /api/forex': '今日匯率（每日快取）',
          'GET /api/sim-rank': 'SIM 卡 CP 值排名',
        },
        examples: {
          forex: '/api/forex',
          simRankVietnam: '/api/sim-rank?country=Vietnam&days=7&sim_type=esim&no_real_name=true',
          simRankJapan: '/api/sim-rank?country=Japan&days=7-9',
        },
      });
    }

    return error('找不到此端點', 404);
  },
};
