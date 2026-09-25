import { FlightPriceResult, FlightSearch } from '../types/index.js';

export interface FlightProvider {
  name: string;
  search(input: FlightSearch): Promise<FlightPriceResult>;
}
