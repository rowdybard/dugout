import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOctopusPicks,octopusPickDue,octopusSlugs,pickOctopusGames,OCTOPUS_REPICK_MS} from '../lib/tennis/octopus.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import {modeRules} from '../lib/tennis/modes.ts';
import type {TennisConfig,TennisInput,TennisMarket,TennisSession} from '../lib/tennis/types';
import {setPaperAccountLimits} from '../lib/tennis/account-limits.ts';
// These tests check the account limits themselves, which are off for paper accounts by default (lib/tennis/account-limits.ts).
setPaperAccountLimits(true);

const NOW=Date.parse('2026-10-03T14:00:00Z');
const listed=(slug:string,bid:number,ask:number,over:Partial<TennisMarket>={})=>({slug,league:'CFB',active:true,ended:false,live:false,
  startTime:new Date(NOW+2*3600_000).toISOString(),bid,ask,yesName:slug,noName:slug,...over}) as TennisMarket;
const base=(over:Partial<TennisConfig>={})=>({config:{...defaultLiveTennisConfig(100),leagues:['CFB' as const],focusSlug:'main',...over}}) as Pick<TennisSession,'config'|'octopus'>;

test('arms: pinned games first, then auto picks; never the main game or a skipped game; at most 6',()=>{
  const s={...base({chaosSlugs:['p1','p2'],octopusAuto:true,octopusSkip:['x']}),octopus:{slugs:['a1','main','x','p1','a2','a3','a4','a5','a6'],pickedAt:NOW}};
  assert.deepEqual(octopusSlugs(s),['p1','p2','a1','a2','a3','a4']);
  assert.deepEqual(octopusSlugs({...s,config:{...s.config,octopusAuto:false}}),['p1','p2'],'auto off: pinned only');
});

test('auto pick: open college games live or within 6 hours with a 2-cent spread or less, narrowest first; stable; skip respected',()=>{
  const markets=[listed('wide',.40,.45),listed('tight',.50,.505),listed('ok',.30,.32),listed('late',.50,.51,{startTime:new Date(NOW+8*3600_000).toISOString()}),
    listed('live',.60,.61,{live:true}),listed('ended',.5,.51,{ended:true}),listed('nfl',.5,.505,{league:'NFL'}),listed('main',.5,.505)];
  const s=base({octopusAuto:true,chaosSlugs:['ok']});
  const picks=pickOctopusGames(markets,s,NOW)!;
  assert.deepEqual(picks,['tight','live'],'ok is pinned; wide, late, ended, NFL and the main game are out');
  const later={...s,octopus:{slugs:picks,pickedAt:NOW}};
  assert.equal(octopusPickDue(later,NOW+60_000),false,'not due within 5 minutes');
  assert.equal(octopusPickDue(later,NOW+OCTOPUS_REPICK_MS),true);
  // Current picks stay ahead of a newly tighter game (no churn).
  assert.deepEqual(pickOctopusGames([...markets,listed('tighter',.5,.5)],later,NOW+OCTOPUS_REPICK_MS),['tight','live','tighter'].slice(0,5));
  const skipped={...later,config:{...later.config,octopusSkip:['tight']}};
  assert.equal(octopusPickDue(skipped,NOW+1000),true,'a skip makes a new pick due at once');
  assert.ok(!pickOctopusGames(markets,skipped,NOW+1000)!.includes('tight'));
  assert.equal(pickOctopusGames(markets,base({octopusAuto:false}),NOW),null,'auto off: nothing picked');
});

