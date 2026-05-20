import KoreanLunarCalendar from "korean-lunar-calendar";
import type { DayInfo } from "./types";

type HolidayMap = Map<number, string>;

function toDayOfYear(year: number, month: number, day: number): number | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return Math.floor((date.getTime() - new Date(year, 0, 1).getTime()) / 86400000) + 1;
}

function addHoliday(map: HolidayMap, year: number, month: number, day: number, name: string) {
  const dayOfYear = toDayOfYear(year, month, day);
  if (dayOfYear) map.set(dayOfYear, name);
}

function addLunarHoliday(map: HolidayMap, lunarYear: number, lunarMonth: number, lunarDay: number, name: string) {
  const calendar = new KoreanLunarCalendar();
  if (!calendar.setLunarDate(lunarYear, lunarMonth, lunarDay, false)) return;
  const solar = calendar.getSolarCalendar();
  addHoliday(map, solar.year, solar.month, solar.day, name);
}

function nextNonHolidayWeekday(year: number, map: HolidayMap, fromDayOfYear: number) {
  const daysInYear = toDayOfYear(year, 12, 31) ?? 365;
  for (let day = fromDayOfYear + 1; day <= daysInYear; day += 1) {
    const date = new Date(year, 0, day);
    const weekday = date.getDay();
    if (weekday !== 0 && weekday !== 6 && !map.has(day)) {
      return day;
    }
  }
  return null;
}

function applySubstituteHolidays(year: number, map: HolidayMap) {
  const originals = [...map.entries()].sort((a, b) => a[0] - b[0]);
  for (const [dayOfYear, name] of originals) {
    if (name === "신정" || name === "현충일") continue;
    const date = new Date(year, 0, dayOfYear);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const overlaps = originals.some(([otherDay]) => otherDay === dayOfYear && otherDay !== dayOfYear);
    if (!isWeekend && !overlaps) continue;
    const substitute = nextNonHolidayWeekday(year, map, dayOfYear);
    if (substitute) map.set(substitute, `${name} 대체공휴일`);
  }
}

function getHolidayMap(year: number, month: number, manualHolidayDays: Set<number>): HolidayMap {
  const map: HolidayMap = new Map();

  addHoliday(map, year, 1, 1, "신정");
  addHoliday(map, year, 3, 1, "삼일절");
  addHoliday(map, year, 5, 5, "어린이날");
  addHoliday(map, year, 6, 6, "현충일");
  addHoliday(map, year, 8, 15, "광복절");
  addHoliday(map, year, 10, 3, "개천절");
  addHoliday(map, year, 10, 9, "한글날");
  addHoliday(map, year, 12, 25, "성탄절");

  addLunarHoliday(map, year - 1, 12, 29, "설날 연휴");
  addLunarHoliday(map, year, 1, 1, "설날");
  addLunarHoliday(map, year, 1, 2, "설날 연휴");
  addLunarHoliday(map, year, 4, 8, "부처님오신날");
  addLunarHoliday(map, year, 8, 14, "추석 연휴");
  addLunarHoliday(map, year, 8, 15, "추석");
  addLunarHoliday(map, year, 8, 16, "추석 연휴");

  applySubstituteHolidays(year, map);

  manualHolidayDays.forEach((day) => {
    const dayOfYear = toDayOfYear(year, month, day);
    if (dayOfYear) map.set(dayOfYear, "임시공휴일");
  });

  return map;
}

export function buildDays(year: number, month: number, manualHolidayDays: Set<number>): DayInfo[] {
  const holidayMap = getHolidayMap(year, month, manualHolidayDays);
  const daysInMonth = new Date(year, month, 0).getDate();

  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = new Date(year, month - 1, day);
    const dayOfYear = Math.floor((date.getTime() - new Date(year, 0, 1).getTime()) / 86400000) + 1;
    const weekday = date.getDay();
    const holidayName = holidayMap.get(dayOfYear);
    const isHoliday = Boolean(holidayName);
    return {
      day,
      date,
      weekday,
      isSaturday: weekday === 6,
      isSunday: weekday === 0,
      isWeekend: weekday === 0 || weekday === 6,
      isHoliday,
      holidayName,
      isRestDay: isHoliday || weekday === 0 || weekday === 6,
    };
  });
}
