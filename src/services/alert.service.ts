import type { AlertTrigger, PriceHistory, WatchRule } from '../types/index.js';

export function checkTriggerConditions(rule: WatchRule, current: number, history: PriceHistory[], now: Date): AlertTrigger | null {
  const money = (value: number) => 'NT$' + value.toLocaleString('zh-TW');
  if (rule.targetPrice !== undefined && current <= rule.targetPrice) return {
    type: 'below_target', currentPrice: current, targetPrice: rule.targetPrice,
    difference: rule.targetPrice - current,
    reason: `含稅票價 ${money(current)} 已達目標 ${money(rule.targetPrice)}`,
  };
  const cutoff = now.getTime() - rule.newLowDays * 86400000;
  const prior = history.filter(row => Date.parse(row.checkedAt) >= cutoff && Date.parse(row.checkedAt) < now.getTime());
  const minimum = prior.length ? Math.min(...prior.map(row => row.price)) : null;
  if (rule.notifyNewLow && minimum !== null && current < minimum) return {
    type: 'new_low', currentPrice: current, previousPrice: minimum, difference: minimum - current,
    reason: `創下近 ${rule.newLowDays} 日監控新低，較先前最低 ${money(minimum)} 便宜 ${money(minimum - current)}`,
  };
  // Compare with the most recent sample at/before 24 h ago, at most 48 h old.
  const baseline = history.filter(row => {
    const age = now.getTime() - Date.parse(row.checkedAt);
    return age >= 86400000 && age <= 2 * 86400000;
  }).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  if (!baseline || baseline.price <= 0) return null;
  const difference = Math.round((baseline.price - current) * 100) / 100;
  if (rule.dropAmount !== undefined && difference >= rule.dropAmount) return {
    type: 'drop_amount', currentPrice: current, previousPrice: baseline.price, difference,
    reason: `較約 24 小時前下降 ${money(difference)}`,
  };
  const percent = difference / baseline.price * 100;
  if (rule.dropPercent !== undefined && percent >= rule.dropPercent) return {
    type: 'drop_percent', currentPrice: current, previousPrice: baseline.price, difference,
    reason: `較約 24 小時前下降 ${percent.toFixed(1)}%`,
  };
  return null;
}
