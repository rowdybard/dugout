import {db} from '@/lib/server/storage';
import {replayData} from '@/lib/server/replay';
import {bbo, book, history, amount, metadata, numeric} from '@/lib/server/polymarket';
import {loadMarketDetail} from '@/lib/server/market-detail';
import type {DetailRange} from '@/lib/market/detail';
import { recordTradingObservation } from '@/lib/server/trading';

const ranges = new Set<DetailRange>(['15m', '1h', '6h', '24h', 'ALL']);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  const range = (url.searchParams.get('range') || '1h') as DetailRange;
  if (!slug || !/^[a-zA-Z0-9_.-]+$/.test(slug) || !ranges.has(range)) {
    return Response.json({error: 'Choose a valid market and time range.'}, {status: 400});
  }

  const data = await loadMarketDetail(slug, range, {
    quote: async () => {
      const quote = await bbo(slug);
      if (!quote) return null;
      const buyerQuantity = numeric(quote.bidShares);
      const sellerQuantity = numeric(quote.askShares);
      return {
        bid: amount(quote.bestBid),
        ask: amount(quote.bestAsk),
        volume: numeric(quote.sharesTraded),
        state: typeof quote.state === 'string' ? quote.state : null,
        depth: buyerQuantity !== null && sellerQuantity !== null
          ? buyerQuantity + sellerQuantity
          : null,
      };
    },
    book: () => book(slug),
    history: () => history(slug, range),
    metadata: async () => {
      const market = await metadata(slug);
      const min=numeric(market.minimumTradeQty), tick=numeric(market.orderPriceMinTickSize);
      return {
        question: typeof market.question === 'string' ? market.question : null,
        rules: typeof market.description === 'string' ? market.description : null,
        executionRules: {minimumTradeQty:min!==null&&min>0?min:1,quantityIncrement:min!==null&&min>0?min:1,
          priceIncrement:tick!==null&&tick>0&&tick<1?tick:.01,feeCoefficient:numeric(market.feeCoefficient)??.0695},
      };
    },
    activity: async () => {
      const samples = await db().prepare(
        'SELECT time,volume FROM snapshots WHERE slug=? AND time>? AND volume IS NOT NULL ORDER BY time',
      ).bind(slug, Date.now() - 3600000).all<{time: number; volume: number}>();
      return samples.results;
    },
    replayAt: async () => (await replayData())?.recordedAt,
  });

  if(data.book) {
    try {await recordTradingObservation(slug,data.book,data.replayAt?'REPLAY':'REST',data.bookReceivedAt??data.retrievedAt);} catch { /* Chart snapshots must not hide a current quote. */ }
  }
  return Response.json(data, {headers: {'Cache-Control': 'no-store'}});
}
