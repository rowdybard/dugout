/** Internal money, price and quantity precision: six decimals. No BigInts leave JSON boundaries. */
export const SCALE = BigInt(1_000_000);
const ZERO = BigInt(0);
const TWO = BigInt(2);
const CENT = BigInt(10_000);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function toUnits(value: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError('Expected a finite decimal.');
  const scaled = value * Number(SCALE);
  const rounded = Math.round(scaled);
  // Tolerance scales with magnitude: 271789.34 * 1e6 is 271789339999.99997 in binary floating point.
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > Math.max(0.00001, Math.abs(scaled) * 1e-13)) {
    throw new RangeError('Decimal exceeds supported six-place precision or range.');
  }
  return BigInt(rounded);
}

export function fromUnits(value: bigint): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) throw new RangeError('Value exceeds safe JSON range.');
  return Number(value) / Number(SCALE);
}

/** Round exact integer ratios, including exact half-cent ties, to even. */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new RangeError('Positive denominator required.');
  const sign = numerator < ZERO ? BigInt(-1) : BigInt(1);
  const absolute = numerator * sign;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const comparison = remainder * TWO - denominator;
  return sign * (quotient + (comparison > ZERO || (comparison === ZERO && quotient % TWO !== ZERO) ? BigInt(1) : ZERO));
}

export function notionalUnits(quantity: bigint, price: bigint): bigint {
  return roundHalfEven(quantity * price, SCALE);
}

/** Exact numerator for theta * quantity * price * (1-price), in scale^4 dollars. */
export function feeNumerator(quantity: bigint, price: bigint, coefficient: bigint): bigint {
  return quantity * price * (SCALE - price) * coefficient;
}

/** Published taker cent rounding. Depth aggregation is an estimate of actual counterparty fills. */
export function roundedFeeUnits(exactNumerator: bigint): bigint {
  return roundHalfEven(exactNumerator, SCALE * SCALE * SCALE * SCALE / BigInt(100)) * CENT;
}

export function feeUnits(quantity: bigint, price: bigint, coefficient: bigint): bigint {
  return roundedFeeUnits(feeNumerator(quantity, price, coefficient));
}

export function floorToIncrement(quantity: bigint, increment: bigint): bigint {
  if (increment <= ZERO || quantity < ZERO) throw new RangeError('Invalid quantity increment.');
  return quantity / increment * increment;
}

/** Largest allowed size whose protected worst-price notional plus fees fits the cash ceiling. */
export function quantityForBudget(budget: bigint, price: bigint, increment: bigint, coefficient: bigint): bigint {
  if (budget <= ZERO || price <= ZERO || increment <= ZERO) return ZERO;
  let low = ZERO;
  let high = budget * SCALE / price / increment;
  while (low < high) {
    const middle = (low + high + BigInt(1)) / TWO;
    const quantity = middle * increment;
    const cost = notionalUnits(quantity, price) + feeUnits(quantity, price, coefficient);
    if (cost <= budget) low = middle;
    else high = middle - BigInt(1);
  }
  return low * increment;
}

export function roundPriceToIncrement(price: number, increment: number, direction: 'UP' | 'DOWN'): number {
  const value = toUnits(price);
  const step = toUnits(increment);
  if (step <= ZERO) throw new RangeError('Invalid price increment.');
  const rounded = direction === 'UP' ? (value + step - BigInt(1)) / step * step : value / step * step;
  return fromUnits(rounded);
}
