import test from 'node:test';
import assert from 'node:assert/strict';
import {marketWithWatchedContext} from '../lib/tennis/chart-data.ts';
import {retainedTennisContext} from '../lib/tennis/market-context.ts';
import type {TennisMarket} from '../lib/tennis/types.ts';

const now=1_000_000;
function market():TennisMarket{return {
  slug:'montana-idaho',eventId:'117784',eventSlug:'montana-idaho',title:'Montana State vs Idaho',league:'CFB',yesName:'Montana State',noName:'Idaho',startTime:'',
  live:true,ended:false,score:'10-7',period:'Q1',clock:'1:31',tournament:null,active:true,bid:.49,ask:.51,price:.5,history:[],
  contextUpdatedAt:now-5000,observedAt:now-1000,quoteObservedAt:now-250,execution:{active:true} as TennisMarket['execution'],
  footballIdentity:{yesTeamId:'1110',noTeamId:'1109'},
  football:{possessionTeam:'Idaho',possessionTeamId:'1109',down:3,yardsToGo:8,fieldPosition:{team:'Montana State',teamId:'1110',yard:27},timeouts:[]},
  footballSources:{scoreboard:{provider:'POLYMARKET',eventId:'117784',reportTime:now-5000,receiptTime:now-1000},
    drive:{provider:'ESPN',eventId:'401868094',playId:'160',sequence:37,reportTime:now-15000,receiptTime:now-2000}},
};}
const merges=[marketWithWatchedContext,retainedTennisContext];
test('new ESPN evidence updates the field with unchanged Polymarket clock receipts and preserves prices',()=>{
  for(const merge of merges){
    const stored=market(),latest=structuredClone(stored),before=structuredClone(stored);
    latest.football!.down=4;latest.football!.yardsToGo=1;
    latest.footballSources!.drive={...latest.footballSources!.drive,playId:'161',sequence:38,reportTime:now-12000,receiptTime:now-500};
    latest.bid=.8;latest.ask=.9;latest.quoteObservedAt=now;
    const result=merge(stored,latest,now);
    assert.equal(result.football!.down,4);assert.equal(result.footballSources!.drive.playId,'161');
    assert.equal(result.clock,'1:31');assert.equal(result.score,'10-7');
    assert.equal(result.contextUpdatedAt,stored.contextUpdatedAt);assert.equal(result.observedAt,stored.observedAt);
    assert.equal(result.bid,stored.bid);assert.equal(result.ask,stored.ask);assert.equal(result.quoteObservedAt,stored.quoteObservedAt);
    assert.deepEqual(stored,before);
  }
});
test('source alignment errors survive a context merge and older scoreboard evidence cannot rewind it',()=>{
  for(const merge of merges){
    const stored=market(),latest={...structuredClone(stored),footballSourceIssue:'ESPN drive is older than 45 seconds.'};
    assert.equal(merge(stored,latest,now).footballSourceIssue,latest.footballSourceIssue);
    const old={...latest,contextUpdatedAt:stored.contextUpdatedAt!-1,observedAt:stored.observedAt+1,clock:'5:37'};
    assert.equal(merge(stored,old,now),stored);
  }
});
