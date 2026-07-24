import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a date string (YYYY-MM-DD) or Date to "27 February 2026" style.
 */
export function formatDateLong(date: string | Date): string {
  if (typeof date === "string") {
    // If it's a plain date (YYYY-MM-DD), add time to avoid timezone shift
    // If it already has a T (timestamp), use as-is
    const d = date.includes("T") ? new Date(date) : new Date(date + "T00:00:00");
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  }
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

/** "1 July" / "30 June" , no year. Used inside period chips ("Q1 1 Jul - 30 Jun"). */
export function formatDayMonthShort(date: string | Date): string {
  const d = typeof date === "string"
    ? new Date(date.includes("T") ? date : date + "T00:00:00")
    : date;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

/** Today as YYYY-MM-DD in the viewer's own timezone. Use for default
 *  values on <DatePicker>, which speaks plain date strings , never
 *  new Date().toISOString().slice(0,10), which is UTC and lands on the
 *  wrong day for an Australian user before 10am. */
export function isoToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Joins two dates with a clean hyphen, no commas: "1 April - 30 June". */
export function formatDateRangeLong(startISO: string, endISO: string): string {
  return `${formatDateLong(startISO)} - ${formatDateLong(endISO)}`;
}
