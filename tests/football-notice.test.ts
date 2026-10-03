import test from 'node:test';
import assert from 'node:assert/strict';
import {footballFreshnessNotice,isFootballFreshnessReason} from '../components/tennis/football-notice.ts';
import {footballFieldView,type FootballFieldMarket} from '../lib/tennis/football-field.ts';

const now=1_000_000;
function market(clockAge=1000,driveAge=48_000):FootballFieldMarket{return {
  league:'CFB',yesName:'Montana State',noName:'Idaho',live:true,ended:false,
  footballIdentity:{yesTeamId:'msu',noTeamId:'idaho'},contextUpdatedAt:now-clockAge,observedAt:now-500,
  football:{possessionTeam:'Idaho',possessionTeamId:'idaho',down:1,yardsToGo:10,fieldPosition:{team:'Montana State',teamId:'msu',yard:35},timeouts:[]},
  footballSources:{scoreboard:{provider:'POLYMARKET',eventId:'game',reportTime:now-clockAge,receiptTime:now-500},drive:{provider:'ESPN',eventId:'fallback',reportTime:now-driveAge,receiptTime:now-500}},
};}

test('a recently fetched 48-second ESPN play remains usable under the 90-second ESPN allowance',()=>{
  const m=market(),check={successfulCheckAt:now-500,error:null};
  assert.equal(footballFreshnessNotice(m,now,undefined,check),null);
  const field=footballFieldView(m,now);
  assert.equal(field.sources.drive.reportAgeMs,48_000);assert.equal(field.sources.drive.receiptAgeMs,500);
  assert.equal(field.sources.drive.freshness,'fresh');assert.equal(field.lineOfScrimmage,35);
});

test('only an expired ESPN report gets the plain drive waiting status while its fetched details remain available',()=>{
  const m=market(1000,90_001),check={successfulCheckAt:now-500,error:null};
  assert.equal(footballFreshnessNotice(m,now,undefined,check),'Waiting for an updated ESPN drive.');
  const field=footballFieldView(m,now);assert.equal(field.sources.clock.freshness,'fresh');assert.equal(field.sources.drive.freshness,'stale');
  assert.equal(field.lineOfScrimmage,35);assert.equal(field.firstDownLine,25);
});

test('Polymarket retains 45 seconds and ESPN-ahead mismatch stays blocked',()=>{
  assert.equal(footballFreshnessNotice(market(45_001,50_000),now),'Waiting for an updated Polymarket scoreboard.');
  assert.equal(footballFreshnessNotice(market(30_000,1000),now),'The drive update is ahead of the Polymarket scoreboard. Waiting for aligned updates.');
});

test('transport failure is distinct from successful fetch of an old play',()=>{
  const old=market(1000,95_000);
  assert.equal(footballFreshnessNotice(old,now,undefined,{successfulCheckAt:now-500,error:null}),'Waiting for an updated ESPN drive.');
  assert.equal(footballFreshnessNotice(old,now,undefined,{successfulCheckAt:now-5000,error:'Provider timed out.'}),'Game-feed check failed: Provider timed out. Showing the last available report.');
});

test('ESPN receipts still expire at 45 seconds even when its report is within 90 seconds',()=>{
  const m=market(1000,80_000);m.footballSources!.drive.receiptTime=now-45_001;
  const view=footballFieldView(m,now);
  assert.equal(view.sources.drive.reportAgeMs,80_000);assert.equal(view.sources.drive.freshness,'stale');
  assert.equal(footballFreshnessNotice(m,now),'Waiting for an updated ESPN drive.');
});

test('feed-note de-duplication never removes delayed bot or runner health messages',()=>{
  assert.equal(isFootballFreshnessReason("The bot's last check was 90 seconds ago. Reload the page."),false);
  assert.equal(isFootballFreshnessReason('Runner checks are more than 45 seconds behind.'),false);
  assert.equal(isFootballFreshnessReason('One football source is older than 45 seconds.'),true);
});
