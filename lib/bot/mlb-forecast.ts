import type { SportsContext } from '../sports-context/types';

/** Internal artifact contract for this outcome-only research baseline. */
export type MlbEloModel = {
  schemaVersion: number;
  modelId: string;
  modelVersion: string;
  status: string;
  league: string;
  marketFamily: string;
  phase: string;
  generatedAt: string;
  ratingsThroughDay: string;
  dataCutoffExclusive: string;
  parameters: { k: number; homeAdvantage: number; seasonCarry: number; initialRating: number; probabilityScale: number };
  teamRatings: Record<string, { id: string; name: string; rating: number }>;
};
export type MlbForecastRequest = {
  now: number;
  /** Verified MLB team ID, mapped explicitly to the market's YES team upstream. */
  yesTeamId: string;
  marketFamily: 'FULL_GAME_WINNER';
  maxContextAgeMs?: number;
  maxRatingsAgeDays?: number;
};
export type MlbForecastResult = {
  status: 'unavailable'; reason: string;
} | {
  status: 'available';
  modelId: string; modelVersion: string; gameId: string;
  homeTeamId: string; awayTeamId: string; yesTeamId: string;
  homeProbability: number; yesProbability: number;
  homeRating: number; awayRating: number;
  ratingsThroughDay: string; sportsReceivedAt: number; generatedAt: number;
  purpose: 'EXPERIMENTAL_PAPER_FORECAST';
  playerImpactModeled: false;
  marketValueEstablished: false;
  missingFeatures: string[];
};
const DAY = 86_400_000;
const day = (time: number) => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
const dayTime = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;

export function mlbHomeProbability(homeRating: number, awayRating: number, homeAdvantage: number, scale = 400): number {
  return 1 / (1 + 10 ** (-(homeRating - awayRating + homeAdvantage) / scale));
}

/** Pure forecast: no source fetching, no mutations, no assumed player effect, no orders. */
export function forecastMlbPregame(model: MlbEloModel, context: SportsContext, request: MlbForecastRequest): MlbForecastResult {
  const no = (reason: string): MlbForecastResult => ({status:'unavailable',reason});
  const maxContextAge = request.maxContextAgeMs ?? 90_000, maxRatingsAge = request.maxRatingsAgeDays ?? 3;
  if (!Number.isFinite(request.now) || !Number.isFinite(maxContextAge) || maxContextAge <= 0 || !Number.isFinite(maxRatingsAge) || maxRatingsAge <= 0) return no('Invalid forecast clock or freshness policy.');
  if (model.schemaVersion !== 1 || model.status !== 'EXPERIMENTAL_PAPER_ONLY' || model.league !== 'MLB' || model.phase !== 'PREGAME'
    || model.marketFamily !== 'FULL_GAME_WINNER' || request.marketFamily !== 'FULL_GAME_WINNER') return no('Unsupported model version, league, phase or market family.');
  if (context.league !== 'MLB' || context.status !== 'available' || !context.game || context.game.state !== 'pregame') return no('A matched MLB pregame context is required.');
  if (context.source.support !== 'official') return no('Verified official MLB source identity is required.');
  try { if (new URL(context.source.url).hostname !== 'statsapi.mlb.com') return no('The source does not use MLB Stats API team identities.'); }
  catch { return no('The MLB source URL is invalid.'); }
  if (context.replayAt !== undefined || !Number.isFinite(context.receivedAt) || context.receivedAt > request.now || request.now-context.receivedAt>maxContextAge) return no('Sports context is recorded, stale or future-dated.');
  const start=Date.parse(context.game.start), generated=Date.parse(model.generatedAt);
  if (!Number.isFinite(start) || start <= request.now || !Number.isFinite(generated) || generated>request.now) return no('The scheduled start or model build timestamp is invalid for this pregame forecast.');
  const through=dayTime(model.ratingsThroughDay), cutoff=dayTime(model.dataCutoffExclusive), gameDay=dayTime(day(start));
  const currentDay=dayTime(day(request.now));
  if (![through,cutoff,gameDay,currentDay].every(Number.isFinite) || through>=gameDay || cutoff>gameDay || through>=currentDay || cutoff<=through) return no('Ratings include this game date or have an invalid prior-day cutoff.');
  if (currentDay-through>maxRatingsAge*DAY || gameDay-through>maxRatingsAge*DAY) return no('Team ratings are too old for the configured forecast window.');
  const {home,away}=context.game;
  if (!/^\d+$/.test(context.game.id) || !/^\d+$/.test(home.id) || !/^\d+$/.test(away.id) || home.id===away.id
    || (request.yesTeamId!==home.id && request.yesTeamId!==away.id)) return no('The YES outcome must explicitly map to one of the two verified MLB team IDs.');
  const h=model.teamRatings[home.id], a=model.teamRatings[away.id], params=model.parameters;
  if (!h || !a || h.id!==home.id || a.id!==away.id || ![h.rating,a.rating,params.homeAdvantage,params.probabilityScale].every(Number.isFinite)
    || params.probabilityScale!==400) return no('One or both MLB teams lack valid model ratings. No neutral rating is invented.');
  const p=mlbHomeProbability(h.rating,a.rating,params.homeAdvantage,params.probabilityScale);
  if (!Number.isFinite(p) || p<=0 || p>=1) return no('The model produced an invalid probability.');
  return {
    status:'available',modelId:model.modelId,modelVersion:model.modelVersion,gameId:context.game.id,
    homeTeamId:home.id,awayTeamId:away.id,yesTeamId:request.yesTeamId,
    homeProbability:p,yesProbability:request.yesTeamId===home.id?p:1-p,homeRating:h.rating,awayRating:a.rating,
    ratingsThroughDay:model.ratingsThroughDay,sportsReceivedAt:context.receivedAt,generatedAt:request.now,
    purpose:'EXPERIMENTAL_PAPER_FORECAST',playerImpactModeled:false,marketValueEstablished:false,
    missingFeatures:['Starting pitchers','Lineups and player availability','Bullpen workload','Injuries and replacements','Weather and park effects','Current market calibration'],
  };
}
