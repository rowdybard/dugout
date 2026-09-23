"""Capture real US API responses for explicitly labeled local development replay. Never used in production."""
import urllib.request, json, concurrent.futures, time, pathlib
ROOT='https://gateway.polymarket.us'
def get(path):
 with urllib.request.urlopen(ROOT+path,timeout=25) as r:return json.load(r)
result={'recordedAt':int(time.time()*1000),'leagues':{},'markets':{}}
for league in ['mlb','nfl']:
 data=get('/v2/leagues/'+league+'/events?type=sport&limit=4&offset=0')
 # Reduce embedded duplicate metadata, preserving documented fields only.
 for e in data['events']:
  e['teams']=[{k:t.get(k) for k in ['id','name','abbreviation','displayAbbreviation','record']} for t in e.get('teams',[])]
  e['markets']=[m for m in e.get('markets',[]) if m.get('sportsMarketType','').endswith('full_game_winner')]
  for m in e['markets']:
   m['marketSides']=[{k:s.get(k) for k in ['long','description','quote']} for s in m.get('marketSides',[])]
 result['leagues'][league]=data
slugs=[m['slug'] for d in result['leagues'].values() for e in d['events'] for m in e['markets']]
def fetch_market(slug):
 try:
  data={'bbo':get('/v1/markets/'+slug+'/bbo'),'book':get('/v1/markets/'+slug+'/book'),'history':{}}
  for r,f in [('1h',1),('6h',1),('24h',5),('ALL',180)]:
   interval={'1h':'INTERVAL_1H','6h':'INTERVAL_6H','24h':'INTERVAL_1D','ALL':'INTERVAL_ALL'}[r]
   data['history'][interval]=get('/v1/price-history?symbol='+slug+'&fixedInterval='+interval+'&fidelity='+str(f))
  return slug,data
 except Exception as e:return slug,{'error':str(e)}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 for slug,d in pool.map(fetch_market,slugs):
  result['markets'][slug]=d;print(slug,'error' if 'error' in d else str(len(d['history']['INTERVAL_1H']['history']))+' history points',flush=True)
pathlib.Path('development-fixtures/us-api.json').write_text(json.dumps(result,separators=(',',':')))
print('Saved real API capture',result['recordedAt'])
