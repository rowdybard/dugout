import type {DecisionContext,SideKey} from '../context.ts';
import type {Feature} from '../features.ts';
import type {Strategy} from '../strategies.ts';

/**
 * Football module: live game-state features and football strategies. The facts come from a verified, fresh game
 * report (lib/tennis/engine-plan.ts puts them in ctx.game.extra); when the report is not fresh they are unknown,
 * and strategies that need them propose nothing.
 */

const extra=(ctx:DecisionContext)=>ctx.game?.extra??{};
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
const possession=(ctx:DecisionContext):SideKey|undefined=>{const value=extra(ctx).possession;return value==='yes'||value==='no'?value:undefined;};

/** NFL and college quarters are both 15 minutes. */
export const QUARTER_SECONDS=900;

export const FOOTBALL_FEATURES:Record<string,Feature>={
  /** Does this side have the ball? */
  hasBall:(ctx,side)=>{const team=possession(ctx);return team===undefined?undefined:team===side;},
  /** Yards the team with the ball needs to reach the end zone (100 = its own goal line). */
  yardsToEndZone:ctx=>num(extra(ctx).yardsToEndZone),
  down:ctx=>num(extra(ctx).down),
  distance:ctx=>num(extra(ctx).distance),
  redZone:ctx=>{const yards=num(extra(ctx).yardsToEndZone);return yards===undefined?undefined:yards<=20;},
  /** Points this side is behind (0 when level or ahead). */
  trailingBy:(ctx,side)=>{
    const yes=num(ctx.game?.yesScore),no=num(ctx.game?.noScore);
    if(yes===undefined||no===undefined)return undefined;
    return Math.max(0,side==='yes'?no-yes:yes-no);
  },
};

/**
 * Comeback drive (the owner's idea): the trailing team has the ball in scoring position. Buy it before the score and
 * sell when the drive ends (score, turnover, punt, downs, end of the half), with a stop and a time limit.
 * These thresholds are fixed before any test and are the ones research/studies/drive_entry.py measures.
 * Do not tune them on results; a changed rule is a new strategy version with its own test.
 */
export const COMEBACK_DRIVE=Object.freeze({minDeficit:3,maxDeficit:24,maxYardsToEndZone:30,maxDown:3,minSecondsRemaining:300,stopReturn:0.35,maxHoldMs:12*60_000});
export type ComebackDriveRule=typeof COMEBACK_DRIVE;

const ORDINAL=['1st','2nd','3rd','4th'];

export function comebackDrive(rule:ComebackDriveRule=COMEBACK_DRIVE):Strategy {
  return {id:'comeback-drive',version:'1',
    description:`Trailing by ${rule.minDeficit}–${rule.maxDeficit} with the ball inside the opponent's ${rule.maxYardsToEndZone}, on 1st–${ORDINAL[rule.maxDown-1]} down, `+
      `${rule.minSecondsRemaining/60}+ minutes left: buy, and sell when the drive ends.`,
    hypothesis:`Buying the trailing team (down ${rule.minDeficit}–${rule.maxDeficit}) once it has the ball inside the opponent's ${rule.maxYardsToEndZone}, `+
      'and selling when the drive ends, makes money after fees and spread, and beats random live entries in the same games.',
    propose(ctx,tools){
      if(tools.phase!=='live'||(ctx.market.sport!=='NFL'&&ctx.market.sport!=='CFB'))return [];
      const side=(['yes','no'] as const).find(item=>tools.feature('hasBall',item)===true);
      if(!side)return [];
      const behind=tools.feature('trailingBy',side),yards=tools.feature('yardsToEndZone',side),down=tools.feature('down',side),distance=tools.feature('distance',side);
      const quarter=tools.feature('period',side),left=tools.feature('secondsRemaining',side),ask=tools.quote(side).ask;
      if(typeof behind!=='number'||typeof yards!=='number'||typeof down!=='number'||typeof quarter!=='number'||ask===null)return [];
      if(!Number.isInteger(quarter)||quarter<1||quarter>4)return [];
      // Before the fourth quarter at least (4 - quarter) full quarters remain, whatever the clock shows.
      const enoughTime=(4-quarter)*QUARTER_SECONDS>=rule.minSecondsRemaining||(typeof left==='number'&&left>=rule.minSecondsRemaining);
      if(behind<rule.minDeficit||behind>rule.maxDeficit||yards>rule.maxYardsToEndZone||down<1||down>rule.maxDown||!enoughTime)return [];
      return [{strategy:'comeback-drive',strategyVersion:'1',side,style:'taker-scalp' as const,price:ask,
        exit:{kind:'drive' as const,stopReturn:rule.stopReturn,maxHoldMs:rule.maxHoldMs},
        rationale:`Down ${behind}, ball on the opponent's ${yards}, ${ORDINAL[down-1]}${typeof distance==='number'?` and ${distance}`:''}, Q${quarter}.`}];
    }};
}
