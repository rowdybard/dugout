import { sameOrigin } from '@/lib/server/storage';
import { orderRequest, placePaperOrder } from '@/lib/server/trading';
export async function POST(req: Request) {
  try { sameOrigin(req); return Response.json(await placePaperOrder(req, orderRequest.parse(await req.json())), {headers: {'Cache-Control':'no-store'}}); }
  catch(e) { return Response.json({error:e instanceof Error?e.message:'Order could not be processed.'},{status:400}); }
}
