import test from 'node:test';
import assert from 'node:assert/strict';
import {footballFieldView,FOOTBALL_FIELD_FRESH_MS,type FootballFieldMarket} from '../lib/tennis/football-field.ts';
import type {FootballAssessment} from '@/lib/tennis/types';

const now=1_000_000;
function market(patch:Partial<FootballFieldMarket>={}):FootballFieldMarket{return {
  league:'CFB',yesName:'Clemson',noName:'California',live:true,ended:false,
  footballIdentity:{yesTeamId:'clemson',noTeamId:'cal'},observedAt:now-1000,contextUpdatedAt:now-2000,
  football:{possessionTeam:'Clemson',possessionTeamId:'clemson',down:2,yardsToGo:7,fieldPosition:{team:'Clemson',teamId:'clemson',yard:35},timeouts:[]},...patch,
};}
function drive(patch:Partial<NonNullable<FootballFieldMarket['football']>>){const m=market();return market({football:{...m.football!,...patch}});}

test('between-play state hides stale scrimmage and first-down markers without inventing a kick type',()=>{
  const m=drive({phase:'between-plays',down:null,yardsToGo:null});
  const assessment:FootballAssessment={status:'transition',reason:'Between scrimmage plays.',reportTime:now-2000,receiptTime:now-1000,reportAgeMs:2000,receiptAgeMs:1000};
  const v=footballFieldView(m,now,assessment);
  assert.equal(v.freshness,'transition');assert.equal(v.lineOfScrimmage,null);assert.equal(v.firstDownLine,null);
  assert.equal(v.possession,null);assert.equal(v.distanceLabel,'Between scrimmage plays');
  assert.equal(footballFieldView(m,now+46000,assessment).freshness,'stale');
});

