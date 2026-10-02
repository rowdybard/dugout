import type {TennisConfig} from './types';

/**
 * The two ways the bot trades, as the dashboard offers them.
 *   Steady: resting (maker) orders only, small: about 5% of the balance per order ($5 on $100).
 *   Bold:   bigger resting orders, plus the hold-to-final bets the evidence allows: bigger wins and bigger losses.
 * Bold's order size is 12% of the balance so both resting buys (YES and NO) fit the open-exposure cap of 25%
 * and its $100 ceiling (lib/tennis/engine-plan.ts), so it tops out at $50; a larger size would only ever rest one side.
 */
export type TradeMode='steady'|'bold';
const cents=(x:number)=>Math.floor(x*100+1e-9)/100;

export const steadySize=(startingCash:number)=>Math.round(Math.min(5,startingCash*.2)*1e6)/1e6;
export const boldSize=(startingCash:number)=>Math.max(steadySize(startingCash),Math.min(50,cents(startingCash*.12)));
export const modeOf=(config:Pick<TennisConfig,'entries'>):TradeMode=>config.entries==='steady'?'steady':'bold';

/** The rule change that switches mode. Bold is not Steady, so Chaos mode (Steady only) turns off. */
export function modeRules(config:Pick<TennisConfig,'startingCash'|'chaosSlugs'>,mode:TradeMode):Partial<TennisConfig> {
  return mode==='steady'?{entries:'steady',entryBudget:steadySize(config.startingCash)}
    :{entries:'all',entryBudget:boldSize(config.startingCash),...(config.chaosSlugs?.length?{chaosSlugs:[]}:{})};
}
