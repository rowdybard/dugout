import rawReport from '@/data/bot-model-forward-2026-09-23.json';
import type {BotSession} from '@/lib/bot/types';
const report=rawReport as unknown as Omit<typeof rawReport,'session'>&{session:BotSession};
/** A completed, labeled forward observation. Never treated as current session state. */
export async function GET(){
  const reasons=new Map<string,number>();
  for(const d of report.session.decisions)reasons.set(d.reason,(reasons.get(d.reason)??0)+1);
  return Response.json({kind:report.kind,startedAt:report.startedAt,endedAt:report.endedAt,startingCash:report.initialCash,endingEquity:report.estimatedEquity,
    cycles:report.session.cycles,observations:report.samples.length,markets:new Set(report.samples.map(s=>s.slug)).size,scope:report.session.universeSize,
    entries:report.session.executions.filter(e=>e.apply&&e.cashDelta<0).length,closed:report.session.positions.filter(p=>p.status!=='open').length,
    errors:report.errors.length,reasons:[...reasons].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([reason,count])=>({reason,count})),
    providerRateLimits:report.errors.filter(e=>e.message.includes('rate limit. Requests paused')).length,
    localBackoffSkips:report.errors.filter(e=>e.message.includes('requested a pause')).length,
    limitation:'A six-minute MLB forward observation. Provider rate limits interrupted collection; the bot did not obtain enough continuous history to test its trading strategy. No profit conclusion follows from zero trades.'},{headers:{'Cache-Control':'public, max-age=3600'}});
}
