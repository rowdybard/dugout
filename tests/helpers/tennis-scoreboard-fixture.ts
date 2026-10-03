import {normalizeTennisEvent} from '../../lib/tennis/normalize.ts';
export const TENNIS_SCORE_NOW=Date.parse('2026-10-03T04:08:53Z');
/** Small synthetic response using the verified Polymarket live-tennis field shape. */
export function tennisScoreEvent(reportAt=TENNIS_SCORE_NOW-1000){
  return {id:'136204',slug:'wta-player-a-player-b-2026-10-03',title:'Player A vs. Player B',startTime:new Date(TENNIS_SCORE_NOW-3600000).toISOString(),active:true,closed:false,live:true,ended:false,score:'4-6, 0-3:40-40',period:'S2',
    eventState:{eventId:136204,type:'tennis',updatedAt:new Date(reportAt).toISOString(),live:true,ended:false,score:'4-6, 0-3:40-40',period:'S2',
      tennisState:{tournamentName:'WTA Example Women Singles',round:'Round of 64',servingTeamId:202},
      periodScores:[{number:1,type:'PERIOD_SCORE_TYPE_REGULATION',label:'S1',scores:[{competitorId:'101',score:4},{competitorId:'202',score:6}]},{number:2,type:'PERIOD_SCORE_TYPE_REGULATION',label:'S2',scores:[{competitorId:'101',score:0},{competitorId:'202',score:3}]}]},
    markets:[{slug:'aec-wta-player-a-player-b-2026-10-03',sportsMarketType:'tennis_match_winner',active:true,closed:false,status:'MARKET_STATUS_OPEN',minimumTradeQty:.01,orderPriceMinTickSize:.005,feeCoefficient:.0695,bestBidQuote:{value:'.415'},bestAskQuote:{value:'.420'},
      marketSides:[{long:true,description:'Player A',teamId:101,team:{id:101,name:'Player A',league:'wta',ordering:'home'}},{long:false,description:'Player B',teamId:202,team:{id:202,name:'Player B',league:'wta',ordering:'away'}}]}]};
}
export function tennisScoreMarket(now=TENNIS_SCORE_NOW,reportAt=now-2000){
  return {...normalizeTennisEvent(tennisScoreEvent(reportAt),'WTA',now-500)[0],quoteObservedAt:now-10_000,quoteSource:'REST' as const,quoteSourceTime:now-10_000,history:[{time:now-10_000,price:.4}]};
}
