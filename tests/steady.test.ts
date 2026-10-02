import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
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
function run(entries?:'steady'|'all'){
  const config={...defaultLiveTennisConfig(100),leagues:['CFB' as const],focusSlug:SLUG,...(entries?{entries}:{})};
  assert.equal(validateTennisConfig(config),null);
  let session=createTennisSession(config,START-3_600_000);
  session=applyTennisAction(session,{action:'start',commandId:'steady-start'},[],START-3_600_000);
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
