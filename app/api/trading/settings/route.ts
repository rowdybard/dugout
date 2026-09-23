import { z } from 'zod';
import { profile, saveProfile, sameOrigin } from '@/lib/server/storage';
import { DEFAULT_TRADING_SETTINGS } from '@/lib/trading/workspace';

export async function PATCH(req: Request) {
  try {
    sameOrigin(req);
    const data = z.object({
      entryPresets: z.array(z.number().finite().min(1).max(10000)).min(1).max(6),
      exitPresets: z.array(z.number().finite().min(1).max(100)).min(1).max(5).refine(a => a.includes(100), 'Keep a 100% exit preset.'),
      maxPriceDrift: z.number().finite().min(0).max(.1),
    }).strict().parse(await req.json());
    const p = await profile(req);
    p.data.trading ??= { settings: DEFAULT_TRADING_SETTINGS };
    p.data.trading.settings = data;
    await saveProfile(p);
    return Response.json({ settings: data });
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'Could not save presets.'}, {status: 400});
  }
}
