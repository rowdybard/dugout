import {portfolio} from '@/lib/server/portfolio';
export async function GET(req: Request) {
  try {
    return Response.json(await portfolio(req));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Portfolio unavailable" },
      { status: 503 },
    );
  }
}
export async function POST(req:Request){await req.arrayBuffer();return Response.json({error:'Order entry has been retired. Use the bot controls.'},{status:410});}
