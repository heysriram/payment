import { FeePlan } from '@prisma/client';

export function calculateFee(
  amount: number,
  feePlan: FeePlan,
  isInternational: boolean
): number {
  // Use intl rate for international cards — simplified for now
  const bps = isInternational ? feePlan.intlPercentBps : feePlan.percentBps;

  const percentageFee = Math.round((amount * bps) / 10000);
  const totalFee = percentageFee + feePlan.fixedPaise;

  // Fee cannot exceed the payment amount
  return Math.min(totalFee, amount);
}
