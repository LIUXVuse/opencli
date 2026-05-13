/**
 * 機場接送查詢 — 從 Trip.com CityPass tab 抓取
 */

export interface TransferOption {
  name: string;
  price_usd: number;
  url: string;
}

export async function fetchAirportTransfers(city: string): Promise<TransferOption[]> {
  const keyword = `${city} airport transfer`;

  const res = await fetch('https://www.trip.com/restapi/soa2/20684/json/productSearch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      client: { currency: 'USD', locale: 'en-XX', platformId: 24, channel: 118 },
      filtered: { items: [], pageIndex: 1, pageSize: 20, sort: '1', tab: 'CityPass' },
      destination: { keyword },
      requestSource: 'activity',
      productOption: { needBasicInfo: true, needPrice: true },
      head: { Locale: 'en-XX', Currency: 'USD' },
    }),
  });

  if (!res.ok) throw new Error(`Trip.com HTTP ${res.status}`);

  const payload = await res.json() as {
    ResponseStatus: { Ack: string };
    products?: Array<{
      basicInfo: { name: string; detailUrl?: { URL?: string; ONLINE?: string } };
      priceInfo: { price: number };
    }>;
  };

  if (payload.ResponseStatus?.Ack !== 'Success') throw new Error('Trip.com API error');

  const products = payload.products ?? [];

  // 只保留名稱含 transfer / shuttle / taxi / pickup 的結果
  const relevant = products.filter(p => {
    const n = p.basicInfo?.name?.toLowerCase() ?? '';
    return /transfer|shuttle|taxi|pickup|pick.?up|airport/.test(n);
  });

  return relevant.slice(0, 5).map(p => ({
    name: p.basicInfo.name.substring(0, 60),
    price_usd: p.priceInfo.price,
    url: p.basicInfo.detailUrl?.URL ?? p.basicInfo.detailUrl?.ONLINE ?? '',
  }));
}
