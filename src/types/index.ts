export interface FlightSearch {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  currency: 'TWD';
}
export interface FlightLeg {
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  flightNumber: string;
  fare: number;
  tax: number;
  total: number;
}
export interface TigerairPriceResult extends FlightSearch {
  provider: string;
  outboundPrice: number;
  inboundPrice?: number;
  taxAndFees: number;
  totalPrice: number;
  checkedAt: string;
  bookingUrl: string;
  priceBasis: 'tigerLight-including-tax-excluding-payment-and-extras-v1';
  legs: FlightLeg[];
}
export interface GoogleFlightsLeg {
  origin: string;
  destination: string;
  requestedDate: string;
  displayedDate: string;
  departureTimeLabel: string;
  arrivalTimeLabel: string;
  departureTime: null;
  arrivalTime: null;
  flightNumber: string | null;
  fare: null;
  tax: null;
  total: null;
}
export interface GoogleFlightsPriceResult extends FlightSearch {
  provider: 'google-flights';
  outboundPrice: null;
  inboundPrice?: null;
  taxAndFees: null;
  totalPrice: number;
  checkedAt: string;
  bookingUrl: string;
  priceBasis: 'google-flights-tigerair-reference-including-tax-v1';
  legs: GoogleFlightsLeg[];
  reference: {
    source: 'google-flights';
    seller: 'Tigerair Taiwan';
    taxInclusive: true;
    fareFamily: null;
    yearVerifiedFromDom: false;
    sourceDataMaxAgeHours: 24;
    selectedItineraryOnly: true;
  };
}
export type FlightPriceResult = TigerairPriceResult | GoogleFlightsPriceResult;
export type AlertType = 'below_target' | 'new_low' | 'drop_amount' | 'drop_percent';
export interface WatchRule extends FlightSearch {
  userId?: string;
  id: string;
  provider: string;
  targetPrice?: number;
  notifyNewLow: boolean;
  newLowDays: number;
  dropAmount?: number;
  dropPercent?: number;
  enabled: boolean;
}
export interface PriceHistory {
  id: string;
  watchRuleId: string;
  searchKey: string;
  price: number;
  currency: 'TWD';
  checkedAt: string;
  result: FlightPriceResult;
}
export interface AlertTrigger {
  type: AlertType;
  currentPrice: number;
  previousPrice?: number;
  difference?: number;
  targetPrice?: number;
  reason: string;
}
export interface AlertRecord {
  id: string;
  watchRuleId: string;
  searchKey: string;
  price: number;
  type: AlertType;
  createdAt: string;
  sentAt?: string;
  status: 'pending' | 'sent' | 'expired';
  payload: { rule: WatchRule; result: FlightPriceResult; trigger: AlertTrigger };
}
export interface MonitorRepository {
  getActiveRules(): Promise<WatchRule[]>;
  getHistory(ruleId: string, searchKey: string, since: string, before: string): Promise<PriceHistory[]>;
  recordCheck(history: PriceHistory, alert?: AlertRecord): Promise<void>;
  getPendingAlerts(): Promise<AlertRecord[]>;
  markAlert(id: string, status: 'sent' | 'expired'): Promise<void>;
  acquireLock(owner: string): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
}
