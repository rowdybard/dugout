import { getFeed } from '@/lib/server/ingestion';
import { getSportsContext } from '@/lib/sports-context/server';

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug || !/^[a-zA-Z0-9_.-]{1,250}$/.test(slug)) return Response.json({ error: 'Choose a valid MLB or NFL market.' }, { status: 400 });
  try {
    const feed = await getFeed();
    const game = feed.games.find(game => game.markets.some(market => market.slug === slug));
    const market = game?.markets.find(market => market.slug === slug);
    if (!market || !game) return Response.json({ error: 'This MLB or NFL market is not in the current feed.' }, { status: 404 });
    const context = await getSportsContext({ ...market, teams: game.teams });
    return Response.json(context, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return Response.json({ error: 'Sports context is unavailable. Try again shortly.' }, { status: 503 }); }
}
