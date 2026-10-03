import type {TennisPosition} from './types';

/** Remaining purchase cost per share includes buy fees; a sale can incur further fees. */
export function purchaseAverageWithFees(position:Pick<TennisPosition,'quantity'|'costBasis'>):number|null{
  return Number.isFinite(position.quantity)&&position.quantity>0&&Number.isFinite(position.costBasis)&&position.costBasis>=0
    ?position.costBasis/position.quantity:null;
}
