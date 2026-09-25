import { sameOrigin } from '@/lib/server/storage';
import { marketStream } from '@/lib/server/polymarket-market-stream';
import { getTennisCatalog } from '@/lib/tennis/data';
import { readTennisSession } from '@/lib/tennis/server';
import { selectTennisStreamMarkets } from '@/lib/trading/stream-types';
import type { TennisMarket } from '@/lib/tennis/types';

/** Authenticated Site boundary; upstream is market data only and cannot submit orders. */
export async function GET(req: Request) {
  try {
    sameOrigin(req);
    // This reuses the same authenticated owner and persisted ledger as the paper API.
    const { session } = await readTennisSession(req);
    const slug = new URL(req.url).searchParams.get('slug');
    const protectedMarkets = session.positions.filter(position => position.status === 'open').map(position => position.market);
    if (session.pending?.market) protectedMarkets.push(session.pending.market);
    let markets: TennisMarket[];
    try {
      markets = (await getTennisCatalog()).markets;
    } catch {
      // Existing positions must remain observable when discovery is unavailable.
      markets = [];
    }
    if (slug === null) markets = markets.filter(market => session.config.leagues.includes(market.league));
    const selected = selectTennisStreamMarkets(markets, protectedMarkets, slug);
    if (!selected.ok) return Response.json({ error: selected.error }, { status: selected.status });
    // The existing adapter preserves source timestamps, generation invalidation,
    // heartbeat checks and the validated D1 book cache. No private account channel.
    return await marketStream(req, selected.selections);
  } catch {
    return Response.json({ error: 'The tennis live connection is unavailable. Paper checks will retry available market data.' }, { status: 503 });
  }
}
