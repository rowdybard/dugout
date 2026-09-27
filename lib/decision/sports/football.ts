import type {DecisionContext,SideKey} from '../context.ts';
import type {Feature} from '../features.ts';
import type {Proposal,Strategy,StrategyTools} from '../strategies.ts';
import {paramsOf,requireSpec} from '../catalog.ts';
import {latestEvent} from '../events.ts';

/**
 * Football module: live game-state features and football strategy candidates (docs/STRATEGY-ARCHITECTURE.md).
 * Game facts come from a verified, fresh game report (lib/tennis/engine-plan.ts puts them in ctx.game.extra);
 * when the report is not fresh they are unknown, and strategies that need them propose nothing and say why.
 * Every threshold is read from the strategy's spec (lib/decision/catalog.ts), which the pre-registration lock pins.
 */

const extra=(ctx:DecisionContext)=>ctx.game?.extra??{};
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
const possession=(ctx:DecisionContext):SideKey|undefined=>{const value=extra(ctx).possession;return value==='yes'||value==='no'?value:undefined;};
const other=(side:SideKey):SideKey=>side==='yes'?'no':'yes';
const cents=(x:number)=>`${Math.round(x*1000)/10}¢`;

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
  /** 'play' after a verified down-and-distance report, 'dead-ball' after a between-plays report (scores, kicks). */
  'game.phase':ctx=>{const value=extra(ctx).phase;return value==='play'||value==='dead-ball'?value:undefined;},
  /** Seconds since the current dead-ball report reached Dugout. */
  'game.deadBallSeconds':ctx=>num(extra(ctx).deadBallSeconds),
};

const ORDINAL=['1st','2nd','3rd','4th'];
const FOOTBALL=new Set(['NFL','CFB']);

/** The team with the ball and the verified drive facts, or a note saying what is missing. */
function driveFacts(ctx:DecisionContext,tools:StrategyTools){
  if(tools.phase!=='live'||!FOOTBALL.has(ctx.market.sport)){tools.note('PHASE','Live football only.');return null;}
  const side=(['yes','no'] as const).find(item=>tools.feature('hasBall',item)===true);
  if(!side){tools.note(possession(ctx)===undefined?'STALE_GAME_STATE':'NO_SETUP',possession(ctx)===undefined?'No fresh verified down-and-distance report.':'Nobody has the ball.');return null;}
  const behind=tools.feature('trailingBy',side),yards=tools.feature('yardsToEndZone',side),down=tools.feature('down',side),quarter=tools.feature('period',side);
  if(typeof behind!=='number'||typeof yards!=='number'||typeof down!=='number'||typeof quarter!=='number'){tools.note('STALE_GAME_STATE','Score, field position, down or quarter unknown.');return null;}
  const drive=tools.feature('driveNumber',side);
  return {side,behind,yards,down,quarter,left:tools.feature('secondsRemaining',side),distance:tools.feature('distance',side),
    setupKey:`drive-${typeof drive==='number'?drive:0}`};
}

// ---- comeback-drive@1 and comeback-drive-hold@1 (reclassified; pre-registered, unchanged rules) ---------------

type ComebackParams={minDeficit:number;maxDeficit:number;maxYardsToEndZone:number;maxDown:number;minSecondsRemaining:number};
const COMEBACK=paramsOf<ComebackParams>('comeback-drive','1');
const comebackExit=requireSpec('comeback-drive','1').exits.primary;
const stopRule=comebackExit.find(rule=>rule.kind==='stop'),timeRule=comebackExit.find(rule=>rule.kind==='time');
/** comeback-drive@1's registered thresholds and exit (the bot's drive exit reads stopReturn and maxHoldMs). */
export const COMEBACK_DRIVE=Object.freeze({...COMEBACK,stopReturn:stopRule?.kind==='stop'?stopRule.netReturn:0.35,maxHoldMs:timeRule?.kind==='time'?timeRule.ms:720_000});

/**
 * The trailing team has the ball in scoring position. Proposes both versions: sell at the drive's end
 * (comeback-drive@1, a temporary-mispricing claim) and hold to the final (comeback-drive-hold@1, a calibration
 * claim). Both are speculative (see their specs); drive-fade@1 makes the opposite claim on the same setups.
 */
