const compactNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

export function formatTokenCount(tokens: number): string {
  const absolute = Math.abs(tokens);
  if (absolute >= 1_000_000) {
    return `${compactNumber.format(tokens / 1_000_000)}M`;
  }
  if (absolute >= 1_000) {
    const formatted = compactNumber.format(tokens / 1_000);
    return formatted === "1,000" ? "1M" : `${formatted}k`;
  }
  return tokens.toLocaleString("en-US");
}
