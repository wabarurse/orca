const dateOptions = { month: "short", day: "numeric", year: "numeric" } as const;
const dateFormat = new Intl.DateTimeFormat("en-US", dateOptions);
const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

/** Display timestamps in the machine's local timezone. Date-only records keep their calendar day. */
export function formatDateTime(value: string | number): string {
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? value + "T12:00:00" : value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return dateOnly ? dateFormat.format(date) : `${dateFormat.format(date)}, ${timeFormat.format(date)}`;
}