test('YES goal stays on the left; YES advances right from its own territory',()=>{
  const v=footballFieldView(market(),now);assert.equal(v.lineOfScrimmage,35);assert.equal(v.firstDownLine,42);assert.equal(v.direction,1);assert.equal(v.possession,'YES');assert.equal(v.distanceLabel,'2nd & 7');
});
test('NO territory uses 100 minus reported yard and YES continues right',()=>{
  const v=footballFieldView(drive({fieldPosition:{team:'California',teamId:'cal',yard:35}}),now);assert.equal(v.lineOfScrimmage,65);assert.equal(v.firstDownLine,72);
});
test('NO possession advances left without mirroring the field',()=>{
  const v=footballFieldView(drive({possessionTeam:'California',possessionTeamId:'cal',fieldPosition:{team:'California',teamId:'cal',yard:35}}),now);assert.equal(v.lineOfScrimmage,65);assert.equal(v.firstDownLine,58);assert.equal(v.direction,-1);
});
test('midfield has identical coordinates regardless of reported territory',()=>{
  for(const [team,teamId] of [['Clemson','clemson'],['California','cal']]){const v=footballFieldView(drive({fieldPosition:{team,teamId,yard:50}}),now);assert.equal(v.lineOfScrimmage,50);assert.equal(v.positionLabel,'Midfield');}
});
test('goal-to-go lines clamp at each goal and never extend into end zones',()=>{
  const right=footballFieldView(drive({yardsToGo:10,fieldPosition:{team:'California',teamId:'cal',yard:3}}),now);
  assert.equal(right.firstDownLine,100);assert.equal(right.goalToGo,true);assert.equal(right.distanceLabel,'2nd & goal');
  const left=footballFieldView(drive({possessionTeam:'California',possessionTeamId:'cal',yardsToGo:10,fieldPosition:{team:'Clemson',teamId:'clemson',yard:3}}),now);
  assert.equal(left.firstDownLine,0);assert.equal(left.goalToGo,true);
});
test('exact goal distance is goal-to-go, and zero-yard positions are retained',()=>{
  const v=footballFieldView(drive({yardsToGo:3,fieldPosition:{team:'California',teamId:'cal',yard:3}}),now);assert.equal(v.goalToGo,true);
  assert.equal(footballFieldView(drive({fieldPosition:{team:'Clemson',teamId:'clemson',yard:0}}),now).lineOfScrimmage,0);
});
test('missing or ambiguous identities never fall back to matching names',()=>{
  for(const footballIdentity of [undefined,{yesTeamId:'same',noTeamId:'same'},{yesTeamId:'',noTeamId:'cal'}]){
    const v=footballFieldView(market({footballIdentity}),now);assert.equal(v.lineOfScrimmage,null);assert.equal(v.firstDownLine,null);assert.equal(v.possession,null);
  }
  assert.equal(footballFieldView(drive({fieldPosition:{team:'Clemson',yard:35}}),now).lineOfScrimmage,null);
});
test('unknown or contradictory field identity suppresses location markers',()=>{
  for(const fieldPosition of [{team:'Clemson',teamId:'other',yard:35},{team:'California',teamId:'clemson',yard:35}])assert.equal(footballFieldView(drive({fieldPosition}),now).lineOfScrimmage,null);
});
test('unverified possession preserves a valid ball location but hides direction and target',()=>{
  for(const patch of [{possessionTeamId:null},{possessionTeamId:'other'},{possessionTeam:'California'}]){
    const v=footballFieldView(drive(patch),now);assert.equal(v.lineOfScrimmage,35);assert.equal(v.direction,null);assert.equal(v.firstDownLine,null);assert.match(v.issue!,/Possession/);
  }
});
test('invalid half-field yards and incomplete down or distance cannot create targets',()=>{
  for(const yard of [-1,51,NaN,Infinity,1.5])assert.equal(footballFieldView(drive({fieldPosition:{team:'Clemson',teamId:'clemson',yard}}),now).lineOfScrimmage,null);
  for(const patch of [{down:null},{down:5},{yardsToGo:null},{yardsToGo:-1},{yardsToGo:101},{yardsToGo:NaN}]){
    const v=footballFieldView(drive(patch),now);assert.equal(v.lineOfScrimmage,35);assert.equal(v.firstDownLine,null);
  }
});
test('45-second report boundary is inclusive and a newer quote does not refresh it',()=>{
  assert.equal(footballFieldView(market({contextUpdatedAt:now-FOOTBALL_FIELD_FRESH_MS}),now).freshness,'fresh');
  const m=market({contextUpdatedAt:now-FOOTBALL_FIELD_FRESH_MS-1,observedAt:now});
  const v=footballFieldView({...m,quoteObservedAt:now} as FootballFieldMarket,now);
  assert.equal(v.freshness,'stale');assert.equal(v.lineOfScrimmage,35);assert.equal(v.reportAgeMs,45001);
});
test('future, missing, invalid, and reversed report times stay unverified',()=>{
  for(const patch of [{contextUpdatedAt:null},{contextUpdatedAt:NaN},{contextUpdatedAt:now+1},{contextUpdatedAt:-1},{observedAt:now+1},{observedAt:now-3000},{observedAt:NaN}]){
    const v=footballFieldView(market(patch),now);assert.equal(v.freshness,'unknown');assert.equal(v.reportAgeMs,null);assert.match(v.ageLabel,/unverified/);
  }
});
test('age advances from the supplied clock without mutating the report',()=>{
  const m=market();assert.equal(footballFieldView(m,now).ageLabel,'Reported 2s ago');assert.equal(footballFieldView(m,now+60_000).ageLabel,'Reported 1m 2s ago');assert.equal(m.contextUpdatedAt,now-2000);
});
test('tennis markets do not receive a football field',()=>{assert.equal(footballFieldView(market({league:'ATP'}),now).supported,false);});
test('rejected current reports override recent retained timestamps while preserving last known markers',()=>{
  for(const status of ['unknown','conflicting','stale'] as const){
    const assessment:FootballAssessment={status,reason:`Explicit ${status} report reason.`,reportTime:now-2000,receiptTime:now-1000,reportAgeMs:2000,receiptAgeMs:1000};
    const v=footballFieldView(market(),now,assessment);
    assert.equal(v.freshness,status);assert.equal(v.lineOfScrimmage,35);assert.equal(v.firstDownLine,42);
    assert.equal(v.issue,assessment.reason);assert.equal(v.ageLabel,'Reported 2s ago');
  }
});
test('an earlier fresh assessment cannot keep markers fresh after their report expires',()=>{
  const assessment:FootballAssessment={status:'fresh',reason:'Verified report.',reportTime:now-2000,receiptTime:now-1000,reportAgeMs:2000,receiptAgeMs:1000};
  assert.equal(footballFieldView(market(),now+60_000,assessment).freshness,'stale');
  assert.equal(footballFieldView(market({contextUpdatedAt:null}),now,assessment).freshness,'unknown');
});
