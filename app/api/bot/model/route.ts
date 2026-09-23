import model from '@/data/models/mlb-elo-2026-09-23.json';
/** Measured historical outcome evaluation, separate from trading performance. */
export async function GET(){
  return Response.json({
    version:model.modelVersion,ratingsThrough:model.ratingsThroughDay,generatedAt:model.generatedAt,
    holdout:{games:model.holdout.model.games,brier:model.holdout.model.brier,baseline:model.holdout.constantHomeWin.brier,interval:model.holdout.brierDifferenceVsHome.dayBootstrap95PercentileInterval},
    later:{games:model.later2026.model.games,brier:model.later2026.model.brier,baseline:model.later2026.constantHomeWin.brier},
    purpose:'Experimental pregame outcome filter. It does not predict short-term rebounds or establish profitable trading.',
    limitations:['Team results only; no numerical pitcher, lineup, injury or weather adjustments.','The 2025 holdout improvement is statistically uncertain.','No comparison against historical executable Polymarket prices.','Ratings older than three days block new entries until the model is refreshed.'],
  },{headers:{'Cache-Control':'public, max-age=3600'}});
}
