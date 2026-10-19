/** The source explicitly has no quote for the requested itinerary; this is not proof no flight exists. */
export class NoMatchingItineraryError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} currently provides no matching itinerary quote. No substitute dates or price recorded.`);
    this.name = 'NoMatchingItineraryError';
  }
}
