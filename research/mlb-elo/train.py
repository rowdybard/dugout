"""Reproducible, outcome-only MLB Elo research baseline. No market prices or player impacts."""
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime, timezone
import gzip, json, math, hashlib, random
ROOT=Path(__file__).resolve().parent
AS_OF='2026-09-23'
SPLIT='2025-07-01'
GRID=[{'k':k,'homeAdvantage':h,'seasonCarry':0.67} for k in [4,8,16] for h in [15,30,45]]
DESIGN={'grid':GRID,'selectionMetric':'minimum validation Brier; ties log-loss then K then home advantage','warmupSeason':2024,'validationStart':'2025-01-01','validationEndExclusive':SPLIT,'holdoutStart':SPLIT,'holdoutEndExclusive':'2026-01-01','asOfDateExclusive':AS_OF,'sameDayRule':'Predict every game on a date from the same pre-day ratings; accumulate all updates after predictions.','seasonCarry':0.67,'initialRating':1500,'probabilityScale':400,'exclusions':'Not final, not regular season, ties, malformed identity/score/date, any reschedule/resume metadata, conflicting duplicate game IDs.'}
(ROOT/'design.json').write_text(json.dumps(DESIGN,indent=2)+'\n')
manifest=json.loads((ROOT/'sources/manifest.json').read_text())
all_games={}; counts={}; teams={}
for source in manifest:
 raw=gzip.decompress((ROOT/source['file']).read_bytes())
 assert hashlib.sha256(raw).hexdigest()==source['rawSha256']
 data=json.loads(raw); filtered=[]; excluded=Counter(); seen={}
 for day in data['dates']:
  for g in day['games']:
   if g.get('gameType')!='R': excluded['not_regular']+=1; continue
   if g.get('status',{}).get('abstractGameState')!='Final': excluded['not_final']+=1; continue
   if any(g.get(key) for key in ['rescheduleDate','rescheduleGameDate','rescheduledFrom','rescheduledFromDate','resumeDate','resumeGameDate','resumedFrom','resumedFromDate']): excluded['rescheduled_or_resumed']+=1; continue
   date=g.get('officialDate'); a=g.get('teams',{}).get('away',{}); h=g.get('teams',{}).get('home',{})
   aid=a.get('team',{}).get('id'); hid=h.get('team',{}).get('id'); ars=a.get('score'); hrs=h.get('score'); gid=g.get('gamePk')
   if not date or date!=day.get('date') or date>=AS_OF or str(source['year'])!=date[:4] or not all(isinstance(x,int) and not isinstance(x,bool) for x in [aid,hid,ars,hrs,gid]) or aid==hid or min(ars,hrs)<0:
    excluded['malformed_or_cutoff']+=1; continue
   if ars==hrs or g.get('isTie') is True: excluded['tie']+=1; continue
   record={'id':str(gid),'day':date,'away':str(aid),'home':str(hid),'awayRuns':ars,'homeRuns':hrs,'y':int(hrs>ars)}
   if gid in seen:
    if seen[gid]!=record: raise RuntimeError(f'Conflicting duplicate game {gid}')
    excluded['duplicate']+=1; continue
   seen[gid]=record; filtered.append(record)
   for side in [a,h]: teams[str(side['team']['id'])]={'id':str(side['team']['id']),'name':side['team']['name']}
 filtered.sort(key=lambda g:(g['day'],int(g['id'])))
 all_games[source['year']]=filtered
 counts[str(source['year'])]={'scheduleRows':source['scheduleRows'],'acceptedFinalGames':len(filtered),'excluded':dict(excluded),'firstAcceptedDay':filtered[0]['day'] if filtered else None,'lastAcceptedDay':filtered[-1]['day'] if filtered else None}
 if len(filtered)<100: raise RuntimeError('Insufficient historical coverage; do not emit model')


def win_probability(home,away,config): return 1/(1+10**(-(home-away+config['homeAdvantage'])/400))
def play(games,config,ratings=None,carry=False):
 ratings=dict(ratings or {}); rows=[]
 if carry: ratings={team:1500+(rating-1500)*config['seasonCarry'] for team,rating in ratings.items()}
 grouped=defaultdict(list)
 for game in games: grouped[game['day']].append(game)
 for day,gameday in sorted(grouped.items()):
  changes=defaultdict(float)
  for game in gameday:
   h=ratings.get(game['home'],1500); a=ratings.get(game['away'],1500); p=win_probability(h,a,config)
   rows.append({**game,'p':p,'homeRatingBeforeDay':h,'awayRatingBeforeDay':a})
   delta=config['k']*(game['y']-p); changes[game['home']]+=delta; changes[game['away']]-=delta
  for team,delta in changes.items(): ratings[team]=ratings.get(team,1500)+delta
 return ratings,rows

def metrics(rows,constant=None):
 n=len(rows)
 if not n: return None
 ps=[row['p'] if constant is None else constant for row in rows]; ys=[row['y'] for row in rows]
 bins=[]
 for b in range(10):
  values=[(p,y) for p,y in zip(ps,ys) if min(9,int(p*10))==b]
  if values: bins.append({'lower':b/10,'upper':(b+1)/10,'games':len(values),'meanForecast':sum(p for p,y in values)/len(values),'homeWinRate':sum(y for p,y in values)/len(values)})
 return {'games':n,'brier':sum((p-y)**2 for p,y in zip(ps,ys))/n,'logLoss':-sum(y*math.log(max(1e-15,p))+(1-y)*math.log(max(1e-15,1-p)) for p,y in zip(ps,ys))/n,'homeWinRate':sum(ys)/n,'meanForecast':sum(ps)/n,'expectedCalibrationError':sum(b['games']*abs(b['meanForecast']-b['homeWinRate']) for b in bins)/n,'calibrationBins':bins}

