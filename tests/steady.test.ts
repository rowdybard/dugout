import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import {modeRules,tradeMode} from '../lib/tennis/modes.ts';
import type {TennisInput} from '../lib/tennis/types';

const START=Date.parse('2026-10-03T16:00:00Z'),SLUG='aec-cfb-syra-uconn-2026-10-03';
/** A college game 6 minutes before kickoff: Syracuse (YES, away) the 75¢ favourite. */
function input(at:number):TennisInput {
  const raw={id:'300001',slug:'cfb-syra-uconn-2026-10-03',title:'Syracuse vs UConn',startTime:'2026-10-03T16:00:00Z',active:true,live:false,ended:false,
    eventState:{type:'football',live:false,ended:false,updatedAt:new Date(at-500).toISOString()},
    markets:[{slug:SLUG,sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:'0.74'},bestAskQuote:{value:'0.75'},
      marketSides:[{long:true,description:'Orange',teamId:7001,team:{id:7001,name:'Syracuse',league:'cfb',ordering:'away'}},
        {long:false,description:'Huskies',teamId:7002,team:{id:7002,name:'UConn',league:'cfb',ordering:'home'}}]}]};
  const market=normalizeTennisEvent(raw,'CFB',at)[0];
  assert.ok(market?.active,market?.unavailableReason);
  return {receivedAt:at,source:'REST',sourceTime:at,market,
    book:{bids:[{price:0.74,quantity:800}],asks:[{price:0.75,quantity:800}],state:'MARKET_STATE_OPEN',time:new Date(at).toISOString()}};
}
function run(entries?:'steady'|'all'|'auto',cash?:number){
  const base={...defaultLiveTennisConfig(100),leagues:['CFB' as const],focusSlug:SLUG};
  const config={...base,...(entries==='auto'?modeRules(base,'auto'):entries?{entries}:{})};
  assert.equal(validateTennisConfig(config),null);
  let session=createTennisSession(config,START-3_600_000);
  session=applyTennisAction(session,{action:'start',commandId:'steady-start'},[],START-3_600_000);
  if(cash!==undefined)session={...session,cash};
  const at=START-6*60_000;
  return stepTennisSession(session,[input(at)],at);
}

test('steady accounts never take a hold-to-final entry; they only rest quotes',()=>{
  const all=run();
  assert.equal(all.pending?.action,'BUY','by default the measured CFB favourite lead is paper-traded (one win-or-lose bet)');
  assert.equal(all.pending?.plan?.strategy,'favourite-hold');
  const steady=run('steady');
  assert.equal(steady.pending,null,steady.lastReason);
  assert.ok(steady.maker?.quotes.YES&&steady.maker.quotes.NO,steady.maker?.reason??steady.lastReason);
  assert.equal(steady.maker!.quotes.YES!.price,0.74);assert.equal(steady.maker!.quotes.NO!.price,0.25);
});

test('Auto trades Bold where the research allows a bet, and Steady (at Steady size) once the run is down 10%',()=>{
  const bold=run('auto');
  assert.equal(bold.autoMode?.mode,'bold',bold.autoMode?.reason);assert.match(bold.autoMode!.reason,/favourite-hold/);
  assert.equal(bold.pending?.action,'BUY','Bold takes the hold-to-final bet');
  assert.equal(bold.pending?.plan?.strategy,'favourite-hold');
  const down=run('auto',89);
  assert.equal(tradeMode(down),'steady');assert.match(down.autoMode!.reason,/down 11%/);
  assert.equal(down.pending,null,'Steady takes no bets');
  const quote=down.maker?.quotes.YES;
  assert.ok(quote,down.maker?.reason??down.lastReason);
  assert.ok(quote.price*quote.quantity<=5+1e-9,`Steady-sized offer, not Bold's $12 (${quote.quantity} at ${quote.price})`);
  assert.ok(down.decisions.some(d=>d.code==='AUTO_MODE'&&/Steady/.test(d.reason)));
});

test('upcoming college games (no live flag, period "NS", as the feed sends them) are open for pregame trading',()=>{
  const at=Date.parse('2026-10-02T15:50:00Z');
  const raw={id:'300002',slug:'cfb-librty-del-2026-10-02',title:'Liberty vs Delaware',startTime:'2026-10-02T23:00:00Z',active:true,closed:false,period:'NS',eventState:null,
    markets:[{slug:'aec-cfb-librty-del-2026-10-02',sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:'0.6'},bestAskQuote:{value:'0.61'},
      marketSides:[{long:true,description:'Flames',teamId:8001,team:{id:8001,name:'Liberty',league:'cfb',ordering:'away'}},
        {long:false,description:"Fightin' Blue Hens",teamId:8002,team:{id:8002,name:'Delaware',league:'cfb',ordering:'home'}}]}]};
  const market=normalizeTennisEvent(raw,'CFB',at)[0];
  assert.equal(market.active,true,market.unavailableReason);assert.equal(market.live,false);
  assert.equal(normalizeTennisEvent({...raw,startTime:'2026-10-02T15:00:00Z'},'CFB',at)[0].active,false,'past kickoff without a live flag: not tradable');
});

