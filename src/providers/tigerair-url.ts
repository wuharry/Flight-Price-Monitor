import type { FlightSearch } from '../types/index.js';
import { searchSchema } from '../validation.js';
export function getBookingUrl(search: FlightSearch): string {
  const input = searchSchema.parse(search);
  const params = new URLSearchParams({
    adult: String(input.adults), children: '0', infant: '0', currencyCode: input.currency,
    languageCode: 'zh-tw', type: input.returnDate ? 'roundTrip' : 'oneWay',
    outbound: `${input.origin}-${input.destination}`, departureDate: input.departureDate,
  });
  if (input.returnDate) {
    params.set('inbound', `${input.destination}-${input.origin}`);
    params.set('returnDate', input.returnDate);
  }
  return `https://booking.tigerairtw.com/?${params}`;
}
