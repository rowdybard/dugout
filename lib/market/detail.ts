import type {Book, Point} from './types.ts';

export type DetailRange = '15m' | '1h' | '6h' | '24h' | 'ALL';
export type DetailSection = 'quote' | 'book' | 'history' | 'rules' | 'activity';

export type DetailQuote = {
  bid: number | null;
  ask: number | null;
  volume: number | null;
  state: string | null;
  depth: number | null;
  source: 'order-book' | 'summary-quote';
};

export type MarketDetailData = {
  slug: string;
  range: DetailRange;
  quote: DetailQuote | null;
  book: Book | null;
  history: Point[];
  activity: {time: number; volume: number}[];
  question: string | null;
  rules: string | null;
  warnings: Partial<Record<DetailSection, string>>;
  retrievedAt: number;
  replayAt?: number;
};
