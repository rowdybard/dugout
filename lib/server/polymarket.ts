import { replayData } from "./replay";
import { PolymarketUS } from "polymarket-us";
import { cached, db } from "./storage";
import type { Book, Point } from "@/lib/market/types";
export const sdk = new PolymarketUS({ timeout: 12000 });
export const BASE = "https://gateway.polymarket.us";
export type Raw = Record<string, any>;
export function numeric(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
export const amount = (x: any) => numeric(x?.value);
export async function publicGet(path: string): Promise<Raw> {
  const replay = await replayData();
  if (replay) {
    const url = new URL(path, BASE);
    const league = url.pathname.match(
      /^\/v2\/leagues\/(mlb|nfl)\/events$/,
    )?.[1];
    if (league) {
      if (Number(url.searchParams.get("offset")) > 0) return { events: [] };
      const data = replay.leagues[league];
      return {
        ...data,
        events: data.events.filter((e: Raw) =>
          e.markets.some((m: Raw) => !replay.markets[m.slug]?.error),
        ),
      };
    }
    if (url.pathname === "/v1/price-history") {
      return (
        replay.markets[url.searchParams.get("symbol") || ""]?.history?.[
          url.searchParams.get("fixedInterval") || ""
        ] || { history: [] }
      );
    }
  }
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(18000) });
  if (!r.ok) throw new Error(`Polymarket US returned ${r.status}.`);
  return r.json();
}
export const getLeaguePage = (league: string, offset: number) =>
  cached(`league-compact:${league}:${offset}`, 120000, async () => {
    const raw = await publicGet(
      `/v2/leagues/${league}/events?type=sport&limit=4&offset=${offset}`,
    );
    return {
      events: (raw.events || []).map((e: Raw) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        startTime: e.startTime,
        eventDate: e.eventDate,
        closed: e.closed,
        ended: e.ended,
        active: e.active,
        teams: (e.teams || []).map((t: Raw) => ({
          id: t.id,
          name: t.name,
          abbreviation: t.abbreviation,
          displayAbbreviation: t.displayAbbreviation,
          record: t.record,
        })),
        markets: (e.markets || []).map((m: Raw) => ({
          id: m.id,
          slug: m.slug,
          title: m.title,
          question: m.question,
          active: m.active,
          closed: m.closed,
          hidden: m.hidden,
          sportsMarketType: m.sportsMarketType,
          bestBidQuote: m.bestBidQuote,
          bestAskQuote: m.bestAskQuote,
          feeCoefficient: m.feeCoefficient,
          volume: m.volume,
          marketSides: (m.marketSides || []).map((s: Raw) => ({
            long: s.long,
            description: s.description,
          })),
        })),
      })),
    };
  });
export async function history(slug: string, range = "1h"): Promise<Point[]> {
  const profiles: Record<string, [string, number]> = {
    "15m": ["INTERVAL_1H", 1],
    "1h": ["INTERVAL_1H", 1],
    "6h": ["INTERVAL_6H", 1],
    "24h": ["INTERVAL_1D", 5],
    ALL: ["INTERVAL_ALL", 180],
  };
  const [fixedInterval, fidelity] = profiles[range] || profiles["1h"];
  const points = await cached(
    `history:${slug}:${fixedInterval}`,
    60000,
    async () => {
      const data = await publicGet(
        `/v1/price-history?${new URLSearchParams({ symbol: slug, fixedInterval, fidelity: String(fidelity) })}`,
      );
      return (data.history || [])
        .map((p: Raw) => ({
          time: Number(p.timestamp) * 1000,
          price: numeric(p.longPrice),
          spread:
            numeric(p.shortPrice) === null || numeric(p.longPrice) === null
              ? null
              : numeric(p.shortPrice)! + numeric(p.longPrice)! - 1,
        }))
        .filter(
          (p: Point) =>
            p.price !== null &&
            p.price >= 0 &&
            p.price <= 1 &&
            Number.isFinite(p.time),
        )
        .sort((a: Point, b: Point) => a.time - b.time) as Point[];
    },
  ).catch(() => [] as Point[]);
  const windows: Record<string, number> = {
    "15m": 900000,
    "1h": 3600000,
    "6h": 21600000,
    "24h": 86400000,
    ALL: 30 * 86400000,
  };
  const local =
    points.length < 2
      ? await db()
          .prepare(
            "SELECT time,price,(ask-bid) AS spread,volume FROM snapshots WHERE slug=? AND time>? AND price IS NOT NULL ORDER BY time",
          )
          .bind(slug, Date.now() - (windows[range] || 3600000))
          .all<Point>()
      : null;
  const basePoints = points.length >= 2 ? points : local?.results || points;
  const cutoff=Math.max(basePoints.at(-1)?.time??0,Date.now()-(windows[range]||3600000));
  const ticks=await db().prepare("SELECT time,ask AS price,(ask-bid) AS spread FROM trading_observations WHERE slug=? AND time>? AND ask IS NOT NULL AND source!='REPLAY' ORDER BY time LIMIT 5000")
    .bind(slug,cutoff).all<Point>().catch(()=>({results:[] as Point[]}));
  const result=[...basePoints,...ticks.results];
  return range === "15m"
    ? result.filter((p) => p.time >= Date.now() - 900000)
    : result;
}
export async function bbo(slug: string) {
  return cached(`bbo:${slug}`, 20000, async () => {
    const replay = await replayData();
    const r = (replay
      ? replay.markets[slug]?.bbo
      : await sdk.markets.bbo(slug)) as unknown as Raw;
    if (!r) throw new Error("Recorded quote unavailable.");
    return r.marketData;
  });
}
export async function book(slug: string): Promise<Book> {
  const replay = await replayData();
  const r = (replay
    ? replay.markets[slug]?.book
    : await sdk.markets.book(slug)) as unknown as Raw;
  if (!r) throw new Error("Recorded book unavailable.");
  const b = r.marketData;
  if (!b) throw new Error("Order book is unavailable.");
  const levels = (a: Raw[]) =>
    a
      ?.map((l) => ({ price: amount(l.px)!, quantity: numeric(l.qty)! }))
      .filter((l) => l.price !== null && l.quantity > 0) || [];
  return {
    bids: levels(b.bids).sort((a,b)=>b.price-a.price),
    asks: levels(b.offers).sort((a,b)=>a.price-b.price),
    state: b.state,
    time: b.transactTime,
  };
}
export async function settlement(slug: string) {
  if (await replayData()) return null;
  try {
    const r = (await sdk.markets.settlement(slug)) as unknown as Raw;
    return numeric(r.settlement);
  } catch {
    return null;
  }
}
export async function metadata(slug: string) {
  const replay = await replayData();
  if (replay) {
    for (const l of Object.values(replay.leagues) as Raw[])
      for (const e of l.events)
        for (const m of e.markets) if (m.slug === slug) return m;
    throw new Error("Recorded market unavailable.");
  }
  const r = (await sdk.markets.retrieveBySlug(slug)) as unknown as Raw;
  return r.market ?? r;
}