export function comebackDrive():Strategy {
  const rule=COMEBACK_DRIVE;
  return {id:'comeback-drive',version:'1',
    description:`Trailing by ${rule.minDeficit}–${rule.maxDeficit} with the ball inside the opponent's ${rule.maxYardsToEndZone}, on 1st–${ORDINAL[rule.maxDown-1]} down, `+
      `${rule.minSecondsRemaining/60}+ minutes left: buy, and sell when the drive ends.`,
    hypothesis:requireSpec('comeback-drive','1').hypothesis,
    propose(ctx,tools){
      const facts=driveFacts(ctx,tools);
      if(!facts)return [];
      const {side,behind,yards,down,quarter,left,distance,setupKey}=facts,ask=tools.quote(side).ask;
      if(ask===null){tools.note('THIN_BOOK','No ask for the team with the ball.');return [];}
      if(!Number.isInteger(quarter)||quarter<1||quarter>4){tools.note('NO_SETUP','Regulation quarters only.');return [];}
      // Before the fourth quarter at least (4 - quarter) full quarters remain, whatever the clock shows.
      const enoughTime=(4-quarter)*QUARTER_SECONDS>=rule.minSecondsRemaining||(typeof left==='number'&&left>=rule.minSecondsRemaining);
      if(behind<rule.minDeficit||behind>rule.maxDeficit){tools.note('NO_SETUP',behind===0?'The team with the ball is not trailing.':`Deficit ${behind} outside ${rule.minDeficit}–${rule.maxDeficit}.`);return [];}
      if(yards>rule.maxYardsToEndZone||down<1||down>rule.maxDown){tools.note('WAITING',`Ball ${yards} yards out on down ${down}; needs inside ${rule.maxYardsToEndZone} on 1st–${ORDINAL[rule.maxDown-1]}.`);return [];}
      if(!enoughTime){tools.note('NO_SETUP','Not enough time left (or the 4th-quarter clock is unverified).');return [];}
      const why=`Down ${behind}, ball on the opponent's ${yards}, ${ORDINAL[down-1]}${typeof distance==='number'?` and ${distance}`:''}, Q${quarter}.`;
      return [{strategy:'comeback-drive',strategyVersion:'1',side,style:'taker-scalp' as const,price:ask,setupKey,
        exit:{kind:'drive' as const,stopReturn:rule.stopReturn,maxHoldMs:rule.maxHoldMs},rationale:why},
      {strategy:'comeback-drive-hold',strategyVersion:'1',side,style:'taker-hold' as const,price:ask,setupKey,exit:{kind:'hold-to-settlement' as const},rationale:`${why} Hold to the final.`}];
    }};
}

// ---- drive-fade@1 --------------------------------------------------------------------------------------------

type FadeParams={maxLongshotPrice:number;maxLeaderPrice:number;maxYardsToEndZone:number;maxDown:number};

/** A trailing longshot is driving: buy the leader and hold (the favourite-longshot bias at its most salient). */
export function driveFade():Strategy {
  const rule=paramsOf<FadeParams>('drive-fade','1'),spec=requireSpec('drive-fade','1');
  return {id:'drive-fade',version:'1',description:spec.title,hypothesis:spec.hypothesis,
    propose(ctx,tools){
      const facts=driveFacts(ctx,tools);
      if(!facts)return [];
      const {side,behind,yards,down,quarter,setupKey}=facts,leader=other(side);
      if(behind<=0){tools.note('NO_SETUP','The team with the ball is not trailing.');return [];}
      if(!Number.isInteger(quarter)||quarter<1||quarter>4){tools.note('NO_SETUP','Regulation quarters only.');return [];}
      if(yards>rule.maxYardsToEndZone||down<1||down>rule.maxDown){tools.note('WAITING',`Ball ${yards} yards out on down ${down}.`);return [];}
      const longshot=tools.quote(side).ask,leaderQuote=tools.quote(leader);
      if(longshot===null||leaderQuote.ask===null||leaderQuote.bid===null){tools.note('THIN_BOOK','Incomplete book.');return [];}
      if(longshot>rule.maxLongshotPrice){tools.note('NO_SETUP',`The driving team is priced ${cents(longshot)}, not a longshot (≤ ${cents(rule.maxLongshotPrice)}).`);return [];}
      if(leaderQuote.ask>rule.maxLeaderPrice){tools.note('EDGE_TOO_SMALL',`Leader at ${cents(leaderQuote.ask)}: too little left to win.`);return [];}
      if(leaderQuote.ask-leaderQuote.bid>spec.maxSpread+1e-9){tools.note('SPREAD_TOO_WIDE',`Leader spread ${cents(leaderQuote.ask-leaderQuote.bid)}.`);return [];}
      return [{strategy:'drive-fade',strategyVersion:'1',side:leader,style:'taker-hold' as const,price:leaderQuote.ask,setupKey,exit:{kind:'hold-to-settlement' as const},
        rationale:`Longshot (${cents(longshot)}) driving, ball on the ${yards}, down ${down}: buy the leader at ${cents(leaderQuote.ask)}, hold to the final.`}];
    }};
}

// ---- surprise-fade@1 -----------------------------------------------------------------------------------------

type SurpriseParams={minSecondsAfter:number;maxSecondsAfter:number;maxScorerPrice:number;minMove:number};

