import type {Book, Point} from '../market/types.ts';
import type {DetailQuote, DetailRange, MarketDetailData} from '../market/detail.ts';

export type DetailSources = {
  quote: () => Promise<Omit<DetailQuote, 'source'> | null>;
  book: () => Promise<Book>;
  history: () => Promise<Point[]>;
  metadata: () => Promise<{question: string | null; rules: string | null; executionRules?: import('../market/detail.ts').MarketDetailData['executionRules']}>;
  activity: () => Promise<{time: number; volume: number}[]>;
  replayAt: () => Promise<number | undefined>;
};

/** Each section survives failures in other sources. No feed price is substituted. */
export async function loadMarketDetail(
  slug: string,
  range: DetailRange,
  sources: DetailSources,
): Promise<MarketDetailData> {
  let bookReceivedAt: number | undefined;
  const [quoteResult, bookResult, historyResult, metadataResult, activityResult, replayResult] =
    await Promise.allSettled([
      sources.quote(),
      sources.book().then(value=>{bookReceivedAt=Date.now();return value;}),
      sources.history(),
      sources.metadata(),
      sources.activity(),
      sources.replayAt(),
    ]);

  const warnings: MarketDetailData['warnings'] = {};
  const book = bookResult.status === 'fulfilled' ? bookResult.value : null;
  const summary = quoteResult.status === 'fulfilled' ? quoteResult.value : null;

  // A successfully retrieved book contains the actual offers used by the calculator.
  // Keep an empty side empty; an older summary must not fill a missing offer.
  const quote: DetailQuote | null = book
    ? {
        bid: book.bids.length ? Math.max(...book.bids.map(level => level.price)) : null,
        ask: book.asks.length ? Math.min(...book.asks.map(level => level.price)) : null,
        volume: summary?.volume ?? null,
        state: book.state || null,
        depth: [...book.bids, ...book.asks].reduce((sum, level) => sum + level.quantity, 0),
        source: 'order-book',
      }
    : summary
      ? {...summary, source: 'summary-quote'}
      : null;

  if (!quote) warnings.quote = 'Current buying and selling prices could not be loaded.';
  if (!book) warnings.book = 'Available offers could not be loaded. Practice picks need these prices.';

  const history = historyResult.status === 'fulfilled' ? historyResult.value : [];
  if (historyResult.status === 'rejected') {
    warnings.history = 'Price history is temporarily unavailable.';
  } else if (history.length < 2) {
    warnings.history = 'There are not enough recorded prices for this time range yet.';
  }

  const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
  if (!metadata?.rules) warnings.rules = 'Official settlement rules could not be loaded.';
  if (activityResult.status === 'rejected') {
    warnings.activity = 'Recent activity observations are temporarily unavailable.';
  }

  return {
    slug,
    range,
    quote,
    book,
    history,
    activity: activityResult.status === 'fulfilled' ? activityResult.value : [],
    question: metadata?.question ?? null,
    rules: metadata?.rules ?? null,
    executionRules: metadata?.executionRules,
    warnings,
    retrievedAt: Date.now(),
    bookReceivedAt,
    replayAt: replayResult.status === 'fulfilled' ? replayResult.value : undefined,
  };
}
