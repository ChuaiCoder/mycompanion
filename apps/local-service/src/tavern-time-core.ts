/** Locale-aware Tavern date macros, shared by native prompts and extension JS. */
export function tavernTimeValue(kind: string, now: Date, locale?: string): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const language = locale || Intl.DateTimeFormat().resolvedOptions().locale;
  switch (kind.toLowerCase()) {
    case "date": return new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(now);
    case "time": return new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(now);
    case "weekday": return new Intl.DateTimeFormat(language, { weekday: "long" }).format(now);
    case "isodate": return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    case "isotime": return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    default: return "";
  }
}

export const tavernTimeBrowserSource = `export const tavernTimeValue = ${tavernTimeValue.toString()};`;
