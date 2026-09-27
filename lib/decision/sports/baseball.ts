import type {DecisionContext} from '../context.ts';
import type {Feature} from '../features.ts';

/**
 * Baseball module: live MLB game-state features (docs/STRATEGY-ARCHITECTURE.md). The facts come from the provider's
 * eventState, verified Sep 27, 2026 against the official MLB Stats API (lib/tennis/types.ts BaseballContext), and
 * reach ctx.game.extra only from a fresh, complete report (lib/tennis/engine-plan.ts). Otherwise every feature is
 * unknown, and an unknown condition never permits a trade.
 *
 * No MLB strategy is registered: Dugout's MLB studies found the market at least as accurate as its model, live
 * sides under 20¢ losing, and prices priced before the free feed arrives (research/studies/report.md). These
 * features exist so evidence rows and calibration tables can condition on the base-out state, and so a future
 * spec can be written against them.
 */

const extra=(ctx:DecisionContext)=>ctx.market.sport==='MLB'?ctx.game?.extra??{}:{};
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
const bool=(value:unknown)=>typeof value==='boolean'?value:undefined;

export const BASEBALL_FEATURES:Record<string,Feature>={
  /** Inning number (extra innings continue past 9). */
  inning:ctx=>ctx.market.sport==='MLB'?num(ctx.game?.period):undefined,
  /** 'top', 'bottom', 'middle' or 'end' (between halves). */
  'baseball.half':ctx=>{const half=extra(ctx).half;return typeof half==='string'?half:undefined;},
  outs:ctx=>num(extra(ctx).outs),
  balls:ctx=>num(extra(ctx).balls),
  strikes:ctx=>num(extra(ctx).strikes),
  /** Is this side batting? Unknown between halves. */
  'baseball.batting':(ctx,side)=>{const batting=extra(ctx).battingSide;return batting==='yes'||batting==='no'?batting===side:undefined;},
  runnersOn:ctx=>{const e=extra(ctx),bases=[bool(e.onFirst),bool(e.onSecond),bool(e.onThird)];return bases.some(b=>b===undefined)?undefined:bases.filter(Boolean).length;},
  runnerInScoringPosition:ctx=>{const e=extra(ctx),second=bool(e.onSecond),third=bool(e.onThird);return second===undefined||third===undefined?undefined:second||third;},
  /** The standard base-out state, e.g. "1-3|2" (runners on first and third, two out) or "---|0". */
  baseOutState:ctx=>{
    const e=extra(ctx),bases=[bool(e.onFirst),bool(e.onSecond),bool(e.onThird)],outs=num(e.outs);
    if(bases.some(b=>b===undefined)||outs===undefined||(e.half!=='top'&&e.half!=='bottom'))return undefined;
    return `${bases.map((b,i)=>b?String(i+1):'-').join('')}|${outs}`;
  },
};
