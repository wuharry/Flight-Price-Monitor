import type { FlightSearch, GoogleFlightsLeg, GoogleFlightsPriceResult } from '../types/index.js';
import { googleFlightsPriceBasis, searchSchema } from '../validation.js';
import { validateGoogleFlightsUrl } from './google-flights-url.js';

export function googleFlightsPageBarrier(text: string, rawUrl: string): 'captcha' | 'consent' | null {
  const url = new URL(rawUrl);
  if (url.hostname.startsWith('consent.google.') || /Before you continue to Google|繼續使用 Google (?:服務)?之前|继续(?:使用|访问) Google.*之前/i.test(text)) return 'consent';
  if (/\/sorry\b/.test(url.pathname) || /unusual traffic|not a robot|verify (?:that )?you are human|真人驗證|人機驗證|異常流量|异常流量|complete.{0,30}captcha/i.test(text)) return 'captcha';
  return null;
}

const normalize = (text: string) => text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\r/g, '');
const dateLabel = /^(\d{1,2})月(\d{1,2})日(?:週[一二三四五六日天])?$/;
const timeLabel = /^(?:(?:上午|下午|凌晨|清晨|中午|晚上)\s*)?\d{1,2}:\d{2}(?:\s*\+\d)?$/;
const carrierLabel = /^(?:(?:台灣|臺灣|台湾)虎航|Tigerair Taiwan)$/;
export interface GoogleFlightsObservation {
  url: string;
  text: string;
  checkedAt: string;
  navigationStatus: number;
}

/** Strictly reads the selected itinerary's airline-seller total, never nearby OTA or analysis prices. */
export function parseGoogleFlightsObservation(observation: GoogleFlightsObservation, search: FlightSearch): GoogleFlightsPriceResult {
  const input = searchSchema.parse(search), reject = (reason: string): never => { throw new Error('Google Flights reference rejected: ' + reason); };
  validateGoogleFlightsUrl(observation.url, input);
  if (new URL(observation.url).pathname !== '/travel/flights/booking') reject('selected booking page missing');
  if (observation.navigationStatus !== 200) reject('unsuccessful page navigation');
  if (observation.text.length > 100000) reject('page text exceeds observation limit');
  if (googleFlightsPageBarrier(observation.text, observation.url)) reject('human verification or consent required');
  const checkedAt = Date.parse(observation.checkedAt);
  if (!Number.isFinite(checkedAt) || Math.abs(Date.now() - checkedAt) > 300000) reject('invalid observation time');
  const text = normalize(observation.text), lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const currencies = lines.map(line => /^幣別\s*([A-Z]{3})$/.exec(line)).filter(Boolean);
  if (currencies.length !== 1 || currencies[0]?.[1] !== input.currency) reject('currency is not uniquely TWD');
  if (!lines.includes(`${input.adults} 位乘客`)) reject('passenger count mismatch');
  const adultTotalLabel = new RegExp(`^${input.adults}\\s*位成人的價格\\s*\\(含稅及其他費用\\)`);
  const adultTotalPositions = lines.flatMap((line, index) => adultTotalLabel.test(line) ? [index] : []);
  if (adultTotalPositions.length !== 1) reject('adult tax-inclusive total label missing');
  if (!lines.includes(input.returnDate ? '來回經濟艙' : '單程經濟艙')) reject('trip or cabin mismatch');
  if (!/搜尋結果顯示的是\s*24\s*小時內的資訊/.test(text)) reject('source freshness disclosure missing');
  const bookingStart = lines.indexOf('預訂選項'), bookingEnd = adultTotalPositions[0];
  if (bookingStart < 0 || bookingEnd <= bookingStart) reject('booking section missing');
  const bookingLines = lines.slice(bookingStart + 1, bookingEnd);
  const sellerPositions = bookingLines.flatMap((line, index) => line === '透過Tigerair Taiwan預訂航空公司' ? [index] : []);
  if (sellerPositions.length !== 1) reject('unique Tigerair airline seller missing');
  const sellerIndex = sellerPositions[0];
  const amount = /^(?:NT\s*\$|NT＄|TWD|\$)\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.00)?$/.exec(bookingLines[sellerIndex + 1] ?? '');
  if (!amount || bookingLines[sellerIndex + 2] !== '繼續') reject('seller price block incomplete');
  const totalPrice = Number(amount![1].replace(/,/g, ''));
  if (!Number.isSafeInteger(totalPrice) || totalPrice <= 0) reject('invalid reference total');
  const selectedStart = lines.indexOf('已選取的航班');
  if (selectedStart < 0 || selectedStart >= bookingStart) reject('selected itinerary missing');
  const selected = lines.slice(selectedStart + 1, bookingStart);
  const positions = selected.flatMap((line, index) => dateLabel.test(line) ? [index] : []);
  const expected = [{ origin: input.origin, destination: input.destination, date: input.departureDate },
    ...(input.returnDate ? [{ origin: input.destination, destination: input.origin, date: input.returnDate }] : [])];
  if (positions.length !== expected.length) reject('selected leg count mismatch');
  const legs: GoogleFlightsLeg[] = expected.map((request, index) => {
    const part = selected.slice(positions[index], positions[index + 1] ?? selected.length);
    const date = dateLabel.exec(part[0])!;
    if (Number(date[1]) !== Number(request.date.slice(5, 7)) || Number(date[2]) !== Number(request.date.slice(8, 10))) reject('selected date mismatch');
    const route = new RegExp('^' + request.origin + '\\s*[–—-]\\s*' + request.destination + '$');
    if (part.filter(line => route.test(line)).length !== 1) reject('selected route mismatch');
    if (part.filter(line => carrierLabel.test(line)).length !== 1 || part.filter(line => line === '直達').length !== 1) reject('selected carrier or direct flight mismatch');
    const times = part.filter(line => timeLabel.test(line));
    if (times.length !== 2) reject('selected time labels missing');
    const flightNumbers = part.filter(line => /^IT\s*\d{1,4}$/.test(line));
    if (flightNumbers.length > 1) reject('ambiguous flight number');
    return { origin: request.origin, destination: request.destination, requestedDate: request.date,
      displayedDate: part[0], departureTimeLabel: times[0], arrivalTimeLabel: times[1],
      departureTime: null, arrivalTime: null, flightNumber: flightNumbers[0]?.replace(/\s/g, '') ?? null,
      fare: null, tax: null, total: null };
  });
  return { ...input, provider: 'google-flights', priceBasis: googleFlightsPriceBasis,
    totalPrice, outboundPrice: null, ...(input.returnDate ? { inboundPrice: null } : {}), taxAndFees: null,
    checkedAt: observation.checkedAt, bookingUrl: observation.url, legs,
    reference: { source: 'google-flights', seller: 'Tigerair Taiwan', taxInclusive: true,
      fareFamily: null, yearVerifiedFromDom: false, sourceDataMaxAgeHours: 24, selectedItineraryOnly: true } };
}
