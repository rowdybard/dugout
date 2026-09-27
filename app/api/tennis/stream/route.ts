import { env } from 'cloudflare:workers';
import { readCached, sameOrigin } from '@/lib/server/storage';
import { streamOwnerIssue, type SiteOwnerBindings } from '@/lib/server/owner-access';
import { marketStream } from '@/lib/server/polymarket-market-stream';
import { getTennisCatalog } from '@/lib/tennis/data';
import { readTennisSession } from '@/lib/tennis/server';
import { selectTennisStreamMarkets } from '@/lib/trading/stream-types';
import type { TennisMarket } from '@/lib/tennis/types';

/** Authenticated Site boundary; upstream is market data only and cannot submit orders. */
export async function GET(req: Request) {
  try {
    sameOrigin(req);
    const denied = streamOwnerIssue(req, env as unknown as SiteOwnerBindings);
    if (denied) return denied;
    // This reuses the same authenticated owner and persisted ledger as the paper API.
    const { session } = await readTennisSession(req);
    const slug = new URL(req.url).searchParams.get('slug');
    const watch = new URL(req.url).searchParams.get('watch');
    if(watch!==null&&!/^[-a-zA-Z0-9]{1,200}$/.test(watch))return Response.json({error:'Choose a valid game market.'},{status:400});
    const protectedMarkets = session.positions.filter(position => position.status === 'open').map(position => position.market);
    if (session.pending?.market) protectedMarkets.push(session.pending.market);
    // Switching the chart must not wait behind a complete league discovery scan.
    // Only identities already verified by discovery or the saved account qualify.
    if(watch&&slug===null){
      const selectedSlugs=[...new Set([watch,session.config.focusSlug].filter((value):value is string=>!!value))];
      const cached=await Promise.all(selectedSlugs.map(value=>readCached<TennisMarket>(`tennis:verified:${value}`)));
      for(const row of cached)if(row&&selectedSlugs.includes(row.value.slug)&&session.config.leagues.includes(row.value.league))protectedMarkets.push(row.value);
      if(protectedMarkets.some(m=>m.slug===watch)){
        const selected=selectTennisStreamMarkets([],protectedMarkets,watch);
        if(selected.ok)return await marketStream(req,selected.selections);
      }
    }
    let markets: TennisMarket[];
    try {
      markets = (await getTennisCatalog({includeHistory:false,leagues:session.config.leagues,signal:req.signal})).markets;
    } catch {
      // Existing positions must remain observable when discovery is unavailable.
      markets = [];
    }
    if (slug === null) markets = markets.filter(market => session.config.leagues.includes(market.league));
    const focused = markets.find(market => market.slug === session.config.focusSlug && market.active && !market.ended);
    if (focused) protectedMarkets.push(focused);
    const watched = markets.find(market => market.slug === watch && market.active && !market.ended);
    if (watched) protectedMarkets.push(watched);
    const selected = selectTennisStreamMarkets(markets, protectedMarkets, slug);
    if (!selected.ok) return Response.json({ error: selected.error }, { status: selected.status });
    // The existing adapter preserves source timestamps, generation invalidation,
    // heartbeat checks and the validated D1 book cache. No private account channel.
    return await marketStream(req, selected.selections);
  } catch {
    return Response.json({ error: 'The live game connection is unavailable. Paper checks will retry available market data.' }, { status: 503 });
  }
}