function game(slug:string,at:number,bid:number,ask:number):TennisInput {
  const raw={id:slug.length+500000,slug:slug.replace(/^aec-/,''),title:slug,startTime:'2026-10-03T16:00:00Z',active:true,closed:false,period:'NS',eventState:null,
    markets:[{slug,sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:String(bid)},bestAskQuote:{value:String(ask)},
      marketSides:[{long:true,description:'Away',teamId:9101,team:{id:9101,name:`${slug} away`,league:'cfb',ordering:'away'}},
        {long:false,description:'Home',teamId:9102,team:{id:9102,name:`${slug} home`,league:'cfb',ordering:'home'}}]}]};
  const market=normalizeTennisEvent(raw,'CFB',at)[0];
  return {receivedAt:at,source:'REST',sourceTime:at,market,book:{bids:[{price:bid,quantity:2000}],asks:[{price:ask,quantity:2000}],state:'MARKET_STATE_OPEN',time:new Date(at).toISOString()}};
}
const games=['aec-cfb-main-one-2026-10-03','aec-cfb-arm-two-2026-10-03','aec-cfb-arm-three-2026-10-03','aec-cfb-arm-four-2026-10-03'];
const reserved=(s:TennisSession)=>[s.maker,...Object.values(s.chaos??{})].reduce((sum,m)=>sum+(['YES','NO'] as const).reduce((t,side)=>t+(m?.quotes[side]?m.quotes[side]!.price*m.quotes[side]!.quantity:0),0),0);

test('Bold Octopus: arms quote at Bold size, auto picks arrive through a check, and all offers stay within half the balance',()=>{
  const cfg={...defaultLiveTennisConfig(100),leagues:['CFB' as const],focusSlug:games[0],...modeRules({startingCash:100},'bold'),octopusAuto:true};
  assert.equal(validateTennisConfig(cfg),null,'the Octopus is allowed in Bold');
  let s=applyTennisAction(createTennisSession(cfg,NOW-3600_000),{action:'start',commandId:'go'},[],NOW-3600_000);
  const t=NOW;const books=(time:number)=>games.map((slug,i)=>game(slug,time,.40+i*.05,.41+i*.05));
  s=applyTennisAction(s,{action:'tick',octopus:games.slice(1)},books(t),t);
  assert.deepEqual(s.octopus?.slugs,games.slice(1),'picks recorded with the check');
  assert.ok(s.maker?.quotes.YES||s.maker?.quotes.NO,`main game quoting: ${s.maker?.reason} | pending ${s.pending?.action} | ${s.lastReason}`);
  const quoting=Object.values(s.chaos??{}).filter(m=>m.quotes.YES||m.quotes.NO).length;
  assert.ok(quoting>=1,'arms quoting');
  assert.ok(reserved(s)<=50+1e-6,`all resting offers within half the balance: $${reserved(s).toFixed(2)}`);
  // A skipped auto arm pulls its offers.
  s=applyTennisAction(s,{action:'update-rules',sessionId:s.id,expectedRulesRevision:s.rulesRevision??0,commandId:'skip',rules:{octopusSkip:[games[1]]}},[],t+1000);
  s=stepTennisSession(s,books(t+5000),t+5000);
  assert.ok(!s.chaos?.[games[1]]?.quotes.YES&&!s.chaos?.[games[1]]?.quotes.NO,'skipped arm has no offers');
  assert.ok(reserved(s)<=50+1e-6);
});

test('auto picks are deterministic on replay: the same check with the same picks gives the same state',()=>{
  const cfg={...defaultLiveTennisConfig(100),leagues:['CFB' as const],focusSlug:games[0],entries:'steady' as const,octopusAuto:true};
  const start=applyTennisAction(createTennisSession(cfg,NOW-3600_000),{action:'start',commandId:'go'},[],NOW-3600_000);
  const books=games.map((slug,i)=>game(slug,NOW,.40+i*.05,.41+i*.05));
  const one=applyTennisAction(structuredClone(start),{action:'tick',octopus:[games[2]]},books,NOW);
  const two=applyTennisAction(structuredClone(start),{action:'tick',octopus:[games[2]]},books,NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(one)),JSON.parse(JSON.stringify(two)));
  assert.deepEqual(applyOctopusPicks({},undefined,NOW),{},'no picks: unchanged');
});
