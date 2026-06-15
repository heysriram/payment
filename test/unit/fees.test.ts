import { calculateFee } from '../../src/services/fees';

const feePlan = {
  id: 'fp_1',
  name: 'standard',
  percentBps: 200,        // 2%
  fixedPaise: 300,        // ₹3
  intlPercentBps: 350,    // 3.5%
  currency: 'INR',
} as const;

describe('calculateFee', () => {
  it('uses domestic rate for non-international cards', () => {
    expect(calculateFee(10_000, feePlan, false)).toBe(500); // 200 + 300
  });

  it('uses international rate for international cards', () => {
    expect(calculateFee(10_000, feePlan, true)).toBe(650); // 350 + 300
  });

  it('rounds the percentage component to the nearest paisa', () => {
    // 2% of 12345 = 246.9 → rounds to 247, plus 300 fixed = 547
    expect(calculateFee(12_345, feePlan, false)).toBe(547);
  });

  it('caps the fee at the captured amount', () => {
    expect(calculateFee(50, feePlan, false)).toBe(50);
  });

  it('handles zero gracefully', () => {
    expect(calculateFee(0, feePlan, false)).toBe(0);
  });
});