/** After the underdog scores (a surprise), buy the team that was scored on and hold (Choi & Hui 2014 asymmetry). */
export function surpriseFade():Strategy {
  const rule=paramsOf<SurpriseParams>('surprise-fade','1'),spec=requireSpec('surprise-fade','1');
  return {id:'surprise-fade',version:'1',description:spec.title,hypothesis:spec.hypothesis,
    propose(ctx,tools){
      if(tools.phase!=='live'||!FOOTBALL.has(ctx.market.sport)){tools.note('PHASE','Live football only.');return [];}
      const event=latestEvent(ctx.events,'score',ctx.now);
      if(!event){tools.note('NO_SETUP','No score seen yet this game.');return [];}
      if(!event.side){tools.note('NO_SETUP','The last score change was not one team\'s score.');return [];}
      const since=(ctx.now-event.receivedAt)/1000;
      if(since<rule.minSecondsAfter){tools.note('WAITING',`Score reported ${Math.floor(since)} s ago; waits ${rule.minSecondsAfter} s for the market's own adjustment.`);return [];}
      if(since>rule.maxSecondsAfter){tools.note('NO_SETUP','No score in the entry window.');return [];}
      const scorerPre=tools.feature('lastScore.scorerPreEventPrice',event.side);
      if(typeof scorerPre!=='number'){tools.note('STALE_GAME_STATE','No price from before the score (joined too late).');return [];}
      if(scorerPre>rule.maxScorerPrice){tools.note('NO_SETUP',`Expected score: the scorer was priced ${cents(scorerPre)} before it.`);return [];}
      const faded=other(event.side),moved=tools.feature('lastScore.moveAgainst',faded);
      if(typeof moved!=='number'){tools.note('STALE_BOOK','No current midpoint.');return [];}
      if(moved<rule.minMove){tools.note('NO_SETUP',`The market moved ${cents(moved)}, below the ${cents(rule.minMove)} that marks an overreaction candidate.`);return [];}
      const quote=tools.quote(faded);
      if(quote.ask===null||quote.bid===null){tools.note('THIN_BOOK','Incomplete book.');return [];}
      if(quote.ask-quote.bid>spec.maxSpread+1e-9){tools.note('SPREAD_TOO_WIDE',`Spread ${cents(quote.ask-quote.bid)}.`);return [];}
      return [{strategy:'surprise-fade',strategyVersion:'1',side:faded,style:'taker-hold' as const,price:quote.ask,setupKey:event.id,exit:{kind:'hold-to-settlement' as const},
        rationale:`Surprise score (scorer was ${cents(scorerPre)}); the other side fell ${cents(moved)}. Buy it at ${cents(quote.ask)} ${Math.floor(since)} s after the report, hold to the final.`}];
    }};
}

// ---- quiet-window-maker@1 ------------------------------------------------------------------------------------

type QuietParams={maxWindowSeconds:number;maxQuoteSpread:number;pullOnMoveCents:number;inventoryMultiple:number};

/** Rest at both bids only while the ball is dead (scores, kicks), pulled before the next snap. */
export function quietWindowMaker():Strategy {
  const rule=paramsOf<QuietParams>('quiet-window-maker','1'),spec=requireSpec('quiet-window-maker','1');
  return {id:'quiet-window-maker',version:'1',description:spec.title,hypothesis:spec.hypothesis,
    propose(ctx,tools){
      if(tools.phase!=='live'||!FOOTBALL.has(ctx.market.sport)){tools.note('PHASE','Live football only.');return [];}
      const phase=tools.feature('game.phase','yes'),seconds=tools.feature('game.deadBallSeconds','yes');
      if(phase!=='dead-ball'||typeof seconds!=='number'){tools.note('WAITING',phase==='play'?'Ball in play: quotes only while the ball is dead.':'No verified game report.');return [];}
      if(seconds>rule.maxWindowSeconds){tools.note('WAITING',`Dead-ball window over (${Math.floor(seconds)} s); pulled before the snap.`);return [];}
      const velocity=tools.feature('velocity30s','yes');
      if(typeof velocity==='number'&&Math.abs(velocity)>=rule.pullOnMoveCents){tools.note('ALREADY_REACTED',`Price moving ${velocity.toFixed(1)}¢ in 30 s.`);return [];}
      const yes=tools.quote('yes');
      if(yes.ask===null||yes.bid===null||yes.ask-yes.bid>rule.maxQuoteSpread+1e-9){tools.note('SPREAD_TOO_WIDE','Book too wide to quote.');return [];}
      const window=latestEvent(ctx.events,'dead-ball',ctx.now)?.id??'window';
      return (['yes','no'] as const).flatMap(side=>{const bid=tools.quote(side).bid;return bid===null?[]:[{strategy:'quiet-window-maker',strategyVersion:'1',side,style:'maker' as const,price:bid,setupKey:`${window}:${side}`,
        exit:{kind:'maker' as const,pullAfterEventMs:null,windowOnly:true},rationale:`Dead ball for ${Math.floor(seconds)} s: rest at the ${cents(bid)} bid.`} satisfies Proposal];});
    }};
}
