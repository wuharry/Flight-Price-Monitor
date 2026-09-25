import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FlightSearch } from './types/index.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const fields = {
  origin: z.string().regex(/^[A-Z]{3}$/),
  destination: z.string().regex(/^[A-Z]{3}$/),
  departureDate: date,
  returnDate: date.optional(),
  adults: z.number().int().min(1).max(9),
  currency: z.literal('TWD').default('TWD'),
};
function validRoute(value: FlightSearch) {
  return value.origin !== value.destination && (!value.returnDate || value.returnDate >= value.departureDate);
}
export const searchSchema = z.object(fields).refine(validRoute, 'Invalid route or return date');
export const watchRuleSchema = z.object({
  userId: z.string().uuid().optional(),
  ...fields,
  id: z.string().min(1),
  provider: z.string().regex(/^[a-z][a-z0-9_-]*$/).default('tigerair'),
  targetPrice: z.number().finite().nonnegative().optional(),
  notifyNewLow: z.boolean().default(true),
  newLowDays: z.number().int().min(1).max(365).default(30),
  dropAmount: z.number().finite().positive().optional(),
  dropPercent: z.number().finite().positive().max(100).optional(),
  enabled: z.boolean().default(true),
}).refine(validRoute, 'Invalid route or return date');
export const priceBasis = 'tigerLight-including-tax-excluding-payment-and-extras-v1' as const;
export function searchKey(input: FlightSearch & { provider: string }): string {
  return createHash('sha256').update(JSON.stringify([
    input.provider, input.origin, input.destination, input.departureDate,
    input.returnDate ?? null, input.adults, input.currency, priceBasis,
  ])).digest('hex');
}
export function todayTaipei(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
}
