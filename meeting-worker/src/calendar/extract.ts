// Extracts Telemost join URLs from arbitrary text (event description, location).
// Returns the first match, or null if no Telemost link is found.
//
// Supported formats:
//   https://telemost.yandex.ru/j/12345678
//   https://telemost.360.yandex.ru/j/12345678          (Yandex 360 subdomain)
//   https://telemost.yandex.ru/j/12345678?utm_source=...
//   (with or without trailing path/query)

const TELEMOST_RE = /https:\/\/telemost(?:\.\d+)?\.yandex\.ru\/j\/[a-zA-Z0-9_%-]+(?:[?&][^\s"'<>[\]{}|\\^`]*)*/;

/**
 * node-ical fields (summary, location, description) can be either a plain
 * string or a ParameterValue object { val: string, params: {...} }.
 * This helper safely coerces both to string.
 */
export function toString(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "val" in v) {
    return String((v as { val: unknown }).val);
  }
  return String(v);
}

export function extractTelemostUrl(text: string): string | null {
  const match = text.match(TELEMOST_RE);
  return match?.[0] ?? null;
}

/** Combine multiple text fields and try to extract a Telemost URL. */
export function extractFromFields(...fields: unknown[]): string | null {
  const combined = fields.map(toString).join(" ");
  return extractTelemostUrl(combined);
}
