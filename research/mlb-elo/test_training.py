import unittest, importlib.util, contextlib, io
from pathlib import Path
with contextlib.redirect_stdout(io.StringIO()):
 spec=importlib.util.spec_from_file_location('train',Path(__file__).with_name('train.py')); train=importlib.util.module_from_spec(spec);spec.loader.exec_module(train)
class Chronology(unittest.TestCase):
 def test_doubleheader_uses_same_pre_day_ratings(self):
  games=[{'id':'1','day':'2025-04-01','home':'1','away':'2','y':1},{'id':'2','day':'2025-04-01','home':'1','away':'2','y':0}]
  _,rows=train.play(games,{'k':4,'homeAdvantage':30,'seasonCarry':.67})
  self.assertEqual(rows[0]['p'],rows[1]['p'])
  self.assertEqual(rows[0]['homeRatingBeforeDay'],rows[1]['homeRatingBeforeDay'])
 def test_future_outcomes_cannot_change_earlier_predictions(self):
  games=[{'id':'1','day':'2025-04-01','home':'1','away':'2','y':1},{'id':'2','day':'2025-04-02','home':'1','away':'2','y':0}]
  cfg={'k':4,'homeAdvantage':30,'seasonCarry':.67}; _,first=train.play(games,cfg)
  _,second=train.play([*games,{'id':'3','day':'2025-04-03','home':'1','away':'2','y':1}],cfg)
  self.assertEqual(first,second[:2])
 def test_holdout_was_not_used_for_parameter_selection(self):
  self.assertTrue(all(row['day']<train.SPLIT for row in train.validation))
  self.assertTrue(all(row['day']>=train.SPLIT for row in train.holdout))
  self.assertFalse(train.artifact['selection']['usedHoldoutForSelection'])
 def test_actual_record_dates_never_include_current_day(self):
  self.assertTrue(all(g['day']<train.AS_OF for games in train.all_games.values() for g in games))
if __name__=='__main__': unittest.main()
