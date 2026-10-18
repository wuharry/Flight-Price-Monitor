import type { FlightSearch } from '../types/index.js';
import { searchSchema } from '../validation.js';

// Public Google Flights URL format, documented by the MIT-licensed fast-flights
// maintainer: github.com/AWeirdDev/flights/blob/dev/fast_flights/pb/flights.proto.
// No private RPC, authenticated request, or Google API key is used.
function integer(value: number): Buffer {
  const bytes: number[] = [];
  do { const low = value & 127; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function number(field: number, value: number) { return Buffer.concat([integer(field * 8), integer(value)]); }
function bytes(field: number, value: Buffer) { return Buffer.concat([integer(field * 8 + 2), integer(value.length), value]); }
function string(field: number, value: string) { return bytes(field, Buffer.from(value, 'utf8')); }
function leg(date: string, origin: string, destination: string) {
  return Buffer.concat([string(2, date), number(5, 0), string(6, 'IT'),
    bytes(13, string(2, origin)), bytes(14, string(2, destination))]);
}
export function getGoogleFlightsUrl(search: FlightSearch): string {
  const input = searchSchema.parse(search);
  const data = [bytes(3, leg(input.departureDate, input.origin, input.destination))];
  if (input.returnDate) data.push(bytes(3, leg(input.returnDate, input.destination, input.origin)));
  for (let adult = 0; adult < input.adults; adult++) data.push(number(8, 1));
  data.push(number(9, 1), number(19, input.returnDate ? 1 : 2));
  const url = new URL('https://www.google.com/travel/flights/search');
  url.search = new URLSearchParams({ tfs: Buffer.concat(data).toString('base64url'),
    tfu: 'EgQIABABIgA', hl: 'zh-TW', gl: 'tw', curr: input.currency }).toString();
  return url.href;
}

interface Field { id: number; number?: number; bytes?: Buffer }
function fields(data: Buffer): Field[] {
  if (data.length > 16000) throw new Error('Google Flights URL data is too large');
  let offset = 0;
  const read = () => {
    let value = 0, multiplier = 1;
    for (let index = 0; index < 8; index++) {
      if (offset >= data.length) throw new Error('Truncated Google Flights URL data');
      const byte = data[offset++]; value += (byte & 127) * multiplier;
      if (!(byte & 128)) { if (!Number.isSafeInteger(value)) throw new Error('Invalid URL integer'); return value; }
      multiplier *= 128;
    }
    throw new Error('Invalid Google Flights URL integer');
  };
  const result: Field[] = [];
  while (offset < data.length) {
    const tag = read(), id = Math.floor(tag / 8), wire = tag % 8;
    if (!id) throw new Error('Invalid Google Flights URL field');
    if (wire === 0) result.push({ id, number: read() });
    else if (wire === 2) {
      const length = read();
      if (offset + length > data.length) throw new Error('Truncated Google Flights URL field');
      result.push({ id, bytes: data.subarray(offset, offset + length) }); offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) throw new Error('Truncated Google Flights URL field');
    } else throw new Error('Unsupported Google Flights URL encoding');
  }
  return result;
}
const matching = (values: Field[], id: number) => values.filter(value => value.id === id);
function oneString(values: Field[], id: number): string {
  const found = matching(values, id);
  if (found.length !== 1 || !found[0].bytes) throw new Error('Missing or ambiguous Google Flights URL value');
  return found[0].bytes.toString('utf8');
}
function oneNumber(values: Field[], id: number): number {
  const found = matching(values, id);
  if (found.length !== 1 || found[0].number === undefined) throw new Error('Missing or ambiguous Google Flights URL value');
  return found[0].number;
}
function airport(values: Field[], id: number): string {
  const found = matching(values, id);
  if (found.length !== 1 || !found[0].bytes) throw new Error('Missing airport in Google Flights URL');
  return oneString(fields(found[0].bytes), 2);
}
export function validateGoogleFlightsUrl(raw: string, search: FlightSearch): void {
  const input = searchSchema.parse(search), url = new URL(raw);
  if (url.origin !== 'https://www.google.com' || !/^\/travel\/flights\/(?:search|booking)$/.test(url.pathname)
    || url.searchParams.get('curr') !== input.currency) throw new Error('Unexpected Google Flights source or currency');
  const tfs = url.searchParams.get('tfs') ?? '';
  if (!/^[A-Za-z0-9_+\/-]+={0,2}$/.test(tfs)) throw new Error('Missing Google Flights URL search data');
  const info = fields(Buffer.from(tfs, 'base64url'));
  if (oneNumber(info, 9) !== 1 || oneNumber(info, 19) !== (input.returnDate ? 1 : 2)) throw new Error('Google Flights trip or cabin mismatch');
  const passengers = matching(info, 8).flatMap(value => value.number !== undefined ? [value.number] : [...(value.bytes ?? [])]);
  if (passengers.length !== input.adults || passengers.some(value => value !== 1)) throw new Error('Google Flights adult count mismatch');
  const legs = matching(info, 3);
  const expected = [{ date: input.departureDate, origin: input.origin, destination: input.destination },
    ...(input.returnDate ? [{ date: input.returnDate, origin: input.destination, destination: input.origin }] : [])];
  if (legs.length !== expected.length) throw new Error('Google Flights leg count mismatch');
  legs.forEach((value, index) => {
    if (!value.bytes) throw new Error('Malformed Google Flights leg');
    const part = fields(value.bytes), request = expected[index];
    if (oneString(part, 2) !== request.date) throw new Error('Google Flights full date mismatch');
    const origin = airport(part, 13), destination = airport(part, 14);
    const selected = matching(part, 4);
    // Selected-flight details must agree even when the parent leg already has
    // the requested airports. Parent fields cannot override a different flight.
    if (selected.length) {
      if (selected.length !== 1 || !selected[0].bytes) throw new Error('Ambiguous Google Flights selected flight');
      const flight = fields(selected[0].bytes);
      if (oneString(flight, 1) !== request.origin || oneString(flight, 2) !== request.date
        || oneString(flight, 3) !== request.destination || oneString(flight, 5) !== 'IT') throw new Error('Google Flights selected flight mismatch');
    }
    if (origin === request.origin && destination === request.destination) return;
    // Google can replace an airport by its parent city after selecting a flight.
    // In that case require the selected flight's explicit airports and full date.
    if (!selected.length) throw new Error('Google Flights airport mismatch');
  });
}
