import { z } from 'zod';
import type { FlightLeg, FlightPriceResult, FlightSearch } from '../types/index.js';
import { priceBasis, searchSchema } from '../validation.js';
import { getBookingUrl } from './tigerair-url.js';

const amount = z.number().finite().nonnegative();
const ticket = z.object({
  userCurrency: z.string(), taxAmount: amount,
  discountedTotalAmountWithoutTax: amount, discountedTotalAmount: amount,
});
const resultSchema = z.object({
  data: z.object({ appFlightSearchResult: z.object({
    flightType: z.enum(['oneWay', 'roundTrip']),
    journeys: z.array(z.object({ legs: z.array(z.object({
      origin: z.string(), destination: z.string(), departureDate: z.string(),
      availabilityLegs: z.array(z.object({
        origin: z.string(), destination: z.string(),
        availabilitySegments: z.array(z.object({
          origin: z.string(), destination: z.string(),
          departureTime: z.string(), arrivalTime: z.string(),
          carrierCode: z.string(), flightNumber: z.string(),
        })),
        fares: z.array(z.object({
          sellable: z.boolean(), availableCount: z.number().int().nonnegative(), productClass: z.string(),
          paxFares: z.array(z.object({ paxType: z.string(), ticketPrice: ticket })),
        })),
      })),
    })) })),
  }) }),
});
export const money = (value: number) => Math.round(value * 100) / 100;

export function parseTigerairResponse(body: unknown, search: FlightSearch, checkedAt = new Date().toISOString()): FlightPriceResult {
  const input = searchSchema.parse(search);
  if (body && typeof body === 'object' && 'errors' in body &&
      Array.isArray(body.errors) && body.errors.length) throw new Error('Tigerair GraphQL returned errors');
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) throw new Error('Tigerair fare response schema changed or is incomplete');
  const result = parsed.data.data.appFlightSearchResult;
  if (result.flightType !== (input.returnDate ? 'roundTrip' : 'oneWay')) throw new Error('Flight type mismatch');
  const expected = [{ origin: input.origin, destination: input.destination, date: input.departureDate },
    ...(input.returnDate ? [{ origin: input.destination, destination: input.origin, date: input.returnDate }] : [])];
  if (result.journeys.length !== expected.length) throw new Error('Missing flight journey');
  const choices = expected.map((route, index) => {
    const legs = result.journeys[index].legs.filter(leg =>
      leg.origin === route.origin && leg.destination === route.destination && leg.departureDate === route.date);
    const options: FlightLeg[] = [];
    for (const leg of legs) for (const available of leg.availabilityLegs) {
      // First version compares direct tigerLight flights only.
      if (available.origin !== route.origin || available.destination !== route.destination || available.availabilitySegments.length !== 1) continue;
      const segment = available.availabilitySegments[0];
      if (segment.origin !== route.origin || segment.destination !== route.destination ||
          !segment.departureTime.startsWith(route.date + ' ') ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(segment.arrivalTime)) continue;
      for (const fare of available.fares) {
        if (!fare.sellable || fare.availableCount < input.adults || fare.productClass !== 'tigerLight') continue;
        const adult = fare.paxFares.find(pax => pax.paxType === 'ADT');
        if (!adult) continue;
        const price = adult.ticketPrice;
        if (price.userCurrency !== input.currency) throw new Error('Fare currency mismatch');
        if (Math.abs(money(price.discountedTotalAmountWithoutTax + price.taxAmount) - price.discountedTotalAmount) > 0.011) {
          throw new Error('Fare total does not reconcile with tax');
        }
        if (price.discountedTotalAmount <= 0) throw new Error('Invalid zero fare total');
        options.push({
          origin: route.origin, destination: route.destination, departureTime: segment.departureTime,
          arrivalTime: segment.arrivalTime, flightNumber: segment.carrierCode + segment.flightNumber.trim(),
          fare: money(price.discountedTotalAmountWithoutTax * input.adults),
          tax: money(price.taxAmount * input.adults),
          total: money(price.discountedTotalAmount * input.adults),
        });
      }
    }
    if (!options.length) throw new Error(`No sellable direct tigerLight fare: ${route.origin}-${route.destination} ${route.date}`);
    return options.sort((a, b) => a.total - b.total);
  });
  let selected: FlightLeg[] | undefined;
  for (const outbound of choices[0]) {
    if (!input.returnDate) { selected = [outbound]; break; }
    // Both times are local to the destination airport.
    for (const inbound of choices[1]) {
      if (inbound.departureTime <= outbound.arrivalTime) continue;
      if (!selected || outbound.total + inbound.total < selected[0].total + selected[1].total) selected = [outbound, inbound];
    }
  }
  if (!selected) throw new Error('No chronological round-trip itinerary available');
  return { ...input, provider: 'tigerair', outboundPrice: selected[0].fare, inboundPrice: selected[1]?.fare,
    taxAndFees: money(selected.reduce((sum, leg) => sum + leg.tax, 0)),
    totalPrice: money(selected.reduce((sum, leg) => sum + leg.total, 0)),
    checkedAt, bookingUrl: getBookingUrl(input), priceBasis, legs: selected };
}
