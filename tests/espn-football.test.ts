import test from 'node:test';
import assert from 'node:assert/strict';
import {espnFootballMapping,normalizeEspnFootballReport} from '../lib/tennis/espn-football.ts';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {espnSummary,FOOTBALL_FEED_NOW as NOW,montanaMarket,nativeFootballEvent} from './helpers/football-feed-fixture.ts';

const mapping=()=>{const result=espnFootballMapping(montanaMarket());assert.ok(result);return result;};
const normalize=(value=espnSummary())=>normalizeEspnFootballReport(value,mapping(),NOW);

test('fallback mapping is pinned to the reviewed event, teams, outcome order and exact kickoff',()=>{
  const market=montanaMarket();assert.equal(mapping().eventId,'401868094');
  for(const changed of [{eventId:'117782'},{eventSlug:'other-game'},{slug:'other-winner'},{startTime:'2026-10-03T02:31:00Z'},{league:'NFL' as const},{yesName:'Montana'},{yesOrdering:'home' as const},{footballIdentity:{yesTeamId:'1109',noTeamId:'1110'}}])assert.equal(espnFootballMapping({...market,...changed}),null);
});
test('one verified summary yields canonical drive identities and original source clocks without using ESPN game clock',()=>{
  const raw=espnSummary(),result=normalize(raw);
  assert.equal(result.status,'drive');assert.equal(result.score,'10-7');assert.equal(result.period,'Q1');
  assert.deepEqual(result.football,{possessionTeam:'Idaho',possessionTeamId:'1109',down:4,yardsToGo:1,fieldPosition:{team:'Montana State',teamId:'1110',yard:27},timeouts:[]});
  assert.deepEqual(result.provenance,{eventId:'401868094',driveId:'40186809410',playId:'401868094161',sequence:38,reportTime:NOW-1000,playWallclock:NOW-1000,metaUpdatedAt:NOW-1000,receivedAt:NOW});
  raw.header.competitions[0].status.displayClock='0:00';raw.drives.current.plays[0].clock.displayValue='unverified';
  assert.deepEqual(normalize(raw),result);
});
test('YES-home ordering and both possession directions retain away-home scores and correct field territory',()=>{
  const market=montanaMarket(),flipped={...market,yesName:'Idaho',noName:'Montana State',yesOrdering:'home' as const,footballIdentity:{yesTeamId:'1109',noTeamId:'1110'}},map=espnFootballMapping(flipped);assert.ok(map);
  for(const [team,homeAway,yardsToEndzone,expectedTeam,expectedYard] of [['70','home',62,'Idaho',38],['147','away',62,'Montana State',38],['147','away',27,'Idaho',27],['70','home',50,'Idaho',50]] as const){
    const raw=espnSummary(),play=raw.drives.current.plays[0];raw.drives.current.team.id=team;play.start.team.id=team;play.end.team.id=team;
    play.end.yardsToEndzone=yardsToEndzone;play.end.yardLine=homeAway==='home'?100-yardsToEndzone:yardsToEndzone;
    const result=normalizeEspnFootballReport(raw,map,NOW);assert.equal(result.status,'drive');assert.equal(result.score,'10-7');
    assert.equal(result.football?.fieldPosition?.team,expectedTeam);assert.equal(result.football?.fieldPosition?.yard,expectedYard);
    assert.equal(result.football?.possessionTeamId,team==='70'?'1109':'1110');
  }
});
test('wrong summary identity, kickoff, home-away mapping, final state and mismatched play scores or period are unavailable',()=>{
  const changes=[(r:ReturnType<typeof espnSummary>)=>{r.header.id='other';},(r:ReturnType<typeof espnSummary>)=>{r.header.competitions[0].date='2026-10-03T03:30Z';},(r:ReturnType<typeof espnSummary>)=>{r.header.competitions[0].competitors[0].team.id='147';},(r:ReturnType<typeof espnSummary>)=>{r.header.competitions[0].competitors[0].homeAway='away';},(r:ReturnType<typeof espnSummary>)=>{r.header.competitions[0].status.type.state='post';},(r:ReturnType<typeof espnSummary>)=>{r.drives.current.plays[0].awayScore=11;},(r:ReturnType<typeof espnSummary>)=>{r.drives.current.plays[0].period.number=2;}];
  for(const change of changes){const raw=espnSummary();change(raw);const result=normalize(raw);assert.equal(result.status,'unavailable');assert.equal(result.football,null);}
});
test('special plays, scores and possession changes never become a tradable drive',()=>{
  for(const kind of ['Kickoff','Punt','Field Goal Good','Extra Point Good','Interception Return','Fumble Recovery','Penalty','Timeout']){
    const raw=espnSummary();raw.drives.current.plays[0].type.text=kind;assert.equal(normalize(raw).status,'transition',kind);
  }
  const score=espnSummary();score.drives.current.plays[0].scoringPlay=true;assert.equal(normalize(score).status,'transition');
  const turnover=espnSummary();turnover.drives.current.plays[0].end.team.id='147';assert.equal(normalize(turnover).status,'transition');
  const text=espnSummary();text.drives.current.plays[0].text='Pass completed, PENALTY nullifies the play.';assert.equal(normalize(text).status,'transition');
  const terminal={...espnSummary(),drives:{current:{...espnSummary().drives.current,result:'PUNT'}}};assert.equal(normalize(terminal).status,'transition');
  const endedDrive={...espnSummary(),drives:{current:{...espnSummary().drives.current,end:{period:{number:1}}}}};assert.equal(normalize(endedDrive).status,'transition');
  for(const flag of ['isTurnover','isPenalty']){
    const raw=espnSummary(),flagged={...raw,drives:{current:{...raw.drives.current,plays:[{...raw.drives.current.plays[0],[flag]:true}]}}};assert.equal(normalize(flagged).status,'transition',flag);
  }
  const failedFourth=espnSummary();failedFourth.drives.current.plays[0].start.down=4;assert.equal(normalize(failedFourth).status,'transition');
  failedFourth.drives.current.plays[0].end.down=1;assert.equal(normalize(failedFourth).status,'drive');
  for(const ytd of [0,100]){const raw=espnSummary();raw.drives.current.plays[0].end.yardsToEndzone=ytd;raw.drives.current.plays[0].end.yardLine=100-ytd;assert.equal(normalize(raw).status,'transition');}
});
test('incomplete end state, ambiguous ordering and older current-drive play cannot authorize a drive',()=>{
  for(const change of [(r:ReturnType<typeof espnSummary>)=>{r.drives.current.plays[0].end.down=0;},(r:ReturnType<typeof espnSummary>)=>{r.drives.current.plays[0].end.yardLine=27;},(r:ReturnType<typeof espnSummary>)=>{r.drives.current.plays[0].sequenceNumber='not-a-sequence';},(r:ReturnType<typeof espnSummary>)=>{r.meta.lastPlayWallClock=new Date(NOW).toISOString();},(r:ReturnType<typeof espnSummary>)=>{r.drives.current.plays.unshift(structuredClone(r.drives.current.plays[0]));}]){
    const raw=espnSummary();change(raw);assert.equal(normalize(raw).status,'unavailable');
  }
});
test('missing, future and nonnumeric timestamps are unavailable; old or earlier meta stamps are never refreshed by receipt',()=>{
  for(const stamp of ['', 'bad',new Date(NOW+1).toISOString()]){const raw=espnSummary();raw.meta.lastUpdatedAt=stamp;assert.equal(normalize(raw).status,'unavailable');}
  const raw=espnSummary(NOW-87_000),result=normalize(raw);assert.equal(result.status,'drive');assert.equal(result.provenance.reportTime,NOW-87_000);
  raw.meta.lastUpdatedAt=new Date(NOW-90_000).toISOString();assert.equal(normalize(raw).provenance.reportTime,NOW-90_000);
  raw.meta.lastUpdatedAt=new Date(NOW-500).toISOString();assert.equal(normalize(raw).provenance.reportTime,NOW-87_000);
});

