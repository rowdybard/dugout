import type { League } from '../market/types';

export type ContextPlayer = { id: string; name: string };
export type ContextTeam = { id: string; name: string; abbreviation: string; score: number | null };
export type ContextGame = {
  id: string;
  start: string;
  state: 'pregame' | 'live' | 'final' | 'unknown';
  statusText: string;
  away: ContextTeam;
  home: ContextTeam;
  period?: string;
  clock?: string;
};
export type ContextChange = {
  id: string;
  type: 'pitcher_change' | 'QB_change';
  team: string;
  previous: ContextPlayer;
  replacement: ContextPlayer;
  sourceEventTime: string | null;
  detectedAt: number;
  description: string;
  implications: string[];
};
export type SportsContext = {
  slug: string;
  league: League;
  status: 'available' | 'unmatched' | 'unavailable';
  receivedAt: number;
  /** Development-only actual provider capture; never current data. */
  replayAt?: number;
  source: { name: string; url: string; support: 'official' | 'public-undocumented' };
  game: ContextGame | null;
  players: (ContextPlayer & {
    team: string;
    role: 'current_pitcher' | 'probable_pitcher' | 'last_observed_passer';
    stats: { label: string; value: string }[];
    observedAt?: string;
  })[];
  changes: ContextChange[];
  limitations: string[];
  injuryStatus: 'source_reports' | 'not_verified';
  injuryReceivedAt?: number;
  winEstimate?: {provider:'ESPN';gameId:string;playId:string;playTime:number;receivedAt:number;homeProbability:number;awayProbability:number;tieProbability:number;sourceUrl:string};
  winEstimateReason?: string;
  sourceFailure?: import('./source-reader').SportsSourceFailure;
  injuries?: { name: string; team: string; position: string; status: string; detail: string; reportedAt: string | null; sourceUrl: string }[];
};

/** Compact provider game data; provider IDs are never treated as Polymarket IDs. */
export type ScheduleGame = ContextGame & { sourceUrl: string };
