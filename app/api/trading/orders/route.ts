import { sameOrigin } from '@/lib/server/storage';
import { orderRequest, placePaperOrder } from '@/lib/server/trading';
import { ZodError } from 'zod';
export async function POST(req: Request) {
  try { sameOrigin(req); return Response.json(await placePaperOrder(req, orderRequest.parse(await req.json())), {headers: {'Cache-Control':'no-store'}}); }
  catch(e) {
    // A storage/read failure can happen after a committed fill. Keep the original
    // command pending on the client so recovery reuses its ID instead of spending twice.
    const invalid=e instanceof ZodError || (e instanceof Error && e.message==='Request origin mismatch.');
    return Response.json({error:e instanceof Error?e.message:'Order response is uncertain. Reconcile this command.'},{status:invalid?400:503});
  }
}
