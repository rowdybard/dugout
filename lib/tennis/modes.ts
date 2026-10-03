import type {TennisConfig,TennisSession} from './types';

/**
 * The two ways the bot trades, as the dashboard offers them.
 *   Steady: resting (maker) orders only, small: about 5% of the balance per order ($5 on $100).
 *   Bold:   bigger resting orders, plus the hold-to-final bets the evidence allows: bigger wins and bigger losses.
 * Bold's order size is 12% of the balance so both resting buys (YES and NO) fit the open-exposure cap of 25%
 * and its $100 ceiling (lib/tennis/engine-plan.ts), so it tops out at $50; a larger size would only ever rest one side.
 */
export type TradeMode='steady'|'bold';
/** What the dashboard offers: the two modes, or Auto (the bot picks one of them on each check; lib/tennis/engine.ts decideAuto). */
export type ModeChoice=TradeMode|'auto';
const cents=(x:number)=>Math.floor(x*100+1e-9)/100;

export const steadySize=(startingCash:number)=>Math.round(Math.min(5,startingCash*.2)*1e6)/1e6;
export const boldSize=(startingCash:number)=>Math.max(steadySize(startingCash),Math.min(50,cents(startingCash*.12)));
export const modeOf=(config:Pick<TennisConfig,'entries'>):TradeMode=>config.entries==='steady'?'steady':'bold';

export const choiceOf=(config:Pick<TennisConfig,'entries'|'autoMode'>):ModeChoice=>config.autoMode?'auto':modeOf(config);

/** The mode the bot is trading in right now: the chosen one, or Auto's current pick (Steady until Auto has decided). */
export const tradeMode=(session:Pick<TennisSession,'config'|'autoMode'>):TradeMode=>
  session.config.autoMode?session.autoMode?.mode??'steady':modeOf(session.config);

/** The order size right now. Auto's config holds the Bold size; while Auto is in Steady, orders are Steady-sized. */
export const tradeBudget=(session:Pick<TennisSession,'config'|'autoMode'>):number=>
  session.config.autoMode&&tradeMode(session)==='steady'?Math.min(session.config.entryBudget,steadySize(session.config.startingCash)):session.config.entryBudget;

/**
 * The rule change that switches mode. The Octopus works in every mode, at that mode's order size.
 * Bold and Auto also paper-trade the unmeasured comeback-drive re-entry (lib/decision/strategies.ts) to measure it;
 * Steady never takes bets, so it drops it.
 */
export function modeRules(config:Pick<TennisConfig,'startingCash'|'evidenceGate'>,mode:ModeChoice):Partial<TennisConfig> {
  if(mode==='steady')return {entries:'steady',autoMode:false,explore:[],entryBudget:steadySize(config.startingCash)};
  return {entries:'all',autoMode:mode==='auto',entryBudget:boldSize(config.startingCash),
    ...(config.evidenceGate==='evidence-v1'?{explore:['comeback-drive' as const]}:{})};
}