test('reset can drop open paper trades (fake money) so nobody gets stuck, and keeps the Steady/Full choice',()=>{
  const busy=run();
  assert.equal(busy.pending?.action,'BUY');
  const at=START-5*60_000;
  const refused=applyTennisAction(busy,{action:'reset',bankroll:50,commandId:'reset-1'},[],at);
  assert.equal(refused.pending?.action,'BUY','without abandon, an open order blocks the reset');
  const fresh=applyTennisAction(busy,{action:'reset',bankroll:50,commandId:'reset-2',abandon:true},[],at);
  assert.equal(fresh.pending,null);assert.equal(fresh.positions.length,0);assert.equal(fresh.cash,50);assert.equal(fresh.status,'idle');
  const steady=applyTennisAction({...run('steady'),pending:busy.pending},{action:'reset',bankroll:20,commandId:'reset-3',abandon:true},[],at);
  assert.equal(steady.config.entries,'steady','the Steady choice survives a reset');
});

// ---- Chaos mode: Steady resting orders on several games at once ------------------------------------------------

function game(slug:string,at:number,bid:number,ask:number,start='2026-10-03T16:00:00Z'):TennisInput {
  const raw={id:slug.length+400000,slug:slug.replace(/^aec-/,''),title:slug,startTime:start,active:true,closed:false,period:'NS',eventState:null,
    markets:[{slug,sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:String(bid)},bestAskQuote:{value:String(ask)},
      marketSides:[{long:true,description:'Away',teamId:9001,team:{id:9001,name:`${slug} away`,league:'cfb',ordering:'away'}},
        {long:false,description:'Home',teamId:9002,team:{id:9002,name:`${slug} home`,league:'cfb',ordering:'home'}}]}]};
  const market=normalizeTennisEvent(raw,'CFB',at)[0];
  assert.ok(market?.active,market?.unavailableReason);
  return {receivedAt:at,source:'REST',sourceTime:at,market,book:{bids:[{price:bid,quantity:800}],asks:[{price:ask,quantity:800}],state:'MARKET_STATE_OPEN',time:new Date(at).toISOString()}};
}
const A='aec-cfb-alpha-beta-2026-10-03',B='aec-cfb-gamma-delta-2026-10-03',C='aec-cfb-eps-zeta-2026-10-03';

test('Chaos mode rests Steady orders on several games at once, each with its own quotes and fills',()=>{
  const config={...defaultLiveTennisConfig(100),leagues:['CFB' as const],focusSlug:A,entries:'steady' as const,chaosSlugs:[B,C]};
  assert.equal(validateTennisConfig(config),null);
  assert.equal(validateTennisConfig({...config,entries:'all'}),null,'the Octopus works in Bold too');
  let session=applyTennisAction(createTennisSession(config,START-3_600_000),{action:'start',commandId:'chaos-start'},[],START-3_600_000);
  let t=START-60*60_000;
  session=stepTennisSession(session,[game(A,t,0.6,0.61),game(B,t,0.3,0.31),game(C,t,0.5,0.51)],t);
  assert.ok(session.maker?.quotes.YES&&session.maker.slug===A,session.maker?.reason);
  assert.equal(session.chaos?.[B]?.quotes.YES?.price,0.3);assert.equal(session.chaos?.[B]?.quotes.NO?.price,0.69);
  assert.equal(session.chaos?.[C]?.quotes.YES?.price,0.5);
  assert.equal(session.pending,null,'never a taker entry');
  assert.equal(session.enginePlan?.slug,A,'the dashboard plan stays on the main game');
  // On B sellers come down to our 30¢ bid: B's YES quote fills, A and C are untouched.
  t+=5_000;
  session=stepTennisSession(session,[game(A,t,0.6,0.61),game(B,t,0.29,0.3),game(C,t,0.5,0.51)],t);
  const fills=session.ledger.filter(entry=>entry.action==='BUY');
  assert.equal(fills.length,1);assert.equal(fills[0].slug,B);assert.equal(fills[0].side,'YES');
  assert.equal(session.positions.filter(p=>p.status==='open'&&p.exitPolicy==='maker').length,1);
  assert.equal(session.chaos?.[B]?.fills,1);assert.equal(session.maker?.fills??0,0);
  // Dropping C from Chaos mode withdraws its quotes; B (with inventory) keeps its state.
  session=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:'chaos-drop',rules:{chaosSlugs:[B]}},[],t+1000);
  t+=10_000;
  session=stepTennisSession(session,[game(A,t,0.6,0.61),game(B,t,0.3,0.31),game(C,t,0.5,0.51)],t);
  assert.equal(session.chaos?.[C],undefined,'C forgotten once nothing rests and nothing is held');
  assert.ok(session.chaos?.[B]);
  // Pause: every game's quotes come down.
  session=applyTennisAction(session,{action:'pause',commandId:'chaos-pause'},[],t+1000);
  t+=5_000;
  session=stepTennisSession(session,[game(A,t,0.6,0.61),game(B,t,0.3,0.31)],t);
  assert.ok(!session.maker?.quotes.YES&&!session.chaos?.[B]?.quotes.YES&&!session.chaos?.[B]?.quotes.NO);
});
