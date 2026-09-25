from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from datetime import datetime, timezone
import urllib.request, json, gzip, hashlib
ROOT=Path(__file__).resolve().parent
SOURCES=[(2024,'https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2024&gameType=R'),(2025,'https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2025&gameType=R'),(2026,'https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2026&gameType=R&startDate=2026-01-01&endDate=2026-09-22')]
def fetch(item):
 year,url=item; path=ROOT/'sources'/f'mlb-schedule-{year}.json.gz'
 with urllib.request.urlopen(url,timeout=30) as response: raw=response.read()
 parsed=json.loads(raw)
 if not isinstance(parsed.get('dates'),list): raise RuntimeError('Unexpected official response shape')
 path.write_bytes(gzip.compress(raw,mtime=0))
 rows=[g for d in parsed['dates'] for g in d['games']]
 meta={'year':year,'url':url,'retrievedAt':datetime.now(timezone.utc).isoformat(),'rawSha256':hashlib.sha256(raw).hexdigest(),'rawBytes':len(raw),'scheduleRows':len(rows),'declaredTotalGames':parsed.get('totalGames'),'file':str(path.relative_to(ROOT))}
 print(json.dumps(meta),flush=True)
 print('FIELDS',year,sorted(set(k for g in rows for k in g)),flush=True)
 return meta
with ThreadPoolExecutor(max_workers=3) as pool: metadata=list(pool.map(fetch,SOURCES))
(ROOT/'sources'/'manifest.json').write_text(json.dumps(metadata,indent=2)+'\n')
