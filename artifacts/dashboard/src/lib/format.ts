export function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('en-GB').format(value);
}

export function formatDate(dateString: string) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(dateString));
}

export function formatMarketType(marketType: string): string {
  const map: Record<string, string> = {
    MATCH_ODDS: "Match Result",
    OVER_UNDER_05: "Over/Under 0.5 Goals",
    OVER_UNDER_15: "Over/Under 1.5 Goals",
    OVER_UNDER_25: "Over/Under 2.5 Goals",
    OVER_UNDER_35: "Over/Under 3.5 Goals",
    OVER_UNDER_45: "Over/Under 4.5 Goals",
    BTTS: "Both Teams to Score",
    DOUBLE_CHANCE: "Double Chance",
    ASIAN_HANDICAP: "Asian Handicap",
    FIRST_HALF_RESULT: "First Half Result",
    FIRST_HALF_OVER_UNDER: "First Half Over/Under",
    TOTAL_CORNERS_85: "Total Corners (8.5)",
    TOTAL_CORNERS_95: "Total Corners (9.5)",
    TOTAL_CORNERS_105: "Total Corners (10.5)",
    TOTAL_CORNERS_115: "Total Corners (11.5)",
    TOTAL_CARDS_25: "Total Cards (2.5)",
    TOTAL_CARDS_55: "Total Cards (5.5)",
  };
  return map[marketType] ?? marketType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const absDiff = Math.abs(diff);

  if (absDiff < 60_000) return 'Just now';
  if (absDiff < 3_600_000) return `${Math.floor(absDiff / 60_000)}m ago`;
  if (absDiff < 86_400_000) return `${Math.floor(absDiff / 3_600_000)}h ago`;
  if (absDiff < 172_800_000) return 'Yesterday';
  if (absDiff < 604_800_000) return `${Math.floor(absDiff / 86_400_000)} days ago`;
  return formatDate(dateString);
}
