import type { EmployeeInput, ParsedEmployeeInput, WorkShift } from "./types";

const WORK_CODES = new Set(["D", "E", "M", "N"]);

export function parseDays(value: string, maxDay: number): Set<number> {
  const days = new Set<number>();
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const day = Number(item);
      if (Number.isInteger(day) && day >= 1 && day <= maxDay) {
        days.add(day);
      }
    });
  return days;
}

export function parseRequests(value: string, maxDay: number): Map<number, WorkShift> {
  const requests = new Map<number, WorkShift>();
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const [dayText, codeText] = item.split(":").map((part) => part.trim().toUpperCase());
      const day = Number(dayText);
      if (Number.isInteger(day) && day >= 1 && day <= maxDay && WORK_CODES.has(codeText)) {
        requests.set(day, codeText as WorkShift);
      }
    });
  return requests;
}

export function parseEmployeeInput(input: EmployeeInput, maxDay: number): ParsedEmployeeInput {
  const wantedOff = parseDays(input.wantedOff, maxDay);
  const vacation = parseDays(input.vacation, maxDay);
  const fixedOff = new Set([...wantedOff, ...vacation]);
  const vacationOffBonus = vacation.size >= 6 ? 3 : vacation.size;
  const minOff = 8 + vacationOffBonus;
  const targetOff = vacation.size === 0 ? 8 : vacation.size >= 6 ? 12 : minOff + 2;

  return {
    wantedOff,
    vacation,
    fixedOff,
    requests: parseRequests(input.requests, maxDay),
    minOff,
    targetOff,
  };
}
