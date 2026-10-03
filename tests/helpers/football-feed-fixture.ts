import {normalizeTennisEvent} from '../../lib/tennis/normalize.ts';

/** Synthetic reports using the public, explicitly verified Montana State–Idaho mapping. */
export const FOOTBALL_FEED_NOW=Date.parse('2026-10-03T03:15:20Z');
export function montanaEvent(reportAt=FOOTBALL_FEED_NOW-1000){
  return {id:'117784',slug:'cfb-monst-idaho-2026-10-02',title:'Montana State vs. Idaho',startTime:'2026-10-03T02:30:00Z',active:true,live:true,ended:false,score:'10-7',period:'Q1',
    eventState:{type:'football',updatedAt:new Date(reportAt).toISOString(),score:'10-7',period:'Q1',elapsed:'1:31',live:true,ended:false,footballState:{driveState:null}},
    markets:[{slug:'aec-cfb-monst-idaho-2026-10-02',sportsMarketType:'football_team_full_game_winner',active:true,status:'MARKET_STATUS_OPEN',minimumTradeQty:'1',orderPriceMinTickSize:'0.01',feeCoefficient:'0.05',bestBidQuote:{value:'0.6'},bestAskQuote:{value:'0.61'},
      marketSides:[{long:true,teamId:1110,team:{id:1110,name:'Montana State',league:'cfb',ordering:'away'}},{long:false,teamId:1109,team:{id:1109,name:'Idaho',league:'cfb',ordering:'home'}}]}]};
}
export function montanaMarket(receivedAt=FOOTBALL_FEED_NOW,reportAt=receivedAt-1000){return normalizeTennisEvent(montanaEvent(reportAt),'CFB',receivedAt)[0];}
export function espnSummary(reportAt=FOOTBALL_FEED_NOW-1000){
  const wallclock=new Date(reportAt).toISOString();
  return {header:{id:'401868094',competitions:[{id:'401868094',date:'2026-10-03T02:30Z',status:{period:1,displayClock:'5:37',type:{state:'in',completed:false}},competitors:[
    {id:'70',homeAway:'home',team:{id:'70',displayName:'Idaho Vandals'},score:'7'},
    {id:'147',homeAway:'away',team:{id:'147',displayName:'Montana State Bobcats'},score:'10'}]}]},
    wallclockAvailable:true,meta:{lastUpdatedAt:wallclock,lastPlayWallClock:wallclock},
    drives:{current:{id:'40186809410',team:{id:'70'},plays:[{id:'401868094161',sequenceNumber:'38',wallclock,period:{number:1},clock:{displayValue:'5:37'},type:{id:'24',text:'Pass Reception'},text:'Synthetic pass completed for 22 yards.',scoringPlay:false,scoreValue:0,awayScore:10,homeScore:7,
      start:{down:3,distance:23,yardLine:51,yardsToEndzone:49,team:{id:'70'}},end:{down:4,distance:1,yardLine:73,yardsToEndzone:27,team:{id:'70'}}}]}}};
}

/** Minimal native public fields captured on October 3. Prices/execution rules are synthetic. */
export function nativeFootballEvent(game:'penn'|'pitt'){
  const penn=game==='penn',base=montanaEvent();
  const id=penn?'117782':'117781',slug=penn?'cfb-pennst-nw-2026-10-02':'cfb-pitt-vtech-2026-10-02';
  const away=penn?{id:1132,name:'Penn State'}:{id:1089,name:'Pittsburgh'},home=penn?{id:1131,name:'Northwestern'}:{id:1092,name:'Virginia Tech'};
  const report=penn?'2026-10-03T03:32:31.331553Z':'2026-10-03T02:45:31.210263Z';
  return {...base,id,slug,title:away.name+' vs. '+home.name,startTime:penn?'2026-10-03T00:00:00Z':'2026-10-02T23:00:00Z',live:penn,ended:!penn,score:penn?'13-34':'35-33',period:penn?'Q4':'FT',
    eventState:{...base.eventState,updatedAt:report,score:penn?'13-34':'35-33',period:penn?'Q4':'FT',elapsed:penn?'1:34':'',live:penn,ended:!penn,
      footballState:{driveState:{down:1,yfd:10,possessionTeamId:String(away.id),fieldPosition:{teamId:String(away.id),yard:penn?50:20}},
        timeouts:[{teamId:String(home.id),remaining:1},{teamId:String(away.id),remaining:0}]}},
    markets:[{...base.markets[0],slug:'aec-'+slug,marketSides:[{long:true,teamId:away.id,team:{...away,league:'cfb',ordering:'away'}},{long:false,teamId:home.id,team:{...home,league:'cfb',ordering:'home'}}]}]};
}
