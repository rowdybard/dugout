import { profile } from '@/lib/server/storage';
import { ensureTrading, recentOrders } from '@/lib/server/trading';
import { tradingStatus } from '@/lib/server/trading-service';
export async function GET(req: Request) {
  try {
    const p = await profile(req), state = ensureTrading(p.data);
    const [orders,status] = await Promise.all([recentOrders(p.id),tradingStatus()]);
    return Response.json({profile:p.data,settings:state.settings,automation:state.automation ?? null,orders,status},{headers:{'Cache-Control':'no-store'}});
  } catch(e) {return Response.json({error:e instanceof Error?e.message:'Trading workspace unavailable.'},{status:503});}
}
