export class ProviderAccessDeniedError extends Error {
  constructor(public readonly provider: string, public readonly host: string, public readonly status: number) {
    super(`${provider} access rejected by ${host} (HTTP ${status}). No price recorded; remaining searches for this provider will be skipped in this run.`);
    this.name = 'ProviderAccessDeniedError';
  }
}
