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