test('native Penn State and Pittsburgh drive reports keep their explicit teams, score, clock and final-state guard',()=>{
  for(const game of ['penn','pitt'] as const){
    const raw=nativeFootballEvent(game),reportAt=Date.parse(raw.eventState.updatedAt),market=normalizeTennisEvent(raw,'CFB',reportAt+1000)[0],penn=game==='penn';
    assert.ok(market);assert.equal(market.eventId,penn?'117782':'117781');assert.equal(market.yesOrdering,'away');
    assert.deepEqual(market.footballIdentity,{yesTeamId:penn?'1132':'1089',noTeamId:penn?'1131':'1092'});
    assert.deepEqual(market.football,{possessionTeam:penn?'Penn State':'Pittsburgh',possessionTeamId:penn?'1132':'1089',down:1,yardsToGo:10,
      fieldPosition:{team:penn?'Penn State':'Pittsburgh',teamId:penn?'1132':'1089',yard:penn?50:20},timeouts:[{team:penn?'Penn State':'Pittsburgh',remaining:0},{team:penn?'Northwestern':'Virginia Tech',remaining:1}]});
    assert.equal(market.contextUpdatedAt,reportAt);assert.equal(market.score,penn?'13-34':'35-33');assert.equal(market.period,penn?'Q4':'FT');assert.equal(market.clock,penn?'1:34':null);
    assert.equal(market.active,penn);assert.equal(market.ended,!penn);assert.equal(espnFootballMapping(market),null);
    const changed=structuredClone(raw);changed.eventState.footballState.driveState.possessionTeamId='unmapped';
    assert.equal(normalizeTennisEvent(changed,'CFB',reportAt+1000)[0].football?.possessionTeamId,null);
  }
});
