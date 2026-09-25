import type {Book, Point} from '../market/types';

export type SimulationEntry = {
  id: string;
  gameId: string;
  slug: string;
  game: string;
  start: string;
  outcome: string;
  side: 'YES' | 'NO';
  signal: 'PRICE MOVING' | 'PRICE DROPPING';
  reason: string;
  time: number;
  budget: number;
  contracts: number;
  cost: number;
  fee: number;
  amount: number;
  average: number;
  coefficient: number;
  movePoints: number;
  history: Point[];
  book: Book;
  entryLiquidation: number | null;
};

export type SimulationRun = {
  id: string;
  date: string;
  timezone: string;
  startedAt: number;
  completedAt: number;
  bankroll: number;
  maxBudget: number;
  maxPositions: number;
  rule: string;
  source: string;
  coverage: {
    eventsFetched: number;
    todayGames: number;
    eligibleGames: number;
    capReached: boolean;
    errors: string[];
  };
  entries: SimulationEntry[];
  skipped: {game: string; slug?: string; reason: string}[];
  cash: number;
  fees: number;
  spent: number;
};

export type SimulationObservation = {
  checkedAt: number;
  settlement: number | null;
  settledAt: number | null;
  mark: number | null;
  markedAt: number | null;
  error: string | null;
};

export type SimulationPosition = SimulationEntry & {
  status: 'pending' | 'settled';
  checkedAt: number;
  settlement: number | null;
  payout: number | null;
  currentValue: number | null;
  valueAsOf: number | null;
  pnl: number | null;
  quoteError: string | null;
};

export type SimulationView = {
  run: SimulationRun;
  positions: SimulationPosition[];
  summary: {
    cash: number;
    value: number | null;
    pnl: number | null;
    settled: number;
    pending: number;
    missingMarks: number;
    realizedPnl: number;
  };
  checkedAt: number;
  warning: string | null;
};
