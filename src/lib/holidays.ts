import { XMLParser } from "fast-xml-parser";
import type { DayInfo } from "./types";

export type OfficialHoliday = {
  date: string;
  name: string;
};

type PublicDataHolidayItem = {
  dateName?: unknown;
  locdate?: unknown;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validMonth(year: number, month: number) {
  return Number.isInteger(year) && year >= 1900 && year <= 2100 && Number.isInteger(month) && month >= 1 && month <= 12;
}

export function parseOfficialHolidayApiXml(xml: string, year: number, month: number): OfficialHoliday[] {
  if (!validMonth(year, month)) throw new Error("Invalid holiday API year or month.");

  const parsed = new XMLParser({ trimValues: true }).parse(xml) as {
    response?: {
      header?: { resultCode?: unknown; resultMsg?: unknown };
      body?: { items?: { item?: PublicDataHolidayItem | PublicDataHolidayItem[] } | string };
    };
  };
  const response = parsed.response;
  const resultCode = String(response?.header?.resultCode ?? "");
  if (!response || (resultCode !== "00" && resultCode !== "0")) {
    const message = String(response?.header?.resultMsg ?? "invalid response");
    throw new Error(`Official holiday API returned ${resultCode || "an unknown error"}: ${message}.`);
  }

  const itemsContainer = response.body?.items;
  const rawItems = typeof itemsContainer === "object" ? asArray(itemsContainer.item) : [];
  const holidays = new Map<string, string>();
  for (const item of rawItems) {
    const rawDate = String(item.locdate ?? "").replace(/\D/g, "");
    const name = String(item.dateName ?? "").normalize("NFKC").trim();
    if (!/^\d{8}$/.test(rawDate) || name.length === 0) continue;
    const itemYear = Number(rawDate.slice(0, 4));
    const itemMonth = Number(rawDate.slice(4, 6));
    const day = Number(rawDate.slice(6, 8));
    const date = new Date(itemYear, itemMonth - 1, day);
    if (
      itemYear !== year ||
      itemMonth !== month ||
      date.getFullYear() !== itemYear ||
      date.getMonth() !== itemMonth - 1 ||
      date.getDate() !== day
    ) {
      continue;
    }
    const key = dateKey(itemYear, itemMonth, day);
    const existing = holidays.get(key);
    holidays.set(key, existing && existing !== name ? `${existing}, ${name}` : name);
  }

  return [...holidays].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchOfficialHolidays(
  year: number,
  month: number,
  fetcher: typeof fetch = fetch,
): Promise<OfficialHoliday[]> {
  if (!validMonth(year, month)) throw new Error("Invalid holiday API year or month.");
  let response: Response;
  try {
    response = await fetcher(`/api/holidays?year=${year}&month=${month}`);
  } catch (error) {
    throw new Error(`Unable to load official holidays: ${error instanceof Error ? error.message : "network request failed"}.`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: unknown };
      detail = typeof body.error === "string" ? body.error : "";
    } catch {
      detail = "";
    }
    throw new Error(`Unable to load official holidays${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`);
  }

  let body: { holidays?: unknown };
  try {
    body = await response.json() as { holidays?: unknown };
  } catch {
    throw new Error("Unable to load official holidays: malformed API response.");
  }
  if (!Array.isArray(body.holidays)) throw new Error("Unable to load official holidays: malformed API response.");
  const holidays = body.holidays.filter((value): value is OfficialHoliday => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<OfficialHoliday>;
    return typeof candidate.date === "string" && typeof candidate.name === "string";
  });
  if (holidays.length !== body.holidays.length) {
    throw new Error("Unable to load official holidays: malformed holiday records.");
  }
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}-`;
  if (holidays.some((holiday) => !holiday.date.startsWith(monthPrefix) || holiday.name.trim().length === 0)) {
    throw new Error("Unable to load official holidays: API returned a record outside the selected month.");
  }
  return holidays;
}

export function buildDays(
  year: number,
  month: number,
  officialHolidays: readonly OfficialHoliday[],
  manualHolidayDays: Set<number> = new Set(),
): DayInfo[] {
  if (!validMonth(year, month)) throw new Error("Invalid calendar year or month.");
  const holidayNames = new Map<string, string>();
  for (const holiday of officialHolidays) {
    if (holiday.date.startsWith(`${year}-${String(month).padStart(2, "0")}-`) && holiday.name.trim()) {
      holidayNames.set(holiday.date, holiday.name.trim());
    }
  }
  manualHolidayDays.forEach((day) => {
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      const key = dateKey(year, month, day);
      if (!holidayNames.has(key)) holidayNames.set(key, "임시공휴일");
    }
  });

  const daysInMonth = new Date(year, month, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = new Date(year, month - 1, day);
    const weekday = date.getDay();
    const holidayName = holidayNames.get(dateKey(year, month, day));
    const isHoliday = holidayName !== undefined;
    const isWeekend = weekday === 0 || weekday === 6;
    return {
      day,
      date,
      weekday,
      isSaturday: weekday === 6,
      isSunday: weekday === 0,
      isWeekend,
      isHoliday,
      holidayName,
      isRestDay: isHoliday || isWeekend,
    };
  });
}
