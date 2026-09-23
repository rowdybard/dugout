import { tradingStatus } from '@/lib/server/trading-service';
export async function GET() {
  return Response.json(await tradingStatus(), { headers: { 'Cache-Control': 'no-store' } });
}
