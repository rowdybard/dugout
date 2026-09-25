import { getIntelligenceStatus } from '@/lib/intelligence/status';

export async function GET() {
  const status=getIntelligenceStatus(Date.now(),{
    label:'Players, stats & availability',state:'partial',lastReceivedAt:null,
    detail:'Free MLB Stats API and ESPN adapters are implemented for per-game statistics, pitcher/QB changes and reported injuries. Each game reports its own availability and source timestamps; complete confirmed lineups and breaking-injury coverage are not guaranteed.',
  });
  status.blockingReasons[0]='Verify source coverage and freshness for each game before using its player context for predictions.';
  return Response.json(status, { headers: { 'Cache-Control': 'no-store' } });
}