warmup=all_games[2024]; season25=all_games[2025]
validation=[g for g in season25 if g['day']<SPLIT]; holdout=[g for g in season25 if g['day']>=SPLIT]
base24=sum(g['y'] for g in warmup)/len(warmup)
candidates=[]
for config in GRID:
 ratings,_=play(warmup,config)
 ratings,rows=play(validation,config,ratings,True)
 candidates.append({'config':config,'validation':metrics(rows)})
selected=min(candidates,key=lambda c:(c['validation']['brier'],c['validation']['logLoss'],c['config']['k'],c['config']['homeAdvantage']))
config=selected['config']
ratings,_=play(warmup,config)
ratings,validation_rows=play(validation,config,ratings,True)
ratings,holdout_rows=play(holdout,config,ratings)
base_holdout=(sum(g['y'] for g in warmup)+sum(g['y'] for g in validation))/(len(warmup)+len(validation))
ratings,season26_rows=play(all_games[2026],config,ratings,True)
base26=sum(g['y'] for g in warmup+season25)/len(warmup+season25)

def report(rows,base):
 result={'model':metrics(rows),'fairCoin':metrics(rows,0.5),'constantHomeWin':{'probabilityFrozenBeforePeriod':base,**metrics(rows,base)}}
 # Paired day bootstrap of score differences; day clusters retain shared day conditions.
 groups=defaultdict(list)
 for row in rows: groups[row['day']].append((row['p']-row['y'])**2-(base-row['y'])**2)
 days=list(groups.values()); rng=random.Random(20260923); estimates=[]
 for _ in range(1000):
  chosen=rng.choices(days,k=len(days)); estimates.append(sum(sum(day) for day in chosen)/sum(len(day) for day in chosen))
 estimates.sort()
 result['brierDifferenceVsHome']={'mean':result['model']['brier']-result['constantHomeWin']['brier'],'dayBootstrap95PercentileInterval':[estimates[24],estimates[974]],'replicates':1000,'seed':20260923,'interpretation':'Negative favors model; this measures outcome forecasts, not trading returns.'}
 return result

artifact={
 'schemaVersion':1,'modelId':'mlb-team-elo-baseline','modelVersion':'mlb-elo-v1-2026-09-23','status':'EXPERIMENTAL_PAPER_ONLY',
 'generatedAt':datetime.now(timezone.utc).isoformat(),'league':'MLB','marketFamily':'FULL_GAME_WINNER','phase':'PREGAME',
 'parameters':{**config,'initialRating':1500,'probabilityScale':400},'ratingsThroughDay':all_games[2026][-1]['day'],'dataCutoffExclusive':AS_OF,
 'teamRatings':{key:{**teams[key],'rating':value} for key,value in sorted(ratings.items(),key=lambda item:int(item[0]))},
 'design':DESIGN,'sources':manifest,'recordCounts':counts,'selection':{'selected':selected,'candidates':candidates,'usedHoldoutForSelection':False},
 'validation':{'start':validation[0]['day'],'end':validation[-1]['day'],'model':metrics(validation_rows),'fairCoin':metrics(validation_rows,0.5),'constantHomeWin':{'probabilityFrozenBeforePeriod':base24,**metrics(validation_rows,base24)}},
 'holdout':{'start':holdout[0]['day'],'end':holdout[-1]['day'],**report(holdout_rows,base_holdout)},
 'later2026':{'start':season26_rows[0]['day'],'end':season26_rows[-1]['day'],**report(season26_rows,base26)},
 'limitations':['Outcome-only team strength; no starting pitcher, lineup, bullpen, injury, weather, park or player features.','Home advantage uses scheduled home identity; neutral and international sites are not modeled separately.','Retrospective final schedule responses are not archived point-in-time publication records; rescheduled/resumed games are excluded conservatively.','Predicts all games on a source calendar date before any updates from that date.','A new season regresses ratings 33% toward 1500; this is fixed design, not learned from holdout.','Brier/log-loss comparisons are forecast evaluation, not profitability or performance versus market prices.','No Polymarket price alignment or historical trading-cost backtest is present.','Use only for experimental paper decisions; missing player impact remains a separate entry veto.']}
serialized=json.dumps(artifact,indent=2,sort_keys=True)+'\n'
(ROOT/'model.json').write_text(serialized)
(ROOT/'normalized-games.json').write_text(json.dumps({str(k):v for k,v in all_games.items()},separators=(',',':'))+'\n')
(ROOT/'holdout-predictions.json').write_text(json.dumps({'holdout2025':holdout_rows,'later2026':season26_rows},separators=(',',':'))+'\n')
print(json.dumps({'selected':config,'counts':counts,'holdout':artifact['holdout'],'later2026':artifact['later2026'],'modelSha256':hashlib.sha256(serialized.encode()).hexdigest()},indent=2))
