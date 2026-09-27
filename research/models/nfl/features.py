"""Pre-snap NFL game-state features from nflverse play-by-play, from the HOME team's perspective.

Leakage rules (verified against nflverse columns):
  - home_score/away_score in nflverse are FINAL scores -> never used as state.
  - posteam_score/defteam_score are pre-play -> mapped to home/away; forward-filled over rows
    without a possession team (timeouts, quarter ends).
  - Every feature describes the situation before the snap of that row's play.
The same feature definitions must be ported to TypeScript for live use (Step 8).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

PBP_COLUMNS = ["game_id", "season", "season_type", "week", "play_id", "time_of_day", "home_team", "away_team",
               "posteam", "defteam", "qtr", "game_seconds_remaining", "half_seconds_remaining", "down", "ydstogo",
               "yardline_100", "posteam_score", "defteam_score", "posteam_timeouts_remaining",
               "defteam_timeouts_remaining", "play_type", "home_score", "away_score", "result", "spread_line",
               "total_line", "home_wp", "vegas_home_wp", "wpa", "desc"]

FEATURES = ["score_diff", "abs_score_diff", "game_seconds_remaining", "half_seconds_remaining", "second_half",
            "overtime", "home_poss", "no_poss", "down", "ydstogo", "home_yardline", "poss_yardline_100",
            "home_timeouts", "away_timeouts", "spread_line", "spread_time", "spread_remaining", "total_line",
            "diff_time_ratio", "home_receives_2h_ko", "goal_to_go", "red_zone"]


def build(pbp: pd.DataFrame) -> pd.DataFrame:
    df = pbp.copy()
    df = df.sort_values(["game_id", "play_id"]).reset_index(drop=True)
    home_poss = df.posteam == df.home_team
    away_poss = df.posteam == df.away_team
    home_pre = np.where(home_poss, df.posteam_score, np.where(away_poss, df.defteam_score, np.nan))
    away_pre = np.where(home_poss, df.defteam_score, np.where(away_poss, df.posteam_score, np.nan))
    df["home_score_pre"] = pd.Series(home_pre).groupby(df.game_id).ffill().fillna(0).values
    df["away_score_pre"] = pd.Series(away_pre).groupby(df.game_id).ffill().fillna(0).values
    df["score_diff"] = df.home_score_pre - df.away_score_pre
    df["abs_score_diff"] = df.score_diff.abs()
    df["second_half"] = (df.qtr >= 3).astype(int)
    df["overtime"] = (df.qtr >= 5).astype(int)
    df["home_poss"] = home_poss.astype(int)
    df["no_poss"] = (~home_poss & ~away_poss).astype(int)
    df["poss_yardline_100"] = df.yardline_100
    # Distance from the home team's own goal line (100 = at the opponent goal line), neutral 50 without possession.
    df["home_yardline"] = np.where(home_poss, 100 - df.yardline_100, np.where(away_poss, df.yardline_100, 50))
    df["home_timeouts"] = np.where(home_poss, df.posteam_timeouts_remaining, df.defteam_timeouts_remaining)
    df["away_timeouts"] = np.where(home_poss, df.defteam_timeouts_remaining, df.posteam_timeouts_remaining)
    df["spread_line"] = df.spread_line.fillna(0)  # nflverse: positive = home favoured by that many points
    gsr = df.game_seconds_remaining.clip(lower=0)
    df["spread_time"] = df.spread_line * np.exp(-4 * (3600 - gsr.clip(upper=3600)) / 3600)
    df["spread_remaining"] = df.spread_line * gsr.clip(upper=3600) / 3600
    # Game total: higher-scoring expectations make leads less safe. Missing (pre-2006 some games) -> league median.
    df["total_line"] = df.total_line.fillna(44.0) if "total_line" in df else 44.0
    df["diff_time_ratio"] = df.score_diff / np.sqrt(gsr + 60)
    df["goal_to_go"] = ((df.yardline_100 <= df.ydstogo) & df.down.notna()).astype(int)
    df["red_zone"] = (df.yardline_100 <= 20).astype(int)
    # Opening kickoff receiver = possession team on the first kickoff; the other team receives the 2nd half.
    first_ko = df[df.play_type == "kickoff"].groupby("game_id").posteam.first()
    df["home_receives_2h_ko"] = (df.game_id.map(first_ko) == df.away_team).astype(int)
    final_home = df.groupby("game_id").home_score.transform("max")
    final_away = df.groupby("game_id").away_score.transform("max")
    df["home_win"] = np.where(final_home > final_away, 1.0, np.where(final_home < final_away, 0.0, 0.5))
    df["t"] = pd.to_datetime(df.time_of_day, utc=True, format="ISO8601", errors="coerce")
    return df
