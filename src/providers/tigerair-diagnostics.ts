// Never log request bodies, query strings, cookies, tokens or full page contents.
export function networkSummary(url: string, resource: string, error?: string, status?: number) {
  let host = 'invalid-url';
  try { host = new URL(url).hostname; } catch { /* No raw URL in logs. */ }
  return {
    host, resource,
    ...(error !== undefined ? { error: error.match(/\bnet::ERR_[A-Z0-9_]+\b/)?.[0] ?? 'NETWORK_FAILURE' } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function isFareEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://api-book.tigerairtw.com' && url.pathname.replace(/\/$/, '') === '/graphql';
  } catch { return false; }
}

export function pageSignal(text: string): string {
  if (/Access Denied|You don't have permission to access|存取遭拒/i.test(text)) return 'access-denied';
  if (/verify you are human|確認您是人類|驗證您是真人|完成驗證|機器人驗證/i.test(text)) return 'verification-required';
  if (/waiting room|排隊中|等候室|輪到您/i.test(text)) return 'waiting-room';
  return 'unknown';
}
