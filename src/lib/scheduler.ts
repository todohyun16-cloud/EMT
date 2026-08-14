import { parseEmployeeInput } from "./input";
import { normalizePreviousMonthShift } from "./previousSchedule";
import {
  EMPLOYEES,
  setActiveEmployees,
  type DayInfo,
  type Employee,
  type EmployeeInput,
  type EmployeeStats,
  type ParsedEmployeeInput,
  type Schedule,
  type ScheduleResult,
  type ShiftCode,
  type WorkShift,
} from "./types";

type Slot = { dayIndex: number; code: WorkShift };
type NormalizedShift = WorkShift | "OFF";
type ParsedWithPrevious = ParsedEmployeeInput & { previousMonthSchedule?: (NormalizedShift | null)[] };
type NightBlock = { startDay: number; endDay: number; days: number[]; length: 1 | 2 | 3; employeeIndex: number };
type NightAssignmentResult =
  | { ok: true; schedule: Schedule; lockedRecoveryOff: Set<string>; blockCounts: number[] }
  | { ok: false; failures: string[] };
type NightSearchDiagnostics = {
  nodesVisited: number;
  deepestDepth: number;
  deepestCounts: number[];
  mostConstrained?: {
    day: number;
    candidates: string[];
    rejected: string[];
  };
  rejectionReasons: string[];
};
type Attempt = {
  schedule: Schedule;
  lockedOff: Set<string>;
  workCounts: number[];
  shiftCounts: Record<WorkShift, number>[];
  slotIndex: number;
  deadline: number;
};

const SHIFTS: WorkShift[] = ["D", "E", "M", "N"];
const MAX_ATTEMPTS = 260000;
const SLOT_PRIORITY: Record<WorkShift, number> = { N: 0, D: 1, E: 2, M: 3 };
const MIN_NON_N_DAYS_BETWEEN_N_BLOCKS = 4;
const MIN_N_BLOCK_START_GAP = MIN_NON_N_DAYS_BETWEEN_N_BLOCKS + 1;

export function baseOffCount(days: DayInfo[]) {
  return days.filter((day) => day.isRestDay).length;
}

export function monthlyOffTarget(baseOff: number, input: ParsedEmployeeInput) {
  return baseOff + input.vacation.size + input.educationDays.size;
}

function seededNoise(seed: number, ...values: number[]) {
  let hash = seed + 0x9e3779b9;
  values.forEach((value) => {
    hash ^= value + 0x9e3779b9 + (hash << 6) + (hash >> 2);
    hash |= 0;
  });
  return Math.abs(hash % 100000) / 100000;
}

function normalizeShift(code: unknown): NormalizedShift | null {
  if (code === null || code === undefined) return null;
  const normalized = String(code).normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (normalized === "") return null;
  if (normalized === "D" || normalized === "E" || normalized === "M" || normalized === "N") return normalized;
  if (normalized === "/" || normalized === "OFF") return "OFF";
  return null;
}

function isEveningLike(code: unknown) {
  const normalized = normalizeShift(code);
  return normalized === "E" || normalized === "M";
}

function conflictsWithKnownNextDayRequest(
  assignedToday: ShiftCode,
  nextRequested: NormalizedShift | null,
): string | null {
  if ((assignedToday === "E" || assignedToday === "M") && nextRequested === "D") {
    return "E/M today conflicts with requested D tomorrow";
  }
  if (assignedToday === "N" && (nextRequested === "D" || nextRequested === "E" || nextRequested === "M")) {
    return "N today conflicts with requested non-N work tomorrow because recovery OFF or N is required";
  }
  return null;
}

function isOffLike(code: NormalizedShift | null) {
  return code === "OFF" || code === null;
}

function isWorkLike(code: unknown) {
  const shift = normalizeShift(code);
  return shift !== null && shift !== "OFF";
}

function previousMonthCandidates(input: EmployeeInput) {
  const source = input as EmployeeInput & Record<string, unknown>;
  return [
    source.previousMonthSchedule,
    source.previousSchedule,
    source.previousMonth,
    source.prevMonthSchedule,
    source.prevSchedule,
    source.prevMonth,
    source.lastMonthSchedule,
    source.lastMonth,
  ];
}

export function normalizePreviousMonthSchedule(input: EmployeeInput, previousMonthLength: number): (NormalizedShift | null)[] {
  const raw = previousMonthCandidates(input).find((candidate) => candidate !== undefined && candidate !== null);
  if (raw === undefined || raw === null) return [];

  if (Array.isArray(raw)) return raw.map((code) => normalizePreviousMonthShift(code));

  if (typeof raw === "string") {
    const byDay = new Map<number, NormalizedShift | null>();
    const dayPattern = /(\d+)\s*[:=]\s*([^,;\s]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = dayPattern.exec(raw)) !== null) {
      const day = Number(match[1]);
      if (Number.isInteger(day) && day >= 1 && day <= previousMonthLength) {
        byDay.set(day, normalizePreviousMonthShift(match[2]));
      }
    }
    if (byDay.size > 0) {
      return Array.from({ length: previousMonthLength }, (_, index) => byDay.get(index + 1) ?? null);
    }
    return raw
      .split(/[\s,;]+/)
      .filter((code) => code.length > 0)
      .map((code) => normalizePreviousMonthShift(code));
  }

  if (typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>)
      .map(([day, code]) => [Number(day), normalizePreviousMonthShift(code)] as const)
      .filter(([day]) => Number.isInteger(day) && day >= 1 && day <= previousMonthLength)
      .sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) return [];
    const result = Array.from({ length: Math.max(...entries.map(([day]) => day)) }, () => null as NormalizedShift | null);
    entries.forEach(([day, code]) => {
      result[day - 1] = code;
    });
    return result;
  }

  return [];
}

function emptySchedule(dayCount: number): Schedule {
  return Array.from({ length: dayCount }, () =>
    Object.fromEntries(EMPLOYEES.map((employee) => [employee, "/" as ShiftCode])) as Record<Employee, ShiftCode>,
  );
}

function requiredSlots(days: DayInfo[]): Slot[] {
  const slots: Slot[] = [];
  days.forEach((day, index) => {
    slots.push({ dayIndex: index, code: "D" });
    slots.push({ dayIndex: index, code: "E" });
  });
  return slots;
}

function restDayMRemovalPriority(days: DayInfo[], parsed: ParsedEmployeeInput[]) {
  const restDayRuns = new Map<number, number>();
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0) run.forEach((day) => restDayRuns.set(day, run.length));
    run = [];
  };
  days.forEach((day) => {
    if (day.isRestDay) run.push(day.day);
    else flush();
  });
  flush();

  return days
    .filter((day) => day.isRestDay)
    .map((day) => {
      const hardOffCount = parsed.filter((input) => input.fixedOff.has(day.day)).length;
      const runLength = restDayRuns.get(day.day) ?? 1;
      const attachedToWeekend =
        day.isHoliday &&
        ((days[day.day - 2]?.isWeekend ?? false) || (days[day.day]?.isWeekend ?? false));
      let rank = 5;
      if (day.isSaturday) rank = 1;
      else if (day.isHoliday && !attachedToWeekend && runLength === 1) rank = 2;
      else if (day.isSunday) rank = 3;
      else if (day.isHoliday && attachedToWeekend) rank = 4;
      if (runLength >= 2) rank = 5;
      return { day: day.day, rank, runLength, hardOffCount };
    })
    .sort((a, b) => b.hardOffCount - a.hardOffCount || a.rank - b.rank || a.runLength - b.runLength || a.day - b.day)
    .map((item) => item.day);
}

function activeMDaysForMonth(days: DayInfo[], parsed: ParsedEmployeeInput[]) {
  const activeMDays = new Set(days.filter((day) => day.isRestDay).map((day) => day.day));
  const removedM: number[] = [];

  for (const day of restDayMRemovalPriority(days, parsed)) {
    const hasHardOff = parsed.some((input) => input.fixedOff.has(day));
    const hardOffCount = parsed.filter((input) => input.fixedOff.has(day)).length;
    const maxOffWithM = EMPLOYEES.length - 4;
    if (!hasHardOff && hardOffCount <= maxOffWithM) continue;
    if (activeMDays.size <= 0) break;
    activeMDays.delete(day);
    removedM.push(day);
  }

  return { activeMDays, removedM: removedM.sort((a, b) => a - b) };
}

function regularOffProtectedCapacity(days: DayInfo[], parsed: ParsedEmployeeInput[]) {
  return parsed.reduce((sum, input) => sum + Math.min(days.length - input.fixedOff.size, days.length - input.minOff), 0);
}

function isFixedOff(parsed: ParsedEmployeeInput[], employeeIndex: number, day: number) {
  return parsed[employeeIndex].fixedOff.has(day);
}

function offKey(employeeIndex: number, day: number) {
  return `${employeeIndex}:${day}`;
}

function isLockedOff(lockedOff: Set<string>, employeeIndex: number, day: number) {
  return lockedOff.has(offKey(employeeIndex, day));
}

function previousTailFor(parsed: ParsedEmployeeInput[], employeeIndex: number) {
  return (parsed[employeeIndex] as ParsedWithPrevious).previousMonthSchedule ?? [];
}

function getShiftAtWithPrev(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  dayIndex: number,
  employeeIndex: number,
): NormalizedShift | null {
  if (dayIndex < 0) {
    const previous = previousTailFor(parsed, employeeIndex);
    return previous[previous.length + dayIndex] ?? null;
  }
  return normalizeShift(schedule[dayIndex]?.[EMPLOYEES[employeeIndex]]);
}

function getRequestedShiftAtWithPrev(
  input: ParsedEmployeeInput,
  dayIndex: number,
  previousMonthSchedule: (NormalizedShift | null)[] = [],
): NormalizedShift | null {
  if (dayIndex < 0) return previousMonthSchedule[previousMonthSchedule.length + dayIndex] ?? null;
  const day = dayIndex + 1;
  return normalizeShift(input.requests.get(day)) ?? (input.fixedOff.has(day) ? "OFF" : null);
}

function trailingPreviousWorkStreak(parsed: ParsedEmployeeInput[], employeeIndex: number) {
  let streak = 0;
  for (const shift of previousTailFor(parsed, employeeIndex)) {
    if (isWorkLike(shift)) streak += 1;
    else streak = 0;
  }
  return streak;
}

function wouldExceedConsecutive(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  employeeIndex: number,
  dayIndex: number,
  code: WorkShift,
) {
  let streak = trailingPreviousWorkStreak(parsed, employeeIndex);
  for (let index = 0; index < schedule.length; index += 1) {
    const shift = index === dayIndex ? normalizeShift(code) : getShiftAtWithPrev(schedule, parsed, index, employeeIndex);
    if (isWorkLike(shift)) {
      streak += 1;
      if (streak > 5) return true;
    } else {
      streak = 0;
    }
  }
  return false;
}

function previousNightEndIndex(
  getShiftAt: (dayIndex: number) => NormalizedShift | null,
  beforeDayIndex: number,
  limit: number,
) {
  for (let index = beforeDayIndex - 1; index >= limit; index -= 1) {
    if (getShiftAt(index) === "N") return index;
  }
  return null;
}

function nightSpacingViolation(
  getShiftAt: (dayIndex: number) => NormalizedShift | null,
  dayIndex: number,
  code: NormalizedShift | null,
  previousLimit: number,
) {
  if (code !== "N") return false;
  if (dayIndex > 0 && getShiftAt(dayIndex - 1) === "N") return false;
  const previousNightEnd = previousNightEndIndex(getShiftAt, dayIndex, previousLimit);
  return previousNightEnd !== null && dayIndex - previousNightEnd < MIN_N_BLOCK_START_GAP;
}

function shiftWithCandidate(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  employeeIndex: number,
  candidateDayIndex: number,
  candidateCode: WorkShift,
) {
  return (index: number) =>
    index === candidateDayIndex ? normalizeShift(candidateCode) : getShiftAtWithPrev(schedule, parsed, index, employeeIndex);
}

function hasKnownPatternViolation(schedule: Schedule, parsed: ParsedEmployeeInput[], employeeIndex: number, dayIndex: number, code: WorkShift) {
  const shiftAt = shiftWithCandidate(schedule, parsed, employeeIndex, dayIndex, code);
  const current = normalizeShift(code);
  const prev = shiftAt(dayIndex - 1);
  const prevPrev = shiftAt(dayIndex - 2);

  if (prev === "N" && current !== "N") return "After N, only OFF or N is allowed.";
  if (prev === "N" && prevPrev === "N") return "After NN, OFF is required.";

  if (current === "D") {
    if (isEveningLike(prev)) return "E/M -> D pattern is forbidden.";
    if (isOffLike(prev) && prevPrev === "N") return "N-O-D pattern is forbidden.";
  }
  return null;
}

function canAssign(
  attempt: Attempt,
  parsed: ParsedEmployeeInput[],
  slot: Slot,
  employeeIndex: number,
  maxWork: number[],
) {
  const employee = EMPLOYEES[employeeIndex];
  const day = slot.dayIndex + 1;
  if (attempt.schedule[slot.dayIndex][employee] !== "/") return false;
  if (isLockedOff(attempt.lockedOff, employeeIndex, day)) return false;
  if (isFixedOff(parsed, employeeIndex, day)) return false;
  if (attempt.workCounts[employeeIndex] + 1 > maxWork[employeeIndex]) return false;
  if (wouldExceedConsecutive(attempt.schedule, parsed, employeeIndex, slot.dayIndex, slot.code)) return false;
  if (hasKnownPatternViolation(attempt.schedule, parsed, employeeIndex, slot.dayIndex, slot.code)) return false;

  const requested = normalizeShift(parsed[employeeIndex].requests.get(day));
  if (requested && requested !== "OFF" && requested !== "M" && requested !== slot.code) return false;
  return true;
}

function canAssignReason(
  attempt: Attempt,
  parsed: ParsedEmployeeInput[],
  slot: Slot,
  employeeIndex: number,
  maxWork: number[],
) {
  const employee = EMPLOYEES[employeeIndex];
  const day = slot.dayIndex + 1;
  if (attempt.schedule[slot.dayIndex][employee] !== "/") return "already assigned";
  if (isLockedOff(attempt.lockedOff, employeeIndex, day)) return "locked OFF";
  if (isFixedOff(parsed, employeeIndex, day)) return "fixed OFF/vacation/wantedOff";
  if (attempt.workCounts[employeeIndex] + 1 > maxWork[employeeIndex]) return "minOff capacity";
  if (wouldExceedConsecutive(attempt.schedule, parsed, employeeIndex, slot.dayIndex, slot.code)) return "max 5 consecutive work";
  const pattern = hasKnownPatternViolation(attempt.schedule, parsed, employeeIndex, slot.dayIndex, slot.code);
  if (pattern) return pattern;

  const requested = normalizeShift(parsed[employeeIndex].requests.get(day));
  if (requested && requested !== "OFF" && requested !== "M" && requested !== slot.code) return `requested ${requested}`;
  return null;
}

function requestImpossible(parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const failures: string[] = [];
  parsed.forEach((input, index) => {
    const previous = previousTailFor(parsed, index);
    const shiftAt = (dayIndex: number) => getRequestedShiftAtWithPrev(input, dayIndex, previous);
    input.requests.forEach((code, day) => {
      const employee = EMPLOYEES[index];
      const requested = normalizeShift(code);
      const dayIndex = day - 1;
      const prev = shiftAt(dayIndex - 1);
      const prevPrev = shiftAt(dayIndex - 2);
      if (requested === null || requested === "OFF") return;
      if (requested === "M") return;
      if (input.fixedOff.has(day)) failures.push(`${employee} day ${day} requested ${code}: conflicts with fixed OFF/vacation`);
      if (requested === "D" && isEveningLike(prev)) failures.push(`${employee} day ${day - 1} E/M -> day ${day} D`);
      if (requested !== "N" && prev === "N") failures.push(`${employee} day ${day} ${code}: N next day must be OFF or N`);
      if (requested !== "N" && prev === "N" && prevPrev === "N") failures.push(`${employee} day ${day} ${code}: after NN, OFF is required`);
      if (requested === "D" && isOffLike(prev) && prevPrev === "N") failures.push(`${employee} day ${day} D: N-O-D pattern is forbidden`);
      const needed = ["D", "E", "N"];
      if (!needed.includes(requested)) failures.push(`${employee} day ${day} ${code}: requested shift is not required on this day`);
    });
  });
  return failures;
}

function fillRequests(schedule: Schedule, parsed: ParsedEmployeeInput[], slots: Slot[], lockedOff = new Set<string>()) {
  const failures: string[] = [];
  for (const [employeeIndex, input] of parsed.entries()) {
    for (const [day, code] of input.requests) {
      const requested = normalizeShift(code);
      if (requested === null || requested === "OFF" || requested === "N") continue;
      const exists = slots.some((slot) => slot.dayIndex === day - 1 && slot.code === requested);
      if (!exists) continue;
      const employee = EMPLOYEES[employeeIndex];
      if (lockedOff.has(offKey(employeeIndex, day))) {
        failures.push(`${employee} day ${day}: requested ${requested} conflicts with locked recovery OFF`);
        continue;
      }
      if (schedule[day - 1][employee] !== "/") {
        failures.push(`${employee} day ${day}: requested ${requested} conflicts with assigned ${schedule[day - 1][employee]}`);
        continue;
      }
      schedule[day - 1][employee] = requested;
    }
  }
  return failures;
}

function deriveNightBlocks(schedule: Schedule): NightBlock[] {
  const blocks: NightBlock[] = [];
  EMPLOYEES.forEach((employee, employeeIndex) => {
    let startIndex: number | null = null;
    for (let dayIndex = 0; dayIndex <= schedule.length; dayIndex += 1) {
      const isNight = dayIndex < schedule.length && schedule[dayIndex][employee] === "N";
      if (isNight && startIndex === null) startIndex = dayIndex;
      if (!isNight && startIndex !== null) {
        const length = dayIndex - startIndex;
        if (length >= 1 && length <= 3) {
          blocks.push({
            startDay: startIndex + 1,
            endDay: dayIndex,
            days: Array.from({ length }, (_, offset) => startIndex! + offset + 1),
            length: length as 1 | 2 | 3,
            employeeIndex,
          });
        } else {
          blocks.push({
            startDay: startIndex + 1,
            endDay: dayIndex,
            days: Array.from({ length }, (_, offset) => startIndex! + offset + 1),
            length: Math.min(3, length) as 1 | 2 | 3,
            employeeIndex,
          });
        }
        startIndex = null;
      }
    }
  });
  return blocks.sort((a, b) => a.startDay - b.startDay || a.employeeIndex - b.employeeIndex);
}

function previousMonthLastNightIndex(parsed: ParsedEmployeeInput[], employeeIndex: number) {
  const previous = previousTailFor(parsed, employeeIndex);
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    if (previous[index] === "N") return index - previous.length;
  }
  return null;
}

function requestedNightOwnersByDay(parsed: ParsedEmployeeInput[], dayCount: number) {
  const owners = new Map<number, number>();
  const failures: string[] = [];
  for (let day = 1; day <= dayCount; day += 1) {
    const requested = EMPLOYEES.map((_, employeeIndex) => employeeIndex).filter(
      (employeeIndex) => normalizeShift(parsed[employeeIndex].requests.get(day)) === "N",
    );
    if (requested.length > 1) {
      failures.push(`Day ${day}: requested N conflict between ${requested.map((index) => EMPLOYEES[index]).join(", ")}`);
    } else if (requested.length === 1) {
      owners.set(day, requested[0]);
    }
  }
  return { owners, failures };
}

function dynamicNightBlockReason(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  block: NightBlock,
  assignedBlocks: NightBlock[],
  requestedOwners: Map<number, number>,
) {
  const employeeIndex = block.employeeIndex;
  const employee = EMPLOYEES[employeeIndex];
  if (block.length === 3 && (schedule.length % 2 === 0 || assignedBlocks.some((item) => item.length === 3))) {
    return "NNN is only allowed at most once in odd-total-N months.";
  }
  const previousBlock = assignedBlocks.filter((item) => item.employeeIndex === employeeIndex).at(-1);
  if (previousBlock && block.startDay - previousBlock.endDay < MIN_N_BLOCK_START_GAP) {
    return `${employee}: night spacing conflict before day ${block.startDay}`;
  }
  if (!previousBlock) {
    const previousNight = previousMonthLastNightIndex(parsed, employeeIndex);
    if (previousNight !== null && block.startDay - 1 - previousNight < MIN_N_BLOCK_START_GAP) {
      return `${employee}: previous-month night spacing conflict before day ${block.startDay}`;
    }
  }
  for (const day of block.days) {
    const forcedOwner = requestedOwners.get(day);
    if (forcedOwner !== undefined && forcedOwner !== employeeIndex) {
      return `${employee} day ${day}: requested N belongs to ${EMPLOYEES[forcedOwner]}`;
    }
    if (parsed[employeeIndex].fixedOff.has(day)) return `${employee} day ${day}: fixedOff/vacation/wantedOff`;
    const requested = normalizeShift(parsed[employeeIndex].requests.get(day));
    if (requested && requested !== "N") return `${employee} day ${day}: requested incompatible ${requested}`;
  }
  const recoveryDay = block.endDay + 1;
  if (recoveryDay <= schedule.length) {
    const requested = normalizeShift(parsed[employeeIndex].requests.get(recoveryDay));
    if (requested && requested !== "OFF") return `${employee} day ${recoveryDay}: requested work ${requested} conflicts with recovery OFF`;
  }
  return null;
}

function dynamicNightBlockScore(
  block: NightBlock,
  nightDayCounts: number[],
  blockCounts: number[],
  requestedOwners: Map<number, number>,
  seed: number,
) {
  const requestedBonus = block.days.some((day) => requestedOwners.get(day) === block.employeeIndex) ? -250 : 0;
  const lengthPenalty = block.length === 2 ? 0 : block.length === 1 ? 12 : 1000;
  return (
    nightDayCounts[block.employeeIndex] * 28 +
    blockCounts[block.employeeIndex] * 16 +
    lengthPenalty +
    requestedBonus +
    seededNoise(seed, block.startDay, block.length, block.employeeIndex) * 12
  );
}

function assignNightBlocks(
  baseSchedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  seed: number,
): NightAssignmentResult {
  const schedule = baseSchedule.map((row) => ({ ...row })) as Schedule;
  const { owners: requestedOwners, failures: requestFailures } = requestedNightOwnersByDay(parsed, days.length);
  if (requestFailures.length > 0) return { ok: false, failures: requestFailures };

  const assignedBlocks: NightBlock[] = [];
  const nightDayCounts = EMPLOYEES.map(() => 0);
  const blockCounts = EMPLOYEES.map(() => 0);
  const diagnostics: NightSearchDiagnostics = {
    nodesVisited: 0,
    deepestDepth: 0,
    deepestCounts: [...nightDayCounts],
    rejectionReasons: [],
  };
  const deadline = performance.now() + 1800;

  const candidateBlocks = (startDay: number) => {
    const candidates: NightBlock[] = [];
    const rejected: string[] = [];
    const forcedToday = requestedOwners.get(startDay);
    const employees = forcedToday === undefined ? EMPLOYEES.map((_, index) => index) : [forcedToday];
    const lengths: (1 | 2 | 3)[] = [2, 1, 3];
    for (const length of lengths) {
      if (startDay + length - 1 > days.length) continue;
      for (const employeeIndex of employees) {
        const previous = assignedBlocks[assignedBlocks.length - 1];
        if (previous?.employeeIndex === employeeIndex) continue;
        const block: NightBlock = {
          startDay,
          endDay: startDay + length - 1,
          days: Array.from({ length }, (_, offset) => startDay + offset),
          length,
          employeeIndex,
        };
        const reason = dynamicNightBlockReason(schedule, parsed, block, assignedBlocks, requestedOwners);
        if (reason) rejected.push(reason);
        else candidates.push(block);
      }
    }
    candidates.sort(
      (a, b) =>
        dynamicNightBlockScore(a, nightDayCounts, blockCounts, requestedOwners, seed) -
        dynamicNightBlockScore(b, nightDayCounts, blockCounts, requestedOwners, seed),
    );
    return { candidates, rejected };
  };

  const dfs = (startDay: number): boolean => {
    diagnostics.nodesVisited += 1;
    if (performance.now() > deadline || diagnostics.nodesVisited > 300000) return false;
    if (startDay > days.length) return true;
    if (startDay - 1 > diagnostics.deepestDepth) {
      diagnostics.deepestDepth = startDay - 1;
      diagnostics.deepestCounts = [...nightDayCounts];
    }

    const { candidates, rejected } = candidateBlocks(startDay);
    diagnostics.rejectionReasons.push(...rejected);
    if (!diagnostics.mostConstrained || candidates.length < diagnostics.mostConstrained.candidates.length) {
      diagnostics.mostConstrained = {
        day: startDay,
        candidates: candidates.map((block) => `${EMPLOYEES[block.employeeIndex]}:${block.startDay}-${block.endDay}`),
        rejected: [...new Set(rejected)],
      };
    }
    if (candidates.length === 0) return false;

    for (const block of candidates) {
      const employee = EMPLOYEES[block.employeeIndex];
      block.days.forEach((day) => {
        schedule[day - 1][employee] = "N";
      });
      assignedBlocks.push(block);
      nightDayCounts[block.employeeIndex] += block.length;
      blockCounts[block.employeeIndex] += 1;

      const exceedsFive = wouldExceedConsecutive(schedule, parsed, block.employeeIndex, block.endDay - 1, "N");
      if (!exceedsFive && dfs(block.endDay + 1)) return true;

      blockCounts[block.employeeIndex] -= 1;
      nightDayCounts[block.employeeIndex] -= block.length;
      assignedBlocks.pop();
      block.days.forEach((day) => {
        schedule[day - 1][employee] = "/";
      });
    }
    return false;
  };

  if (!dfs(1)) {
    const constrained = diagnostics.mostConstrained;
    return {
      ok: false,
      failures: [
        "Unable to assign daily N coverage with dynamic N blocks.",
        `N recursive nodes visited: ${diagnostics.nodesVisited}.`,
        `Deepest N day assigned: ${diagnostics.deepestDepth}.`,
        `N day counts at deepest failure: ${EMPLOYEES.map((employee, index) => `${employee}:${diagnostics.deepestCounts[index]}`).join(", ")}.`,
        ...(constrained
          ? [
              `First/most constrained N day: ${constrained.day}.`,
              `Dynamic N candidates: ${constrained.candidates.length > 0 ? constrained.candidates.join(", ") : "none"}.`,
              `Candidate rejection reasons: ${constrained.rejected.length > 0 ? constrained.rejected.join(" / ") : "none"}.`,
            ]
          : []),
        ...commonFailureSummary("Top N rejection reasons", diagnostics.rejectionReasons),
      ],
    };
  }

  const lockedRecoveryOff = new Set<string>();
  assignedBlocks.forEach((block) => {
    const recoveryDay = block.endDay + 1;
    if (recoveryDay <= days.length) lockedRecoveryOff.add(offKey(block.employeeIndex, recoveryDay));
  });
  return { ok: true, schedule, lockedRecoveryOff, blockCounts };
}

function buildInitialLockedOff(parsed: ParsedEmployeeInput[]) {
  const lockedOff = new Set<string>();
  parsed.forEach((input, employeeIndex) => {
    input.fixedOff.forEach((day) => lockedOff.add(offKey(employeeIndex, day)));
  });
  return lockedOff;
}

function buildSearchLockedOff(parsed: ParsedEmployeeInput[], lockedRecoveryOff: Set<string>) {
  const lockedOff = buildInitialLockedOff(parsed);
  lockedRecoveryOff.forEach((key) => lockedOff.add(key));
  return lockedOff;
}

function requiredShiftCountForDay() {
  return 3;
}

function dailyHardOffCapacityFailures(days: DayInfo[], parsed: ParsedEmployeeInput[]) {
  const failures: string[] = [];
  days.forEach((dayInfo) => {
    const requiredShiftCount = requiredShiftCountForDay();
    const maxOff = EMPLOYEES.length - requiredShiftCount;
    const hardOffEmployees = EMPLOYEES.filter((_, employeeIndex) => parsed[employeeIndex].fixedOff.has(dayInfo.day));
    if (hardOffEmployees.length > maxOff) {
      failures.push(
        `${dayInfo.day}: hard OFF ${hardOffEmployees.length} (${hardOffEmployees.join(", ")}) exceeds max OFF ${maxOff}`,
      );
    }
  });
  return failures;
}

function lockedOffCount(lockedOff: Set<string>, employeeIndex: number) {
  let count = 0;
  lockedOff.forEach((key) => {
    if (key.startsWith(`${employeeIndex}:`)) count += 1;
  });
  return count;
}

function lockedOffCountForDay(lockedOff: Set<string>, day: number) {
  let count = 0;
  lockedOff.forEach((key) => {
    if (key.endsWith(`:${day}`)) count += 1;
  });
  return count;
}

function hasLockedOffInWindow(lockedOff: Set<string>, employeeIndex: number, startDay: number) {
  for (let day = startDay; day < startDay + 6; day += 1) {
    if (isLockedOff(lockedOff, employeeIndex, day)) return true;
  }
  return false;
}

function canLockOff(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  lockedOff: Set<string>,
  employeeIndex: number,
  day: number,
) {
  if (day < 1 || day > schedule.length) return false;
  if (isLockedOff(lockedOff, employeeIndex, day)) return false;
  if (parsed[employeeIndex].requests.has(day)) return false;
  if (lockedOffCountForDay(lockedOff, day) >= EMPLOYEES.length - requiredShiftCountForDay()) return false;
  return schedule[day - 1][EMPLOYEES[employeeIndex]] === "/";
}

function scoreOffCandidate(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  lockedOff: Set<string>,
  employeeIndex: number,
  day: number,
  seed: number,
) {
  let coveredRiskWindows = 0;
  const firstStart = Math.max(1, day - 5);
  const lastStart = Math.min(day, days.length - 5);
  for (let start = firstStart; start <= lastStart; start += 1) {
    if (!hasLockedOffInWindow(lockedOff, employeeIndex, start)) coveredRiskWindows += 1;
  }

  let nearestOffDistance = days.length;
  for (let otherDay = 1; otherDay <= days.length; otherDay += 1) {
    if (isLockedOff(lockedOff, employeeIndex, otherDay)) {
      nearestOffDistance = Math.min(nearestOffDistance, Math.abs(day - otherDay));
    }
  }

  const vacationBridge =
    parsed[employeeIndex].vacation.has(day - 1) || parsed[employeeIndex].vacation.has(day + 1) ? -8 : 0;
  const exploration = ((employeeIndex * 29 + day * 31 + seed * 17) % 13) / 10;
  const dayOffPressure = lockedOffCountForDay(lockedOff, day) * 55;
  return (
    coveredRiskWindows * 120 -
    requiredShiftCountForDay() * 10 +
    Math.min(nearestOffDistance, 6) * 3 +
    vacationBridge +
    exploration -
    dayOffPressure
  );
}

function chooseOffDay(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  lockedOff: Set<string>,
  employeeIndex: number,
  candidateDays: number[],
  seed: number,
) {
  return candidateDays
    .filter((day) => canLockOff(schedule, parsed, days, removedM, lockedOff, employeeIndex, day))
    .sort(
      (a, b) =>
        scoreOffCandidate(schedule, parsed, days, removedM, lockedOff, employeeIndex, b, seed) -
        scoreOffCandidate(schedule, parsed, days, removedM, lockedOff, employeeIndex, a, seed),
    )[0];
}

function reservePreventiveOffs(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  lockedOff: Set<string>,
  seed: number,
) {
  const failures: string[] = [];
  const inserted: string[] = [];

  parsed.forEach((_, employeeIndex) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let start = 1; start <= days.length - 5; start += 1) {
        if (hasLockedOffInWindow(lockedOff, employeeIndex, start)) continue;
        const windowDays = Array.from({ length: 6 }, (_, offset) => start + offset);
        const selectedDay = chooseOffDay(schedule, parsed, days, removedM, lockedOff, employeeIndex, windowDays, seed);
        if (selectedDay === undefined) {
          failures.push(`${EMPLOYEES[employeeIndex]} ${start}-${start + 5}: no available forced OFF in 6-day window`);
          continue;
        }
        lockedOff.add(offKey(employeeIndex, selectedDay));
        inserted.push(`${EMPLOYEES[employeeIndex]} ${selectedDay} OFF (${start}-${start + 5} 6-day window)`);
        changed = true;
      }
    }
  });

  return { failures, inserted };
}

function reservePreventiveOffsSetCover(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  lockedOff: Set<string>,
  seed: number,
) {
  const failures: string[] = [];
  const inserted: string[] = [];

  parsed.forEach((input, employeeIndex) => {
    const extraOffBudget = Math.max(0, input.targetOff - input.fixedOff.size);
    const uncoveredWindows = () =>
      Array.from({ length: Math.max(0, days.length - 5) }, (_, index) => index + 1).filter(
        (start) => !hasLockedOffInWindow(lockedOff, employeeIndex, start),
      );

    let uncovered = uncoveredWindows();
    while (uncovered.length > 0) {
      const forcedOffCount = lockedOffCount(lockedOff, employeeIndex) - input.fixedOff.size;
      if (forcedOffCount >= extraOffBudget) {
        failures.push(
          `${EMPLOYEES[employeeIndex]} ${uncovered[0]}-${uncovered[0] + 5}: OFF budget cannot cover 6-day window`,
        );
        break;
      }

      const earliestUncovered = uncovered[0];
      const selected = Array.from({ length: 6 }, (_, offset) => earliestUncovered + offset)
        .filter((day) => day >= 1 && day <= days.length)
        .filter((day) => canLockOff(schedule, parsed, days, removedM, lockedOff, employeeIndex, day))
        .map((day) => ({
          day,
          covered: uncovered.filter((start) => day >= start && day <= start + 5),
          dayLoad: lockedOffCountForDay(lockedOff, day),
        }))
        .filter((candidate) => candidate.covered.length > 0)
        .sort((a, b) => {
          const coverageDiff = b.covered.length - a.covered.length;
          if (coverageDiff !== 0) return coverageDiff;
          const loadDiff = a.dayLoad - b.dayLoad;
          if (loadDiff !== 0) return loadDiff;
          return b.day - a.day || ((a.day + seed) % 3) - ((b.day + seed) % 3);
        })[0];

      if (!selected) {
        failures.push(`${EMPLOYEES[employeeIndex]} ${uncovered[0]}-${uncovered[0] + 5}: no insertable forced OFF day`);
        break;
      }

      lockedOff.add(offKey(employeeIndex, selected.day));
      inserted.push(
        `${EMPLOYEES[employeeIndex]} ${selected.day} OFF (${selected.covered.map((start) => `${start}-${start + 5}`).join(", ")} windows)`,
      );
      uncovered = uncoveredWindows();
    }
  });

  return { failures, inserted };
}

function reserveMinimumOffs(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  lockedOff: Set<string>,
  seed: number,
) {
  const failures: string[] = [];

  parsed.forEach((input, employeeIndex) => {
    while (lockedOffCount(lockedOff, employeeIndex) < input.minOff) {
      const allDays = days.map((day) => day.day);
      const selectedDay = chooseOffDay(schedule, parsed, days, removedM, lockedOff, employeeIndex, allDays, seed);
      if (selectedDay === undefined) {
        failures.push(`${EMPLOYEES[employeeIndex]}: unable to reserve minimum OFF count ${input.minOff}.`);
        break;
      }
      lockedOff.add(offKey(employeeIndex, selectedDay));
    }
  });

  return failures;
}

function reserveGeneratorOffs(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  removedM: Set<number>,
  seed: number,
  baseLockedOff = new Set<string>(),
) {
  const lockedOff = buildInitialLockedOff(parsed);
  baseLockedOff.forEach((key) => lockedOff.add(key));
  const preventive = reservePreventiveOffsSetCover(schedule, parsed, days, removedM, lockedOff, seed);
  const failures = [...preventive.failures];
  return { lockedOff, failures, forcedOffs: preventive.inserted };
}

function cloneCounts() {
  return EMPLOYEES.map(() => ({ D: 0, E: 0, M: 0, N: 0 }));
}

function recomputeCounts(schedule: Schedule) {
  const workCounts = EMPLOYEES.map(() => 0);
  const shiftCounts = cloneCounts();
  schedule.forEach((row) => {
    EMPLOYEES.forEach((employee, index) => {
      const shift = row[employee];
      if (shift !== "/") {
        workCounts[index] += 1;
        shiftCounts[index][shift] += 1;
      }
    });
  });
  return { workCounts, shiftCounts };
}

function dayConstraintScore(dayIndex: number, parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const day = dayIndex + 1;
  const hardOffCount = parsed.filter((input) => input.fixedOff.has(day)).length;
  const requestCodes = parsed.map((input) => input.requests.get(day)).filter(Boolean) as WorkShift[];
  const hasNRequest = requestCodes.includes("N");
  return (
    (hasNRequest ? 10000 : 0) +
    hardOffCount * 1200 +
    requestCodes.length * 800 +
    (days[dayIndex].isRestDay ? 400 : 0)
  );
}

function buildSearchSlots(slots: Slot[], schedule: Schedule, parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  return slots
    .filter((slot) => !EMPLOYEES.some((employee) => schedule[slot.dayIndex][employee] === slot.code))
    .sort((a, b) => a.dayIndex - b.dayIndex || SLOT_PRIORITY[a.code] - SLOT_PRIORITY[b.code])
    .map((slot) => slot);
}

function scoreCandidate(
  attempt: Attempt,
  parsed: ParsedEmployeeInput[],
  slot: Slot,
  employeeIndex: number,
  days: DayInfo[],
  seed: number,
  preferredMDays = new Set<number>(),
) {
  const day = slot.dayIndex + 1;
  const employee = EMPLOYEES[employeeIndex];
  const counts = attempt.shiftCounts[employeeIndex];
  const exploration = seed === 0 ? 0 : ((employeeIndex * 17 + day * 13 + seed * 23 + slot.code.charCodeAt(0)) % 11) * 2.5;
  let score = attempt.workCounts[employeeIndex] * 8;
  if (slot.code === "N") score += counts.N * 45;
  score += counts[slot.code] * 12;
  if (parsed[employeeIndex].requests.get(day) === slot.code) score -= 90;
  if (slot.code === "D") score -= 5;
  if (slot.code === "N") score += 8;
  if (days[slot.dayIndex].isHoliday) score += counts.D + counts.E + counts.M + counts.N;
  if (parsed[employeeIndex].vacation.has(day + 1) && slot.code === "D") score -= 18;
  if (parsed[employeeIndex].vacation.has(day - 1) && slot.code === "N") score -= 18;
  const projectedOff = days.length - (attempt.workCounts[employeeIndex] + 1);
  if (parsed[employeeIndex].vacation.size > 0 && projectedOff < parsed[employeeIndex].targetOff) score += 180;
  score -= Math.max(0, projectedOff - parsed[employeeIndex].minOff) * 3;
  const prev = attempt.schedule[slot.dayIndex - 1]?.[employee];
  if (prev !== "/" && prev !== undefined) score += 8;
  if (preferredMDays.has(day)) {
    const candidate = attempt.schedule.map((row) => ({ ...row })) as Schedule;
    candidate[slot.dayIndex][employee] = slot.code;
    const lockedOff = attempt.lockedOff;
    const canStillAssignM = EMPLOYEES.some((_, index) => canReserveMForPartial(candidate, parsed, lockedOff, index, slot.dayIndex));
    if (!canStillAssignM) score += 260;
    else if (canReserveMForPartial(attempt.schedule, parsed, lockedOff, employeeIndex, slot.dayIndex)) score += 35;
  }
  return score + exploration;
}

function candidatesForSlot(attempt: Attempt, parsed: ParsedEmployeeInput[], slot: Slot, maxWork: number[]) {
  return EMPLOYEES.map((_, index) => index).filter((index) => canAssign(attempt, parsed, slot, index, maxWork));
}

function selectNextSlotIndex(attempt: Attempt, searchSlots: Slot[], parsed: ParsedEmployeeInput[], maxWork: number[]) {
  let bestIndex = attempt.slotIndex;
  let bestCandidateCount = Number.POSITIVE_INFINITY;
  for (let index = attempt.slotIndex; index < searchSlots.length; index += 1) {
    const candidateCount = candidatesForSlot(attempt, parsed, searchSlots[index], maxWork).length;
    if (
      candidateCount < bestCandidateCount ||
      (candidateCount === bestCandidateCount &&
        (searchSlots[index].dayIndex < searchSlots[bestIndex].dayIndex ||
          (searchSlots[index].dayIndex === searchSlots[bestIndex].dayIndex &&
            SLOT_PRIORITY[searchSlots[index].code] < SLOT_PRIORITY[searchSlots[bestIndex].code])))
    ) {
      bestIndex = index;
      bestCandidateCount = candidateCount;
      if (candidateCount === 0) break;
    }
  }
  return bestIndex;
}

function search(
  attempt: Attempt,
  searchSlots: Slot[],
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  maxWork: number[],
  calls: { count: number },
  seed: number,
  preferredMDays = new Set<number>(),
): boolean {
  calls.count += 1;
  if (calls.count > MAX_ATTEMPTS || performance.now() > attempt.deadline) return false;
  if (attempt.slotIndex >= searchSlots.length) {
    return validateHard(attempt.schedule, parsed, days).length === 0;
  }

  const nextSlotIndex = selectNextSlotIndex(attempt, searchSlots, parsed, maxWork);
  const slotAtCurrent = searchSlots[attempt.slotIndex];
  searchSlots[attempt.slotIndex] = searchSlots[nextSlotIndex];
  searchSlots[nextSlotIndex] = slotAtCurrent;
  const slot = searchSlots[attempt.slotIndex];
  const candidates = candidatesForSlot(attempt, parsed, slot, maxWork)
    .sort((a, b) => scoreCandidate(attempt, parsed, slot, a, days, seed, preferredMDays) - scoreCandidate(attempt, parsed, slot, b, days, seed, preferredMDays));

  for (const employeeIndex of candidates) {
    const employee = EMPLOYEES[employeeIndex];
    attempt.schedule[slot.dayIndex][employee] = slot.code;
    attempt.workCounts[employeeIndex] += 1;
    attempt.shiftCounts[employeeIndex][slot.code] += 1;
    attempt.slotIndex += 1;

    if (search(attempt, searchSlots, parsed, days, maxWork, calls, seed, preferredMDays)) return true;

    attempt.slotIndex -= 1;
    attempt.shiftCounts[employeeIndex][slot.code] -= 1;
    attempt.workCounts[employeeIndex] -= 1;
    attempt.schedule[slot.dayIndex][employee] = "/";
  }
  searchSlots[nextSlotIndex] = searchSlots[attempt.slotIndex];
  searchSlots[attempt.slotIndex] = slotAtCurrent;
  return false;
}

function collectSearchSolutions(
  attempt: Attempt,
  searchSlots: Slot[],
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  maxWork: number[],
  calls: { count: number },
  seed: number,
  preferredMDays: Set<number>,
  limit: number,
  solutions: Schedule[],
) {
  if (solutions.length >= limit) return;
  calls.count += 1;
  if (calls.count > MAX_ATTEMPTS || performance.now() > attempt.deadline) return;
  if (attempt.slotIndex >= searchSlots.length) {
    if (validateHard(attempt.schedule, parsed, days).length === 0) {
      solutions.push(attempt.schedule.map((row) => ({ ...row })) as Schedule);
    }
    return;
  }

  const nextSlotIndex = selectNextSlotIndex(attempt, searchSlots, parsed, maxWork);
  const slotAtCurrent = searchSlots[attempt.slotIndex];
  searchSlots[attempt.slotIndex] = searchSlots[nextSlotIndex];
  searchSlots[nextSlotIndex] = slotAtCurrent;
  const slot = searchSlots[attempt.slotIndex];
  const candidates = candidatesForSlot(attempt, parsed, slot, maxWork)
    .sort((a, b) => scoreCandidate(attempt, parsed, slot, a, days, seed, preferredMDays) - scoreCandidate(attempt, parsed, slot, b, days, seed, preferredMDays));

  for (const employeeIndex of candidates) {
    if (solutions.length >= limit) break;
    const employee = EMPLOYEES[employeeIndex];
    attempt.schedule[slot.dayIndex][employee] = slot.code;
    attempt.workCounts[employeeIndex] += 1;
    attempt.shiftCounts[employeeIndex][slot.code] += 1;
    attempt.slotIndex += 1;

    collectSearchSolutions(attempt, searchSlots, parsed, days, maxWork, calls, seed, preferredMDays, limit, solutions);

    attempt.slotIndex -= 1;
    attempt.shiftCounts[employeeIndex][slot.code] -= 1;
    attempt.workCounts[employeeIndex] -= 1;
    attempt.schedule[slot.dayIndex][employee] = "/";
  }
  searchSlots[nextSlotIndex] = searchSlots[attempt.slotIndex];
  searchSlots[attempt.slotIndex] = slotAtCurrent;
}

function validateHard(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  relaxations: { nightSpacing?: boolean; nOD?: boolean } = {},
  quota?: MonthlyQuotaPlan,
) {
  const failures: string[] = [];
  const derivedNightBlocks = deriveNightBlocks(schedule);
  const tripleNightBlocks = derivedNightBlocks.filter((block) => block.days.length === 3);
  if (tripleNightBlocks.length > 0 && (days.length % 2 === 0 || tripleNightBlocks.length > 1)) {
    failures.push("NNN is only allowed at most once in odd-total-N months.");
  }

  EMPLOYEES.forEach((employee, employeeIndex) => {
    let streak = trailingPreviousWorkStreak(parsed, employeeIndex);
    const previousLimit = -previousTailFor(parsed, employeeIndex).length;
    const shiftAt = (dayIndex: number) => getShiftAtWithPrev(schedule, parsed, dayIndex, employeeIndex);
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const day = dayIndex + 1;
      const rawShift = schedule[dayIndex][employee];
      const current = shiftAt(dayIndex);
      const prev = shiftAt(dayIndex - 1);
      const prevPrev = shiftAt(dayIndex - 2);
      if (parsed[employeeIndex].fixedOff.has(day) && rawShift !== "/") {
        failures.push(`${employee} day ${day}: work assigned on mandatory OFF/vacation/wanted OFF/education date`);
      }
      if (isOffLike(current)) {
        streak = 0;
      } else {
        streak += 1;
        if (streak > 5) failures.push(`${employee}: more than 5 consecutive work days`);
      }
      if (current === "D" && isEveningLike(prev)) failures.push(`${employee} day ${day}: E/M -> D pattern is forbidden`);
      if (prev === "N" && !isOffLike(current) && current !== "N") failures.push(`${employee} day ${day}: after N, ${current} is forbidden`);
      if (current === "N" && prev === "N" && prevPrev === "N" && shiftAt(dayIndex - 3) === "N") {
        failures.push(`${employee} day ${day}: NNNN or longer is forbidden`);
      }
      if (!relaxations.nOD && current === "D" && isOffLike(prev) && prevPrev === "N") failures.push(`${employee} day ${day}: N-O-D pattern is forbidden`);
      if (!relaxations.nightSpacing && nightSpacingViolation(shiftAt, dayIndex, current, previousLimit)) {
        failures.push(
          `${employee} day ${day}: night spacing conflict: requires at least ${MIN_NON_N_DAYS_BETWEEN_N_BLOCKS} non-N days between N blocks`,
        );
      }
    }
    const offCount = schedule.filter((row) => row[employee] === "/").length;
    const offTarget = quota?.offTargets[employeeIndex] ?? parsed[employeeIndex].minOff;
    if (offCount !== offTarget) {
      failures.push(`${employee}: OFF count ${offCount} does not equal target ${offTarget}`);
    }
    if (quota) {
      const workCount = schedule.filter((row) => row[employee] !== "/").length;
      if (workCount !== quota.workTargets[employeeIndex]) {
        failures.push(`${employee}: work count ${workCount} does not equal target ${quota.workTargets[employeeIndex]}`);
      }
    }
  });

  derivedNightBlocks.forEach((block) => {
    const employee = EMPLOYEES[block.employeeIndex];
    if (block.days.length > 3) failures.push(`${employee} ${block.startDay}-${block.endDay}: NNNN or longer is forbidden`);
    const recoveryDay = block.endDay + 1;
    if (recoveryDay <= days.length && schedule[recoveryDay - 1][employee] !== "/") {
      failures.push(`${employee} day ${recoveryDay}: night recovery OFF required`);
    }
  });

  days.forEach((dayInfo, dayIndex) => {
    const row = schedule[dayIndex];
    const counts = SHIFTS.reduce((acc, code) => ({ ...acc, [code]: EMPLOYEES.filter((employee) => row[employee] === code).length }), {} as Record<WorkShift, number>);
    if (counts.D !== 1) failures.push(`${dayInfo.day} day D count ${counts.D}`);
    if (counts.E !== 1) failures.push(`${dayInfo.day} day E count ${counts.E}`);
    if (counts.N !== 1) failures.push(`${dayInfo.day} day N count ${counts.N}`);
    if (counts.M > 1) failures.push(`${dayInfo.day} day M count ${counts.M}`);
    if (counts.M > 0 && parsed.some((input) => input.vacation.has(dayInfo.day))) {
      failures.push(`${dayInfo.day} day M is forbidden because at least one employee is on vacation`);
    }
  });
  const nCounts = EMPLOYEES.map((employee) => schedule.filter((row) => row[employee] === "N").length);
  const minN = Math.floor(days.length / EMPLOYEES.length);
  const maxN = Math.ceil(days.length / EMPLOYEES.length);
  const expectedMaxCount = days.length % EMPLOYEES.length;
  const actualMaxCount = nCounts.filter((count) => count === maxN).length;
  if (quota && !nightQuotaFinalValid(nCounts, quota)) {
    failures.push(
      `${quota.nTargetMode === "unified" ? "Unified" : "Exact"} N target failed: ${EMPLOYEES.map((employee, index) => `${employee} ${nCounts[index]}/${quota.nMinTargets[index]}-${quota.nMaxTargets[index]}`).join(", ")}`,
    );
  } else if (!quota && (nCounts.some((count) => count < minN || count > maxN) || (maxN > minN && actualMaxCount !== expectedMaxCount))) {
    failures.push(`Exact N target failed: ${EMPLOYEES.map((employee, index) => `${employee} ${nCounts[index]}`).join(", ")}`);
  }
  if (quota) {
    const totalM = schedule.reduce((sum, row) => sum + (EMPLOYEES.some((employee) => row[employee] === "M") ? 1 : 0), 0);
    if (totalM !== quota.requiredM) failures.push(`Required M ${quota.requiredM}; assigned M ${totalM}.`);
  }
  return [...new Set(failures)];
}

function respectsLockedOff(schedule: Schedule, lockedOff: Set<string>) {
  for (const key of lockedOff) {
    const [employeeIndexText, dayText] = key.split(":");
    const employeeIndex = Number(employeeIndexText);
    const dayIndex = Number(dayText) - 1;
    const employee = EMPLOYEES[employeeIndex];
    if (employee && schedule[dayIndex]?.[employee] !== "/") return false;
  }
  return true;
}

function computeStats(schedule: Schedule, days: DayInfo[]): EmployeeStats[] {
  return EMPLOYEES.map((employee) => {
    const stats: EmployeeStats = {
      employee,
      D: 0,
      evening: 0,
      N: 0,
      off: 0,
      saturday: 0,
      sunday: 0,
      holiday: 0,
      weekendTwoOff: false,
      totalWork: 0,
    };
    schedule.forEach((row, index) => {
      const shift = row[employee];
      if (shift === "/") stats.off += 1;
      else {
        stats.totalWork += 1;
        if (shift === "D") stats.D += 1;
        if (shift === "E" || shift === "M") stats.evening += 1;
        if (shift === "N") stats.N += 1;
        if (days[index].isSaturday) stats.saturday += 1;
        if (days[index].isSunday) stats.sunday += 1;
        if (days[index].isHoliday) stats.holiday += 1;
      }
    });
    for (let i = 0; i < days.length - 1; i += 1) {
      if (days[i].isSaturday && days[i + 1].isSunday && schedule[i][employee] === "/" && schedule[i + 1][employee] === "/") {
        stats.weekendTwoOff = true;
      }
    }
    return stats;
  });
}

function range(values: number[]) {
  return Math.max(...values) - Math.min(...values);
}

function computeBalanceStats(stats: EmployeeStats[]) {
  return {
    dRange: range(stats.map((item) => item.D)),
    eveningRange: range(stats.map((item) => item.evening)),
  };
}

function tier2Score(schedule: Schedule, days: DayInfo[], parsed: ParsedEmployeeInput[]) {
  const stats = computeStats(schedule, days);
  const variance = (values: number[]) => {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  };
  let score = 0;
  score += variance(stats.map((item) => item.totalWork)) * 12;
  score += variance(stats.map((item) => item.D)) * 8;
  score += variance(stats.map((item) => item.evening)) * 8;
  score += Math.max(0, range(stats.map((item) => item.D)) - 3) * 90;
  score += Math.max(0, range(stats.map((item) => item.evening)) - 3) * 90;
  if (Math.min(...stats.map((item) => item.D)) <= 2 && Math.max(...stats.map((item) => item.D)) >= 6) score += 160;
  if (Math.min(...stats.map((item) => item.evening)) <= 2 && Math.max(...stats.map((item) => item.evening)) >= 6) score += 160;
  score += variance(stats.map((item) => item.N)) * 20;
  score += variance(stats.map((item) => item.saturday)) * 8;
  score += variance(stats.map((item) => item.sunday)) * 8;
  score += variance(stats.map((item) => item.holiday)) * 8;
  score += stats.filter((item) => !item.weekendTwoOff).length * 20;
  stats.forEach((item, index) => {
    score += Math.max(0, parsed[index].targetOff - item.off) * 6;
    score += item.N * 3 - item.D;
  });
  return Math.round(score * 100) / 100;
}

function improve(schedule: Schedule, parsed: ParsedEmployeeInput[], days: DayInfo[], lockedOff: Set<string>) {
  let best = schedule.map((row) => ({ ...row })) as Schedule;
  let bestScore = tier2Score(best, days, parsed);

  for (let pass = 0; pass < 80; pass += 1) {
    let passBest: Schedule | null = null;
    let passBestScore = bestScore;

    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      for (let a = 0; a < EMPLOYEES.length; a += 1) {
        for (let b = a + 1; b < EMPLOYEES.length; b += 1) {
          const employeeA = EMPLOYEES[a];
          const employeeB = EMPLOYEES[b];
          if (best[dayIndex][employeeA] === best[dayIndex][employeeB]) continue;

          const candidate = best.map((row) => ({ ...row })) as Schedule;
          const temp = candidate[dayIndex][employeeA];
          candidate[dayIndex][employeeA] = candidate[dayIndex][employeeB];
          candidate[dayIndex][employeeB] = temp;
          if (!respectsLockedOff(candidate, lockedOff)) continue;
          if (validateHard(candidate, parsed, days).length > 0) continue;

          const score = tier2Score(candidate, days, parsed);
          if (score < passBestScore) {
            passBest = candidate;
            passBestScore = score;
          }
        }
      }
    }

    if (!passBest) {
      for (let firstDayIndex = 0; firstDayIndex < days.length; firstDayIndex += 1) {
        for (let secondDayIndex = firstDayIndex + 1; secondDayIndex < days.length; secondDayIndex += 1) {
          for (let a = 0; a < EMPLOYEES.length; a += 1) {
            for (let b = a + 1; b < EMPLOYEES.length; b += 1) {
              const employeeA = EMPLOYEES[a];
              const employeeB = EMPLOYEES[b];
              if (
                best[firstDayIndex][employeeA] === best[firstDayIndex][employeeB] &&
                best[secondDayIndex][employeeA] === best[secondDayIndex][employeeB]
              ) {
                continue;
              }

              const candidate = best.map((row) => ({ ...row })) as Schedule;
              const firstTemp = candidate[firstDayIndex][employeeA];
              candidate[firstDayIndex][employeeA] = candidate[firstDayIndex][employeeB];
              candidate[firstDayIndex][employeeB] = firstTemp;

              const secondTemp = candidate[secondDayIndex][employeeA];
              candidate[secondDayIndex][employeeA] = candidate[secondDayIndex][employeeB];
              candidate[secondDayIndex][employeeB] = secondTemp;
              if (!respectsLockedOff(candidate, lockedOff)) continue;
              if (validateHard(candidate, parsed, days).length > 0) continue;

              const score = tier2Score(candidate, days, parsed);
              if (score < passBestScore) {
                passBest = candidate;
                passBestScore = score;
              }
            }
          }
        }
      }
    }

    if (!passBest) break;
    best = passBest;
    bestScore = passBestScore;

    const balance = computeBalanceStats(computeStats(best, days));
    if (balance.dRange <= 1 && balance.eveningRange <= 1) {
      break;
    }
  }
  return { schedule: best, score: bestScore };
}

type MPostProcessResult = {
  schedule: Schedule;
  removedM: number[];
  desiredWeekendHolidayMCount: number;
  assignedWeekendHolidayMCount: number;
  removedWeekendHolidayMCount: number;
  weekdayCompensationMCount: number;
  uncompensatedMCount: number;
  warnings: string[];
};

type MDayDiagnostic = {
  day: number;
  candidates: string[];
  rejections: string[];
  repairAttempted: boolean;
  repairFailure: string;
};

function currentMCount(schedule: Schedule, dayIndex: number) {
  return EMPLOYEES.filter((employee) => schedule[dayIndex][employee] === "M").length;
}

function canReserveMForPartial(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  lockedOff: Set<string>,
  employeeIndex: number,
  dayIndex: number,
) {
  const employee = EMPLOYEES[employeeIndex];
  const day = dayIndex + 1;
  if (schedule[dayIndex][employee] !== "/") return false;
  if (isLockedOff(lockedOff, employeeIndex, day)) return false;
  if (isFixedOff(parsed, employeeIndex, day)) return false;
  if (wouldExceedConsecutive(schedule, parsed, employeeIndex, dayIndex, "M")) return false;
  if (hasKnownPatternViolation(schedule, parsed, employeeIndex, dayIndex, "M")) return false;
  const next = getShiftAtWithPrev(schedule, parsed, dayIndex + 1, employeeIndex);
  if (next === "D") return false;
  return true;
}

function canTryAddMReason(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  employeeIndex: number,
  dayIndex: number,
) {
  const employee = EMPLOYEES[employeeIndex];
  const day = dayIndex + 1;
  if (schedule[dayIndex][employee] !== "/") return `already assigned ${schedule[dayIndex][employee]}`;
  if (isLockedOff(lockedOff, employeeIndex, day)) return "locked recovery OFF";
  if (isFixedOff(parsed, employeeIndex, day)) return "fixedOff/vacation/wantedOff";

  const candidate = schedule.map((row) => ({ ...row })) as Schedule;
  candidate[dayIndex][employee] = "M";
  const failures = validateHard(candidate, parsed, days).filter((failure) => failure.includes(employee) || failure.includes("Non-leave"));
  if (failures.length === 0) return null;
  const first = failures[0];
  if (first.includes("E/M -> D")) return "E/M -> D";
  if (first.includes("more than 5 consecutive")) return "max consecutive work";
  if (first.includes("OFF count")) return "minOff";
  if (first.includes("Non-leave")) return "non-leave OFF balance";
  if (first.includes("N-O-D")) return "N-O-D";
  if (first.includes("fixed OFF")) return "fixedOff/vacation/wantedOff";
  return first;
}

function canTryAddM(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  employeeIndex: number,
  dayIndex: number,
) {
  return canTryAddMReason(schedule, parsed, days, lockedOff, employeeIndex, dayIndex) === null;
}

function scoreMCandidate(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  employeeIndex: number,
  dayIndex: number,
  seed: number,
) {
  const stats = computeStats(schedule, days)[employeeIndex];
  const day = dayIndex + 1;
  const requested = normalizeShift(parsed[employeeIndex].requests.get(day));
  const exploration = ((employeeIndex * 19 + day * 23 + seed * 31) % 17) / 10;
  return (
    stats.totalWork * 14 +
    stats.evening * 10 +
    stats.holiday * (days[dayIndex].isHoliday ? 3 : 0) +
    (requested === "M" ? -100 : 0) +
    exploration
  );
}

function mCandidates(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  dayIndex: number,
  seed: number,
) {
  return EMPLOYEES.map((_, index) => index)
    .filter((index) => canTryAddM(schedule, parsed, days, lockedOff, index, dayIndex))
    .sort((a, b) => scoreMCandidate(schedule, parsed, days, a, dayIndex, seed) - scoreMCandidate(schedule, parsed, days, b, dayIndex, seed));
}

function addOneM(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  dayIndex: number,
  seed: number,
) {
  const employeeIndex = mCandidates(schedule, parsed, days, lockedOff, dayIndex, seed)[0];
  if (employeeIndex === undefined) return false;
  schedule[dayIndex][EMPLOYEES[employeeIndex]] = "M";
  return true;
}

function mDayDiagnostic(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  day: number,
  repairAttempted = false,
  repairFailure = "not attempted",
): MDayDiagnostic {
  const dayIndex = day - 1;
  const candidates = EMPLOYEES.filter((_, employeeIndex) => canTryAddM(schedule, parsed, days, lockedOff, employeeIndex, dayIndex));
  const rejections = EMPLOYEES.map((employee, employeeIndex) => {
    const reason = canTryAddMReason(schedule, parsed, days, lockedOff, employeeIndex, dayIndex);
    return reason ? `${employee}: ${reason}` : "";
  }).filter(Boolean);
  return {
    day,
    candidates,
    rejections,
    repairAttempted,
    repairFailure,
  };
}

function tryLocalRepairForM(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  dayIndex: number,
  seed: number,
) {
  const shiftsToMove: WorkShift[] = ["D", "E"];
  for (const shift of shiftsToMove) {
    const currentEmployee = EMPLOYEES.find((employee) => schedule[dayIndex][employee] === shift);
    if (!currentEmployee) continue;
    const currentIndex = EMPLOYEES.indexOf(currentEmployee);
    for (const replacementIndex of EMPLOYEES.map((_, index) => index).sort((a, b) => seededNoise(seed, dayIndex, a) - seededNoise(seed, dayIndex, b))) {
      const replacement = EMPLOYEES[replacementIndex];
      if (replacementIndex === currentIndex || schedule[dayIndex][replacement] !== "/") continue;
      const candidate = schedule.map((row) => ({ ...row })) as Schedule;
      candidate[dayIndex][currentEmployee] = "/";
      candidate[dayIndex][replacement] = shift;
      if (validateHard(candidate, parsed, days).length > 0) continue;
      if (canTryAddM(candidate, parsed, days, lockedOff, currentIndex, dayIndex)) {
        candidate[dayIndex][currentEmployee] = "M";
        if (validateHard(candidate, parsed, days).length === 0) return candidate;
      }
    }
  }

  const nextDayIndex = dayIndex + 1;
  if (nextDayIndex < days.length) {
    for (const potentialMIndex of EMPLOYEES.map((_, index) => index)) {
      const potentialMEmployee = EMPLOYEES[potentialMIndex];
      if (schedule[dayIndex][potentialMEmployee] !== "/" || schedule[nextDayIndex][potentialMEmployee] !== "D") continue;
      for (const replacementIndex of EMPLOYEES.map((_, index) => index)) {
        const replacement = EMPLOYEES[replacementIndex];
        if (replacementIndex === potentialMIndex || schedule[nextDayIndex][replacement] !== "/") continue;
        const candidate = schedule.map((row) => ({ ...row })) as Schedule;
        candidate[nextDayIndex][potentialMEmployee] = "/";
        candidate[nextDayIndex][replacement] = "D";
        if (validateHard(candidate, parsed, days).length > 0) continue;
        if (canTryAddM(candidate, parsed, days, lockedOff, potentialMIndex, dayIndex)) {
          candidate[dayIndex][potentialMEmployee] = "M";
          if (validateHard(candidate, parsed, days).length === 0) return candidate;
        }
      }
    }
  }
  return null;
}

function optimizeWeekendHolidayM(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  desiredDays: number[],
  seed: number,
) {
  let best = schedule.map((row) => ({ ...row })) as Schedule;
  let bestAssigned = -1;
  let nodes = 0;
  const deadline = performance.now() + 900;

  const dfs = (current: Schedule, remainingDays: number[], assigned: number) => {
    nodes += 1;
    if (performance.now() > deadline || nodes > 12000) return;
    if (assigned + remainingDays.length < bestAssigned) return;
    if (remainingDays.length === 0) {
      if (assigned > bestAssigned || (assigned === bestAssigned && tier2Score(current, days, parsed) < tier2Score(best, days, parsed))) {
        best = current.map((row) => ({ ...row })) as Schedule;
        bestAssigned = assigned;
      }
      return;
    }

    const ordered = [...remainingDays].sort((a, b) => {
      const aCandidates = mCandidates(current, parsed, days, lockedOff, a - 1, seed).length;
      const bCandidates = mCandidates(current, parsed, days, lockedOff, b - 1, seed).length;
      return aCandidates - bCandidates || a - b;
    });
    const day = ordered[0];
    const nextRemaining = ordered.slice(1);
    const dayIndex = day - 1;
    const candidates = mCandidates(current, parsed, days, lockedOff, dayIndex, seed + day);

    for (const employeeIndex of candidates) {
      const candidate = current.map((row) => ({ ...row })) as Schedule;
      candidate[dayIndex][EMPLOYEES[employeeIndex]] = "M";
      if (validateHard(candidate, parsed, days).length === 0) dfs(candidate, nextRemaining, assigned + 1);
    }
    dfs(current, nextRemaining, assigned);
  };

  dfs(schedule.map((row) => ({ ...row })) as Schedule, desiredDays, 0);
  return { schedule: best, assigned: Math.max(0, bestAssigned) };
}

function postProcessM(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  desiredMDays: Set<number>,
  initiallyRemovedMDays: number[],
  seed: number,
): MPostProcessResult {
  const desiredWeekendHolidayDays = [...new Set([...desiredMDays, ...initiallyRemovedMDays])].sort((a, b) => a - b);
  let optimized = optimizeWeekendHolidayM(schedule, parsed, days, lockedOff, desiredWeekendHolidayDays, seed).schedule;
  const repairDiagnostics = new Map<number, MDayDiagnostic>();

  for (const day of desiredWeekendHolidayDays) {
    const dayIndex = day - 1;
    if (currentMCount(optimized, dayIndex) > 0) continue;
    const repaired = tryLocalRepairForM(optimized, parsed, days, lockedOff, dayIndex, seed + day);
    if (repaired) {
      optimized = repaired;
    } else {
      repairDiagnostics.set(day, mDayDiagnostic(optimized, parsed, days, lockedOff, day, true, "bounded D/E swap and next-day D move could not free a feasible M employee"));
    }
  }

  const assignedWeekendHolidayMCount = desiredWeekendHolidayDays.filter((day) => currentMCount(optimized, day - 1) > 0).length;
  const removed = new Set(desiredWeekendHolidayDays.filter((day) => currentMCount(optimized, day - 1) === 0));
  let result = optimized.map((row) => ({ ...row })) as Schedule;

  let weekdayCompensationMCount = 0;
  const weekdayIndexes = days
    .map((dayInfo, index) => ({ dayInfo, index }))
    .filter(({ dayInfo }) => !dayInfo.isRestDay)
    .map(({ index }) => index);

  [...removed].sort((a, b) => a - b).forEach((removedDay, offset) => {
    const selectedDayIndex = weekdayIndexes
      .filter((dayIndex) => currentMCount(result, dayIndex) === 0)
      .filter((dayIndex) => EMPLOYEES.some((_, employeeIndex) => canTryAddM(result, parsed, days, lockedOff, employeeIndex, dayIndex)))
      .sort((a, b) => {
        const aBest = Math.min(
          ...EMPLOYEES.map((_, employeeIndex) =>
            canTryAddM(result, parsed, days, lockedOff, employeeIndex, a)
              ? scoreMCandidate(result, parsed, days, employeeIndex, a, seed + removedDay + offset)
              : Number.POSITIVE_INFINITY,
          ),
        );
        const bBest = Math.min(
          ...EMPLOYEES.map((_, employeeIndex) =>
            canTryAddM(result, parsed, days, lockedOff, employeeIndex, b)
              ? scoreMCandidate(result, parsed, days, employeeIndex, b, seed + removedDay + offset)
              : Number.POSITIVE_INFINITY,
          ),
        );
        return aBest - bBest || a - b;
      })[0];
    if (selectedDayIndex !== undefined && addOneM(result, parsed, days, lockedOff, selectedDayIndex, seed + removedDay + offset)) {
      weekdayCompensationMCount += 1;
    }
  });

  const desiredWeekendHolidayMCount = desiredMDays.size + initiallyRemovedMDays.length;
  const removedWeekendHolidayMCount = removed.size;
  const uncompensatedMCount = Math.max(0, removedWeekendHolidayMCount - weekdayCompensationMCount);
  const warnings = [
    `M service: desired weekend/holiday ${desiredWeekendHolidayMCount}, assigned weekend/holiday ${assignedWeekendHolidayMCount}, removed weekend/holiday ${removedWeekendHolidayMCount}, weekday compensation ${weekdayCompensationMCount}, uncompensated ${uncompensatedMCount}.`,
  ];
  if (removedWeekendHolidayMCount > 0) {
    warnings.push(`Removed weekend/holiday M days: ${listDays([...removed].sort((a, b) => a - b))}.`);
    [...removed].sort((a, b) => a - b).forEach((day) => {
      const diagnostic = repairDiagnostics.get(day) ?? mDayDiagnostic(result, parsed, days, lockedOff, day, false, "not attempted");
      warnings.push(
        `Removed M day ${day}: candidates ${diagnostic.candidates.length > 0 ? diagnostic.candidates.join(", ") : "none"}; rejected ${
          diagnostic.rejections.length > 0 ? diagnostic.rejections.join(" / ") : "none"
        }; repair ${diagnostic.repairAttempted ? "attempted" : "not attempted"}; ${diagnostic.repairFailure}.`,
      );
    });
  }
  if (uncompensatedMCount > 0) {
    warnings.push(`${uncompensatedMCount} removed weekend/holiday M shift(s) could not be compensated on weekdays.`);
  }
  const finalHardFailures = validateHard(result, parsed, days);
  if (finalHardFailures.length > 0) {
    warnings.push(`M post-processing kept the core schedule because tentative M changes had hard-rule issues: ${finalHardFailures.join(" / ")}`);
    result = schedule.map((row) => ({ ...row })) as Schedule;
  }

  return {
    schedule: result,
    removedM: [...removed].sort((a, b) => a - b),
    desiredWeekendHolidayMCount: desiredWeekendHolidayDays.length,
    assignedWeekendHolidayMCount,
    removedWeekendHolidayMCount,
    weekdayCompensationMCount,
    uncompensatedMCount,
    warnings,
  };
}

function mPreservationScore(schedule: Schedule, days: DayInfo[], parsed: ParsedEmployeeInput[], mPostProcess: MPostProcessResult) {
  const balance = computeBalanceStats(computeStats(schedule, days));
  const stats = computeStats(schedule, days);
  const night = nightScheduleSummary(schedule);
  const workCounts = stats.map((item) => item.totalWork);
  const offCounts = stats.map((item) => item.off);
  const balancePenalty =
    balance.dRange * 35 +
    balance.eveningRange * 25 +
    range(workCounts) * 20 +
    range(offCounts) * 20 +
    night.singles * 35 +
    night.triples * 1800 +
    range(night.dayCounts) * 180 +
    range(night.blockCounts) * 80 +
    tier2Score(schedule, days, parsed);
  return (
    mPostProcess.assignedWeekendHolidayMCount * 100000 -
    mPostProcess.removedWeekendHolidayMCount * 100000 +
    mPostProcess.weekdayCompensationMCount * 1000 -
    mPostProcess.uncompensatedMCount * 5000 -
    balancePenalty
  );
}

function nightPlanSignature(schedule: Schedule) {
  return deriveNightBlocks(schedule)
    .map((block) => `${block.startDay}-${block.endDay}:${EMPLOYEES[block.employeeIndex]}`)
    .join("|");
}

function nightScheduleSummary(schedule: Schedule) {
  const blocks = deriveNightBlocks(schedule);
  const tripleBlocks = blocks.filter((block) => block.days.length === 3);
  const dayCounts = EMPLOYEES.map((employee) => schedule.filter((row) => row[employee] === "N").length);
  const blockCounts = EMPLOYEES.map((_, employeeIndex) => blocks.filter((block) => block.employeeIndex === employeeIndex).length);
  return {
    dayCounts,
    blockCounts,
    singles: blocks.filter((block) => block.days.length === 1).length,
    doubles: blocks.filter((block) => block.days.length === 2).length,
    triples: tripleBlocks.length,
    tripleDetails: tripleBlocks.map((block) => `${EMPLOYEES[block.employeeIndex]} ${block.startDay}-${block.endDay}`),
    tooLong: blocks.filter((block) => block.days.length > 3).length,
  };
}

function firstFailingDESlotSummary(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  lockedOff: Set<string>,
  searchSlots: Slot[],
) {
  const counts = recomputeCounts(schedule);
  const maxWork = parsed.map((input) => days.length - input.minOff);
  const attempt: Attempt = {
    schedule,
    lockedOff,
    ...counts,
    slotIndex: 0,
    deadline: Number.POSITIVE_INFINITY,
  };

  const summaries = searchSlots.map((slot) => {
    const candidates = candidatesForSlot(attempt, parsed, slot, maxWork);
    const rejectedReasons = new Map<string, string[]>();
    EMPLOYEES.forEach((employee, employeeIndex) => {
      if (candidates.includes(employeeIndex)) return;
      const reason = canAssignReason(attempt, parsed, slot, employeeIndex, maxWork) ?? "unknown";
      rejectedReasons.set(reason, [...(rejectedReasons.get(reason) ?? []), employee]);
    });
    return { slot, candidates, rejectedReasons };
  });

  const tightest = summaries.sort((a, b) => a.candidates.length - b.candidates.length || a.slot.dayIndex - b.slot.dayIndex)[0];
  if (!tightest) return null;
  const rejectionText = [...tightest.rejectedReasons.entries()]
    .map(([reason, employees]) => `${reason}: ${employees.join(", ")}`)
    .join(" / ");
  return [
    `First failing D/E slot: day ${tightest.slot.dayIndex + 1} shift ${tightest.slot.code}.`,
    `${tightest.slot.code} candidates: ${tightest.candidates.length > 0 ? tightest.candidates.map((index) => EMPLOYEES[index]).join(", ") : "none"}.`,
    `Candidates rejected: ${rejectionText || "none"}.`,
  ];
}

function commonFailureSummary(label: string, failures: string[], limit = 6) {
  if (failures.length === 0) return [];
  const counts = new Map<string, number>();
  failures.forEach((failure) => counts.set(failure, (counts.get(failure) ?? 0) + 1));
  const common = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([failure, count]) => `${failure} (${count})`);
  return [`${label}: ${common.join(" / ")}`];
}

function listDays(days: number[]) {
  return days.length > 0 ? days.join(", ") : "none";
}

function nPossibleDaysForEmployee(input: ParsedEmployeeInput, days: DayInfo[]) {
  const possible: number[] = [];
  const blocked: string[] = [];

  days.forEach((dayInfo) => {
    const day = dayInfo.day;
    const nextRequest = input.requests.get(day + 1);
    let reason = "";

    if (input.fixedOff.has(day)) reason = "same-day fixed OFF/vacation";
    else if (nextRequest && nextRequest !== "N") reason = `next-day requested work ${nextRequest}`;
    else if (
      input.requests.get(day - 1) === "N" &&
      input.requests.get(day - 2) === "N" &&
      input.requests.get(day - 3) === "N"
    ) reason = "NNNN is forbidden";
    else if (input.requests.get(day - 1) === "N" && input.requests.has(day + 1)) reason = "after NN, recovery OFF is unavailable";

    if (reason) blocked.push(`day ${day}: ${reason}`);
    else possible.push(day);
  });

  return { possible, blocked };
}

function requestedShiftConflicts(parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const conflicts: string[] = [];
  parsed.forEach((input, index) => {
    const employee = EMPLOYEES[index];
    const previous = previousTailFor(parsed, index);
    const shiftAt = (dayIndex: number) => getRequestedShiftAtWithPrev(input, dayIndex, previous);
    input.requests.forEach((code, day) => {
      const requested = normalizeShift(code);
      const dayIndex = day - 1;
      const prev = shiftAt(dayIndex - 1);
      const prevPrev = shiftAt(dayIndex - 2);
      const needed = ["D", "E", "N"];
      if (requested === null || requested === "OFF") return;
      if (requested === "M") return;

      if (input.fixedOff.has(day)) conflicts.push(`${employee} day ${day} ${code}: conflicts with fixed OFF/vacation`);
      if (!needed.includes(requested)) conflicts.push(`${employee} day ${day} ${code}: requested shift is not required on this day`);
      if (isEveningLike(prev) && requested === "D") conflicts.push(`${employee} day ${day - 1} ${prev} -> day ${day} D`);
      if (prev === "N" && requested !== "N") conflicts.push(`${employee} day ${day - 1} N -> day ${day} ${code}`);
      if (prev === "N" && prevPrev === "N" && requested !== "N") conflicts.push(`${employee} day ${day} ${code}: after NN, OFF is required`);
      if (requested === "D" && isOffLike(prev) && prevPrev === "N") conflicts.push(`${employee} day ${day - 2} N -> day ${day - 1} OFF -> day ${day} D`);
    });
  });
  return [...new Set(conflicts)];
}

function duplicateRequestedShiftConflicts(parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const byDayShift = new Map<string, string[]>();
  parsed.forEach((input, employeeIndex) => {
    input.requests.forEach((code, day) => {
      const requested = normalizeShift(code);
      if (requested !== "D" && requested !== "E") return;
      if (day < 1 || day > days.length) return;
      const key = `${day}:${requested}`;
      byDayShift.set(key, [...(byDayShift.get(key) ?? []), EMPLOYEES[employeeIndex]]);
    });
  });

  const conflicts: string[] = [];
  byDayShift.forEach((employees, key) => {
    if (employees.length <= 1) return;
    const [day, shift] = key.split(":");
    conflicts.push(`Day ${day} ${shift} requested by multiple employees: ${employees.join(", ")}`);
  });
  return conflicts;
}

function emToDBlockedDates(parsed: ParsedEmployeeInput[]) {
  const blocked: string[] = [];
  parsed.forEach((input, index) => {
    const employee = EMPLOYEES[index];
    const previous = previousTailFor(parsed, index);
    const shiftAt = (dayIndex: number) => getRequestedShiftAtWithPrev(input, dayIndex, previous);
    input.requests.forEach((code, day) => {
      const requested = normalizeShift(code);
      const dayIndex = day - 1;
      const next = shiftAt(dayIndex + 1);
      const prev = shiftAt(dayIndex - 1);
      if (isEveningLike(requested) && next === "D") blocked.push(`${employee}: day ${day} ${code} -> day ${day + 1} D`);
      if (requested === "D" && isEveningLike(prev)) blocked.push(`${employee}: day ${day - 1} ${prev} -> day ${day} D`);
    });
  });
  return [...new Set(blocked)];
}

function consecutiveWorkRiskWindows(parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const risks: string[] = [];
  parsed.forEach((input, index) => {
    const employee = EMPLOYEES[index];
    for (let start = 1; start <= days.length - 5; start += 1) {
      const windowDays = Array.from({ length: 6 }, (_, offset) => start + offset);
      const hasFixedOff = windowDays.some((day) => input.fixedOff.has(day));
      if (!hasFixedOff) risks.push(`${employee}: days ${start}-${start + 5} have no fixed OFF`);
    }
  });
  return risks.slice(0, 12);
}

type IntegratedTier = 1 | 2 | 3;
type PreviousMonthFairness = {
  applied: boolean;
  eligible: boolean[];
  previousOffCounts: (number | null)[];
  previousWorkCounts: (number | null)[];
  previousOffAverage: number;
  previousWorkAverage: number;
  previousOffDelta: number[];
  currentOffTargets: number[];
  currentMonthLength: number;
};
type MonthlyQuotaPlan = {
  name: string;
  baseOff: number;
  offTargets: number[];
  workTargets: number[];
  requiredM: number;
  nFloorTarget: number;
  nCeilTarget: number;
  nRemainder: number;
  nTargets: number[];
  nMinTargets: number[];
  nMaxTargets: number[];
  nTargetMode: "unified" | "legacy";
};
type BeamHistory = {
  row: Record<Employee, ShiftCode>;
  previous: BeamHistory | null;
};
type BeamState = {
  schedule: Schedule;
  history: BeamHistory | null;
  dayCount: number;
  lastShift: (NormalizedShift | null)[];
  workStreak: number[];
  nStreak: number[];
  lastNBlockEnd: (number | null)[];
  pendingRecovery: boolean[];
  nODForbidden: boolean[];
  nDayCounts: number[];
  nBlockCounts: number[];
  shiftCounts: Record<WorkShift, number>[];
  offCounts: number[];
  workCounts: number[];
  remainingOffNeeded: number[];
  remainingWorkNeeded: number[];
  remainingNNeeded: number[];
  knownFutureMandatoryOffCounts: number[];
  remainingLegalNDays: number[];
  totalMCount: number;
  remainingMNeeded: number;
  urgencyPenalty: number;
  singleN: number;
  doubleN: number;
  tripleN: number;
  desiredMAssigned: number;
  spacingRelaxations: number;
  nODRelaxations: number;
  score: number;
};

type SuffixOutcome = "succeeded" | "timed out" | "exhausted" | "not started";
type SolverAttemptSummary = {
  planName: string;
  tier: IntegratedTier;
  elapsedMs: number;
  earlyBeamMs: number;
  suffixMs: number;
  suffixOutcome: SuffixOutcome;
  dfsNodes: number;
  suffixStartingStates: number;
};
type IntegratedSolveResult =
  | {
      ok: true;
      state: BeamState;
      schedule: Schedule;
      warnings: string[];
      performanceDiagnostics: string[];
      attemptSummary: SolverAttemptSummary;
    }
  | {
      ok: false;
      failures: string[];
      performanceDiagnostics: string[];
      attemptSummary: SolverAttemptSummary;
    };

type BeamDayMetrics = {
  day: number;
  currentStates: number;
  theoreticalRawPatterns: number;
  constrainedPatternsGenerated: number;
  patternAttempts: number;
  successfulDirectExpansions: number;
  forwardCheckCalls: number;
  forwardCheckCacheHits: number;
  nextDayPatternProbes: number;
  uniqueSignatures: number;
  remainingMCapacityRejections: number;
  elapsedMs: number;
};

type SolverPerformanceMetrics = {
  elapsedMs: number;
  earlyBeamMs: number;
  exactSuffixMs: number;
  suffixStartingStatesAttempted: number;
  suffixNodesVisited: number;
  suffixMemoHits: number;
  suffixDeadStates: number;
  suffixTimedOut: boolean;
  suffixConstrainedPatterns: number;
  forwardCheckCalls: number;
  forwardCheckCacheHits: number;
  nextDayPatternProbes: number;
  remainingMCapacityRejections: number;
  days: BeamDayMetrics[];
};

function buildPreviousMonthFairness(
  parsed: ParsedEmployeeInput[],
  previousMonthLength: number,
  currentMonthLength: number,
): PreviousMonthFairness {
  const previousOffCounts = parsed.map((_, employeeIndex) => {
    const previous = previousTailFor(parsed, employeeIndex);
    if (previous.length !== previousMonthLength || previous.some((shift) => shift === null)) return null;
    return previous.filter((shift) => shift === "OFF").length;
  });
  const previousWorkCounts = parsed.map((_, employeeIndex) => {
    const previous = previousTailFor(parsed, employeeIndex);
    if (previous.length !== previousMonthLength || previous.some((shift) => shift === null)) return null;
    return previous.filter((shift) => isWorkLike(shift)).length;
  });
  const eligible = parsed.map(
    (input, employeeIndex) =>
      input.vacation.size === 0 &&
      previousOffCounts[employeeIndex] !== null &&
      previousWorkCounts[employeeIndex] !== null,
  );
  const eligibleIndexes = EMPLOYEES.map((_, index) => index).filter((index) => eligible[index]);
  const applied = eligibleIndexes.length >= 2;
  const previousOffAverage = applied
    ? eligibleIndexes.reduce((sum, index) => sum + (previousOffCounts[index] ?? 0), 0) / eligibleIndexes.length
    : 0;
  const previousWorkAverage = applied
    ? eligibleIndexes.reduce((sum, index) => sum + (previousWorkCounts[index] ?? 0), 0) / eligibleIndexes.length
    : 0;
  return {
    applied,
    eligible,
    previousOffCounts,
    previousWorkCounts,
    previousOffAverage,
    previousWorkAverage,
    previousOffDelta: previousOffCounts.map((count, index) => (applied && eligible[index] && count !== null ? previousOffAverage - count : 0)),
    currentOffTargets: parsed.map((input) => input.minOff),
    currentMonthLength,
  };
}

function integratedRelaxations(tier: IntegratedTier) {
  return { nightSpacing: tier >= 2, nOD: tier >= 3 };
}

function configuredLegacyNightTargetMode() {
  return (globalThis as typeof globalThis & { __EMT_LEGACY_N_TARGET_MODE__?: unknown }).__EMT_LEGACY_N_TARGET_MODE__ === true;
}

function nightQuotaFailure(nDayCounts: number[], processedDayIndex: number, daysInMonth: number, quota: MonthlyQuotaPlan) {
  if (nDayCounts.some((count, index) => count > quota.nMaxTargets[index])) return "N maximum target exceeded";
  const ceilingCount = nDayCounts.filter((count, index) => count === quota.nMaxTargets[index] && quota.nMaxTargets[index] > quota.nMinTargets[index]).length;
  if (ceilingCount > quota.nRemainder) return "Too many employees reached the N ceiling target";
  const remainingNightSlots = daysInMonth - processedDayIndex - 1;
  const minimumNeeded = nDayCounts.reduce((sum, count, index) => sum + Math.max(0, quota.nMinTargets[index] - count), 0);
  const maximumCapacity = nDayCounts.reduce((sum, count, index) => sum + Math.max(0, quota.nMaxTargets[index] - count), 0);
  if (minimumNeeded > remainingNightSlots) return "Remaining N slots cannot satisfy employee minimum targets";
  if (maximumCapacity < remainingNightSlots) return "Remaining N slots exceed employee maximum target capacity";
  return null;
}

function nightQuotaFinalValid(nDayCounts: number[], quota: MonthlyQuotaPlan) {
  if (quota.nTargetMode === "legacy") return nDayCounts.every((count, index) => count === quota.nTargets[index]);
  return (
    nDayCounts.every((count, index) => count >= quota.nMinTargets[index] && count <= quota.nMaxTargets[index]) &&
    nDayCounts.filter((count, index) => count === quota.nMaxTargets[index] && quota.nMaxTargets[index] > quota.nMinTargets[index]).length ===
      quota.nRemainder
  );
}

function initialBeamState(parsed: ParsedEmployeeInput[], quota: MonthlyQuotaPlan): BeamState {
  const lastShift = parsed.map((_, employeeIndex) => previousTailFor(parsed, employeeIndex).at(-1) ?? null);
  const pendingRecovery = lastShift.map((shift) => shift === "N");
  const nODForbidden = parsed.map((_, employeeIndex) => {
    const previous = previousTailFor(parsed, employeeIndex);
    return isOffLike(previous.at(-1) ?? null) && previous.at(-2) === "N";
  });
  return {
    schedule: [],
    history: null,
    dayCount: 0,
    lastShift,
    workStreak: parsed.map((_, employeeIndex) => trailingPreviousWorkStreak(parsed, employeeIndex)),
    nStreak: EMPLOYEES.map(() => 0),
    lastNBlockEnd: parsed.map((_, employeeIndex) => previousMonthLastNightIndex(parsed, employeeIndex)),
    pendingRecovery,
    nODForbidden,
    nDayCounts: EMPLOYEES.map(() => 0),
    nBlockCounts: EMPLOYEES.map(() => 0),
    shiftCounts: cloneCounts(),
    offCounts: EMPLOYEES.map(() => 0),
    workCounts: EMPLOYEES.map(() => 0),
    remainingOffNeeded: [...quota.offTargets],
    remainingWorkNeeded: [...quota.workTargets],
    remainingNNeeded: [...quota.nMinTargets],
    knownFutureMandatoryOffCounts: EMPLOYEES.map(() => 0),
    remainingLegalNDays: EMPLOYEES.map(() => 0),
    totalMCount: 0,
    remainingMNeeded: quota.requiredM,
    urgencyPenalty: 0,
    singleN: 0,
    doubleN: 0,
    tripleN: 0,
    desiredMAssigned: 0,
    spacingRelaxations: 0,
    nODRelaxations: 0,
    score: 0,
  };
}

function enumerateDailyPatterns(dayIndex: number, parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const day = dayIndex + 1;
  const patterns: Record<Employee, ShiftCode>[] = [];
  const staticFailures: string[] = [];
  const hasVacation = parsed.some((input) => input.vacation.has(day));
  const requestedM = EMPLOYEES.map((_, index) => index).filter((index) => normalizeShift(parsed[index].requests.get(day)) === "M");
  if (requestedM.length > 1) {
    return { patterns, staticFailures: [`Day ${day}: multiple employees requested M: ${requestedM.map((index) => EMPLOYEES[index]).join(", ")}`] };
  }

  for (let n = 0; n < EMPLOYEES.length; n += 1) {
    for (let d = 0; d < EMPLOYEES.length; d += 1) {
      if (d === n) continue;
      for (let e = 0; e < EMPLOYEES.length; e += 1) {
        if (e === n || e === d) continue;
        const remaining = EMPLOYEES.map((_, index) => index).filter((index) => index !== n && index !== d && index !== e);
        const mOptions: (number | null)[] = hasVacation ? [null] : requestedM.length === 1 ? [requestedM[0]] : [null, ...remaining];
        for (const m of mOptions) {
          if (m !== null && !remaining.includes(m)) continue;
          const row = Object.fromEntries(EMPLOYEES.map((employee) => [employee, "/" as ShiftCode])) as Record<Employee, ShiftCode>;
          row[EMPLOYEES[n]] = "N";
          row[EMPLOYEES[d]] = "D";
          row[EMPLOYEES[e]] = "E";
          if (m !== null) row[EMPLOYEES[m]] = "M";

          let valid = true;
          EMPLOYEES.forEach((employee, employeeIndex) => {
            const assigned = row[employee];
            if (parsed[employeeIndex].fixedOff.has(day) && assigned !== "/") valid = false;
            const requested = normalizeShift(parsed[employeeIndex].requests.get(day));
            if (requested && requested !== "OFF" && assigned !== requested) valid = false;
            const requestedTomorrow = normalizeShift(parsed[employeeIndex].requests.get(day + 1));
            if (conflictsWithKnownNextDayRequest(assigned, requestedTomorrow)) valid = false;
          });
          if (valid) patterns.push(row);
        }
      }
    }
  }
  if (patterns.length === 0 && staticFailures.length === 0) {
    staticFailures.push(`Day ${day}: no static D/E/N${hasVacation ? "" : "/M"} pattern respects fixedOff/vacation/wantedOff and requested shifts.`);
  }
  return { patterns, staticFailures };
}

function staticNightAvailability(dailyPatterns: ReturnType<typeof enumerateDailyPatterns>[]) {
  return dailyPatterns.map(({ patterns }) =>
    EMPLOYEES.map((employee) => patterns.some((row) => row[employee] === "N")),
  );
}

function requestedNightRecoveryDates(
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  nightAvailability: boolean[][],
) {
  return parsed.map((input, employeeIndex) => {
    const recoveryDates = new Set<number>();
    let requestedRun = 0;
    for (let day = 1; day <= days.length; day += 1) {
      if (normalizeShift(input.requests.get(day)) !== "N") {
        requestedRun = 0;
        continue;
      }
      requestedRun += 1;
      const recoveryDay = day + 1;
      if (recoveryDay > days.length) continue;
      const nextRequested = normalizeShift(input.requests.get(recoveryDay));
      const nextNightIsLegal = nightAvailability[recoveryDay - 1][employeeIndex];
      if (requestedRun >= 3 || (nextRequested !== "N" && !nextNightIsLegal)) recoveryDates.add(recoveryDay);
    }
    return recoveryDates;
  });
}

function openNightBlockCanContinue(
  state: BeamState,
  employeeIndex: number,
  nextDayIndex: number,
  days: DayInfo[],
  quota: MonthlyQuotaPlan,
  nightAvailability: boolean[][],
) {
  if (state.nStreak[employeeIndex] === 0 || nextDayIndex >= days.length) return false;
  if (state.nDayCounts[employeeIndex] >= quota.nMaxTargets[employeeIndex]) return false;
  if (!nightAvailability[nextDayIndex][employeeIndex]) return false;
  if (state.nStreak[employeeIndex] >= 3) return false;
  if (state.nStreak[employeeIndex] === 2 && (days.length % 2 === 0 || state.tripleN > 0)) return false;
  return true;
}

type FutureQuotaAvailability = {
  mandatoryDates: Set<number>[][];
  legalNightCounts: number[][];
};

function buildFutureQuotaAvailability(
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  nightAvailability: boolean[][],
  requestedRecoveryDates: Set<number>[],
): FutureQuotaAvailability {
  const mandatoryDates = days.map((_, processedDayIndex) =>
    EMPLOYEES.map((__, employeeIndex) => {
      const dates = new Set<number>();
      for (let futureDayIndex = processedDayIndex + 1; futureDayIndex < days.length; futureDayIndex += 1) {
        const day = futureDayIndex + 1;
        if (parsed[employeeIndex].fixedOff.has(day) || requestedRecoveryDates[employeeIndex].has(day)) dates.add(day);
      }
      return dates;
    }),
  );
  const legalNightCounts = days.map((_, processedDayIndex) =>
    EMPLOYEES.map((__, employeeIndex) => {
      let count = 0;
      for (let futureDayIndex = processedDayIndex + 1; futureDayIndex < days.length; futureDayIndex += 1) {
        if (nightAvailability[futureDayIndex][employeeIndex] && !mandatoryDates[processedDayIndex][employeeIndex].has(futureDayIndex + 1)) count += 1;
      }
      return count;
    }),
  );
  return { mandatoryDates, legalNightCounts };
}

function knownFutureMandatoryOffInfo(
  state: BeamState,
  employeeIndex: number,
  processedDayIndex: number,
  days: DayInfo[],
  quota: MonthlyQuotaPlan,
  nightAvailability: boolean[][],
  futureAvailability: FutureQuotaAvailability,
) {
  const dates = futureAvailability.mandatoryDates[processedDayIndex][employeeIndex];
  const nextDayIndex = processedDayIndex + 1;
  const forcedRecoveryDay =
    state.nStreak[employeeIndex] > 0 &&
    nextDayIndex < days.length &&
    !openNightBlockCanContinue(state, employeeIndex, nextDayIndex, days, quota, nightAvailability)
      ? nextDayIndex + 1
      : null;
  const hasAdditionalForcedRecovery = forcedRecoveryDay !== null && !dates.has(forcedRecoveryDay);
  const mandatoryCount = dates.size + (hasAdditionalForcedRecovery ? 1 : 0);
  const legalNightCount =
    futureAvailability.legalNightCounts[processedDayIndex][employeeIndex] -
    (hasAdditionalForcedRecovery && nightAvailability[nextDayIndex][employeeIndex] ? 1 : 0);
  return { dates, forcedRecoveryDay: hasAdditionalForcedRecovery ? forcedRecoveryDay : null, mandatoryCount, legalNightCount };
}

function closeNightBlock(state: BeamState, employeeIndex: number, endIndex: number) {
  const length = state.nStreak[employeeIndex];
  if (length === 0) return;
  state.nBlockCounts[employeeIndex] += 1;
  state.lastNBlockEnd[employeeIndex] = endIndex;
  if (length === 1) state.singleN += 1;
  else if (length === 2) state.doubleN += 1;
  else if (length === 3) state.tripleN += 1;
  state.nStreak[employeeIndex] = 0;
}

function previousFairnessScore(state: BeamState, fairness: PreviousMonthFairness) {
  if (!fairness.applied) return 0;
  const eligibleIndexes = EMPLOYEES.map((_, index) => index).filter((index) => fairness.eligible[index]);
  const currentOffAverage = eligibleIndexes.reduce((sum, index) => sum + state.offCounts[index], 0) / eligibleIndexes.length;
  const currentWorkAverage = eligibleIndexes.reduce((sum, index) => sum + state.workCounts[index], 0) / eligibleIndexes.length;
  return eligibleIndexes.reduce((penalty, index) => {
    const delta = Math.max(0, fairness.previousOffDelta[index]);
    if (delta === 0) return penalty;
    const offTerm = (currentOffAverage - state.offCounts[index]) * delta * 24;
    const workTerm = (state.workCounts[index] - currentWorkAverage) * delta * 10;
    return penalty + offTerm + workTerm;
  }, 0);
}

function mPlacementPreferencePenalty(
  dayIndex: number,
  row: Record<Employee, ShiftCode>,
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
) {
  const mEmployeeIndex = EMPLOYEES.findIndex((employee) => row[employee] === "M");
  if (mEmployeeIndex < 0) return 0;
  let penalty = days[dayIndex].isRestDay ? 0 : 300;
  for (const adjacentDay of [dayIndex, dayIndex + 2]) {
    if (adjacentDay < 1 || adjacentDay > days.length) continue;
    if (parsed.some((input) => input.vacation.has(adjacentDay))) penalty += 180;
    const adjacentRequest = normalizeShift(parsed[mEmployeeIndex].requests.get(adjacentDay));
    if (adjacentRequest === "D") penalty += 220;
    if (adjacentRequest === "N" || normalizeShift(parsed[mEmployeeIndex].requests.get(adjacentDay - 1)) === "N") penalty += 180;
  }
  return penalty;
}

function beamStateScore(state: BeamState, fairness: PreviousMonthFairness, quota: MonthlyQuotaPlan) {
  const variancePenalty = (values: number[]) => {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  };
  const progress = state.dayCount / fairness.currentMonthLength;
  const offTargetPenalty = state.offCounts.reduce(
    (sum, count, index) => sum + (count - quota.offTargets[index] * progress) ** 2,
    0,
  );
  const workTargetPenalty = state.workCounts.reduce(
    (sum, count, index) => sum + (count - quota.workTargets[index] * progress) ** 2,
    0,
  );
  const expectedMProgress = quota.requiredM * progress;
  const mProgressPenalty = (state.totalMCount - expectedMProgress) ** 2;
  const expectedNPerEmployee = (quota.nFloorTarget + quota.nRemainder / EMPLOYEES.length) * progress;
  const nProgressPenalty = state.nDayCounts.reduce(
    (sum, count) => sum + (count - expectedNPerEmployee) ** 2,
    0,
  );
  const nUrgencyPenalty = state.remainingNNeeded.reduce((sum, remaining, index) => {
    if (remaining <= 0) return sum;
    const legalDays = Math.max(1, state.remainingLegalNDays[index]);
    return sum + (remaining / legalDays) ** 2 * 1200;
  }, 0);
  const offReservationPenalty = state.remainingOffNeeded.reduce((sum, remaining, index) => {
    const discretionarySlack = remaining - state.knownFutureMandatoryOffCounts[index];
    return sum + (discretionarySlack <= 1 ? (2 - discretionarySlack) * 900 : 0);
  }, 0);
  const desiredMWeight = progress < 0.75 ? 400 : 5000;
  return (
    state.spacingRelaxations * 120000 +
    state.nODRelaxations * 240000 +
    state.singleN * 45 +
    state.tripleN * 2500 +
    variancePenalty(state.nDayCounts) * 30 +
    variancePenalty(state.shiftCounts.map((counts) => counts.D)) * 8 +
    variancePenalty(state.shiftCounts.map((counts) => counts.E)) * 8 +
    variancePenalty(state.workCounts) * 12 +
    variancePenalty(state.offCounts) * 8 -
    state.desiredMAssigned * desiredMWeight +
    offTargetPenalty * 600 +
    workTargetPenalty * 450 +
    mProgressPenalty * 700 +
    nProgressPenalty * 150 +
    nUrgencyPenalty +
    offReservationPenalty +
    state.urgencyPenalty +
    previousFairnessScore(state, fairness)
  );
}

function beamQuotaSignature(state: BeamState) {
  return [
    state.remainingOffNeeded.join(","),
    state.remainingWorkNeeded.join(","),
    state.remainingNNeeded.join(","),
    state.nDayCounts.join(","),
    state.remainingMNeeded,
    state.lastShift.join(","),
    state.workStreak.join(","),
    state.nStreak.join(","),
    state.nBlockCounts.join(","),
    state.lastNBlockEnd.join(","),
    state.tripleN,
    state.pendingRecovery.map(Number).join(""),
    state.nODForbidden.map(Number).join(""),
  ].join("|");
}

function expandBeamStateCore(
  state: BeamState,
  row: Record<Employee, ShiftCode>,
  dayIndex: number,
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  tier: IntegratedTier,
  fairness: PreviousMonthFairness,
  quota: MonthlyQuotaPlan,
  remainingStaticMCapacity: number,
  remainingForcedMCount: number,
  nightAvailability: boolean[][],
  futureAvailability: FutureQuotaAvailability,
  scoreState = true,
) {
  const currentMandatoryOff = EMPLOYEES.map(
    (employee, employeeIndex) =>
      parsed[employeeIndex].fixedOff.has(dayIndex + 1) ||
      state.pendingRecovery[employeeIndex] ||
      (state.nStreak[employeeIndex] > 0 && row[employee] !== "N"),
  );
  const next: BeamState = {
    ...state,
    history: { row, previous: state.history },
    dayCount: state.dayCount + 1,
    lastShift: [...state.lastShift],
    workStreak: [...state.workStreak],
    nStreak: [...state.nStreak],
    lastNBlockEnd: [...state.lastNBlockEnd],
    pendingRecovery: [...state.pendingRecovery],
    nODForbidden: [...state.nODForbidden],
    nDayCounts: [...state.nDayCounts],
    nBlockCounts: [...state.nBlockCounts],
    shiftCounts: state.shiftCounts.map((counts) => ({ ...counts })),
    offCounts: [...state.offCounts],
    workCounts: [...state.workCounts],
    remainingOffNeeded: [...state.remainingOffNeeded],
    remainingWorkNeeded: [...state.remainingWorkNeeded],
    remainingNNeeded: [...state.remainingNNeeded],
    knownFutureMandatoryOffCounts: [...state.knownFutureMandatoryOffCounts],
    remainingLegalNDays: [...state.remainingLegalNDays],
  };

  for (let employeeIndex = 0; employeeIndex < EMPLOYEES.length; employeeIndex += 1) {
    const employee = EMPLOYEES[employeeIndex];
    const shift = row[employee];
    const normalized = normalizeShift(shift);
    const isOff = shift === "/";
    const wasInNightBlock = state.nStreak[employeeIndex] > 0;

    if ((state.pendingRecovery[employeeIndex] || (wasInNightBlock && shift !== "N")) && !isOff) {
      return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: recovery OFF conflict` };
    }
    if (shift === "D" && isEveningLike(state.lastShift[employeeIndex])) {
      return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: E/M -> D conflict` };
    }
    if (state.nODForbidden[employeeIndex] && shift === "D") {
      if (tier < 3) return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: N-O-D conflict` };
      next.nODRelaxations += 1;
    }

    if (shift === "N") {
      if (wasInNightBlock) {
        if (state.nStreak[employeeIndex] >= 3) return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: NNNN+ conflict` };
        if (state.nStreak[employeeIndex] === 2 && (days.length % 2 === 0 || state.tripleN > 0)) {
          return { ok: false as const, reason: "NNN is only allowed at most once in odd-total-N months." };
        }
        next.nStreak[employeeIndex] = state.nStreak[employeeIndex] + 1;
      } else {
        const lastEnd = state.lastNBlockEnd[employeeIndex];
        if (lastEnd !== null && dayIndex - lastEnd < MIN_N_BLOCK_START_GAP) {
          if (tier < 2) return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: N spacing conflict` };
          next.spacingRelaxations += 1;
        }
        next.nStreak[employeeIndex] = 1;
      }
      next.nDayCounts[employeeIndex] += 1;
      if (next.nDayCounts[employeeIndex] > quota.nMaxTargets[employeeIndex]) {
        return {
          ok: false as const,
          reason: `${employee} day ${dayIndex + 1}: assigning N would make N ${next.nDayCounts[employeeIndex]}, exceeding maximum target ${quota.nMaxTargets[employeeIndex]}.`,
        };
      }
    } else if (wasInNightBlock) {
      closeNightBlock(next, employeeIndex, dayIndex - 1);
    }

    const nextWorkStreak = isOff ? 0 : state.workStreak[employeeIndex] + 1;
    if (nextWorkStreak > 5) return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: max consecutive work conflict` };
    const nextWorkCount = state.workCounts[employeeIndex] + (isOff ? 0 : 1);
    next.workStreak[employeeIndex] = nextWorkStreak;
    next.workCounts[employeeIndex] = nextWorkCount;
    if (isOff) next.offCounts[employeeIndex] += 1;
    else next.shiftCounts[employeeIndex][shift] += 1;
    const remainingDays = days.length - dayIndex - 1;
    const offTarget = quota.offTargets[employeeIndex];
    const workTarget = quota.workTargets[employeeIndex];
    if (next.offCounts[employeeIndex] > offTarget) {
      return {
        ok: false as const,
        reason: `${employee} day ${dayIndex + 1}: assigning OFF would make OFF ${next.offCounts[employeeIndex]}, exceeding target ${offTarget}.`,
      };
    }
    if (next.offCounts[employeeIndex] + remainingDays < offTarget) {
      return {
        ok: false as const,
        reason: `${employee} day ${dayIndex + 1}: requires ${offTarget - next.offCounts[employeeIndex]} more OFF with only ${remainingDays} days remaining.`,
      };
    }
    if (next.workCounts[employeeIndex] > workTarget) {
      return { ok: false as const, reason: `${employee} day ${dayIndex + 1}: work target ${workTarget} already exceeded.` };
    }
    if (next.workCounts[employeeIndex] + remainingDays < workTarget) {
      return {
        ok: false as const,
        reason: `${employee} day ${dayIndex + 1}: requires ${workTarget - next.workCounts[employeeIndex]} more work with only ${remainingDays} days remaining.`,
      };
    }
    next.remainingOffNeeded[employeeIndex] = offTarget - next.offCounts[employeeIndex];
    next.remainingWorkNeeded[employeeIndex] = workTarget - next.workCounts[employeeIndex];
    next.remainingNNeeded[employeeIndex] = Math.max(0, quota.nMinTargets[employeeIndex] - next.nDayCounts[employeeIndex]);
    next.pendingRecovery[employeeIndex] = false;
    next.nODForbidden[employeeIndex] = (state.pendingRecovery[employeeIndex] || (wasInNightBlock && shift !== "N")) && isOff;
    next.lastShift[employeeIndex] = normalized;
  }

  const nightQuotaReason = nightQuotaFailure(next.nDayCounts, dayIndex, days.length, quota);
  if (nightQuotaReason) return { ok: false as const, reason: `${nightQuotaReason} after day ${dayIndex + 1}.` };

  const rowHasM = EMPLOYEES.some((employee) => row[employee] === "M");
  next.totalMCount = state.totalMCount + (rowHasM ? 1 : 0);
  next.remainingMNeeded = quota.requiredM - next.totalMCount;
  if (rowHasM) next.urgencyPenalty += mPlacementPreferencePenalty(dayIndex, row, days, parsed);
  if (next.remainingMNeeded < 0) {
    return { ok: false as const, reason: `Required M ${quota.requiredM} already exceeded; current ${next.totalMCount}.` };
  }
  if (next.remainingMNeeded > remainingStaticMCapacity) {
    return {
      ok: false as const,
      reason: `Required M ${quota.requiredM} cannot be reached; current ${next.totalMCount}, maximum remaining ${remainingStaticMCapacity}.`,
    };
  }
  if (next.remainingMNeeded < remainingForcedMCount) {
    return {
      ok: false as const,
      reason: `Required M ${quota.requiredM} would be exceeded: current ${next.totalMCount}, with ${remainingForcedMCount} requested M day(s) still remaining.`,
    };
  }
  const remainingDays = days.length - dayIndex - 1;
  for (let employeeIndex = 0; employeeIndex < EMPLOYEES.length; employeeIndex += 1) {
    const employee = EMPLOYEES[employeeIndex];
    const mandatoryInfo = knownFutureMandatoryOffInfo(
      next,
      employeeIndex,
      dayIndex,
      days,
      quota,
      nightAvailability,
      futureAvailability,
    );
    const mandatoryFutureOffCount = mandatoryInfo.mandatoryCount;
    next.knownFutureMandatoryOffCounts[employeeIndex] = mandatoryFutureOffCount;
    if (next.offCounts[employeeIndex] + mandatoryFutureOffCount > quota.offTargets[employeeIndex]) {
      const dateList = [
        ...mandatoryInfo.dates,
        ...(mandatoryInfo.forcedRecoveryDay === null ? [] : [mandatoryInfo.forcedRecoveryDay]),
      ]
        .sort((a, b) => a - b)
        .join(", ");
      return {
        ok: false as const,
        reason: `${employee} after day ${dayIndex + 1}: current OFF ${next.offCounts[employeeIndex]} plus ${mandatoryFutureOffCount} known future fixed/vacation/recovery OFF dates exceeds target ${quota.offTargets[employeeIndex]}${dateList ? ` (days ${dateList})` : ""}.`,
      };
    }
    const futureLegalWorkUpperBound = remainingDays - mandatoryFutureOffCount;
    const remainingWorkNeeded = quota.workTargets[employeeIndex] - next.workCounts[employeeIndex];
    if (remainingWorkNeeded > futureLegalWorkUpperBound) {
      return {
        ok: false as const,
        reason: `${employee} after day ${dayIndex + 1}: needs ${remainingWorkNeeded} more workdays but has at most ${futureLegalWorkUpperBound} legally available future work dates.`,
      };
    }
    const remainingLegalNDays = mandatoryInfo.legalNightCount;
    next.remainingLegalNDays[employeeIndex] = remainingLegalNDays;
    const remainingNNeeded = Math.max(0, quota.nMinTargets[employeeIndex] - next.nDayCounts[employeeIndex]);
    if (remainingNNeeded > remainingLegalNDays) {
      return {
        ok: false as const,
        reason: `${employee} after day ${dayIndex + 1}: needs ${remainingNNeeded} more N shifts but has only ${remainingLegalNDays} legal future N dates for minimum target ${quota.nMinTargets[employeeIndex]}.`,
      };
    }
    const discretionarySlackBeforeCurrentOff = quota.offTargets[employeeIndex] - state.offCounts[employeeIndex] - mandatoryFutureOffCount;
    if (row[employee] === "/" && !currentMandatoryOff[employeeIndex] && discretionarySlackBeforeCurrentOff <= 1) {
      next.urgencyPenalty += 2500;
    }
  }

  if (days[dayIndex].isRestDay && EMPLOYEES.some((employee) => row[employee] === "M")) next.desiredMAssigned += 1;
  if (scoreState) next.score = beamStateScore(next, fairness, quota);
  return { ok: true as const, state: next };
}

type LookaheadCacheEntry = { feasible: true } | { feasible: false; reason: string };

type DailyPatternRow = Record<Employee, ShiftCode>;

type IntegratedStaticData = {
  dailyPatterns: ReturnType<typeof enumerateDailyPatterns>[];
  nightAvailability: boolean[][];
  futureAvailability: FutureQuotaAvailability;
  remainingStaticMCapacity: number[];
  remainingForcedMCount: number[];
  nextPatternCompatibility: Map<DailyPatternRow, DailyPatternRow[]>[];
  patternByKey: Map<string, DailyPatternRow>[];
  dayConstraintSignatures: string[];
  vacationDateCount: number;
};

function staticRowsCompatible(today: DailyPatternRow, tomorrow: DailyPatternRow) {
  return EMPLOYEES.every((employee) => !conflictsWithKnownNextDayRequest(today[employee], normalizeShift(tomorrow[employee])));
}

function dailyPatternKey(row: DailyPatternRow) {
  return EMPLOYEES.map((employee) => row[employee]).join("");
}

function buildIntegratedStaticData(
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  dailyPatterns: ReturnType<typeof enumerateDailyPatterns>[],
): IntegratedStaticData {
  const nightAvailability = staticNightAvailability(dailyPatterns);
  const requestedRecoveryDates = requestedNightRecoveryDates(parsed, days, nightAvailability);
  const futureAvailability = buildFutureQuotaAvailability(parsed, days, nightAvailability, requestedRecoveryDates);
  const remainingStaticMCapacity = Array.from({ length: days.length + 1 }, () => 0);
  const remainingForcedMCount = Array.from({ length: days.length + 1 }, () => 0);
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const patterns = dailyPatterns[index].patterns;
    const canAssignM = patterns.some((row) => EMPLOYEES.some((employee) => row[employee] === "M"));
    const mustAssignM = patterns.length > 0 && patterns.every((row) => EMPLOYEES.some((employee) => row[employee] === "M"));
    remainingStaticMCapacity[index] = remainingStaticMCapacity[index + 1] + (canAssignM ? 1 : 0);
    remainingForcedMCount[index] = remainingForcedMCount[index + 1] + (mustAssignM ? 1 : 0);
  }
  const nextPatternCompatibility = dailyPatterns.map(({ patterns }, dayIndex) => {
    const result = new Map<DailyPatternRow, DailyPatternRow[]>();
    const nextPatterns = dailyPatterns[dayIndex + 1]?.patterns ?? [];
    patterns.forEach((row) => result.set(row, nextPatterns.filter((nextRow) => staticRowsCompatible(row, nextRow))));
    return result;
  });
  const patternByKey = dailyPatterns.map(({ patterns }) => new Map(patterns.map((row) => [dailyPatternKey(row), row])));
  const dayConstraintSignatures = days.map((dayInfo) =>
    [
      dayInfo.day,
      parsed.some((input) => input.vacation.has(dayInfo.day)) ? "V" : "-",
      ...parsed.map((input) => `${input.fixedOff.has(dayInfo.day) ? "O" : "-"}${normalizeShift(input.requests.get(dayInfo.day)) ?? "-"}`),
    ].join(":"),
  );
  return {
    dailyPatterns,
    nightAvailability,
    futureAvailability,
    remainingStaticMCapacity,
    remainingForcedMCount,
    nextPatternCompatibility,
    patternByKey,
    dayConstraintSignatures,
    vacationDateCount: days.filter((dayInfo) => parsed.some((input) => input.vacation.has(dayInfo.day))).length,
  };
}

function probeNextDayPatternFeasible(
  state: BeamState,
  row: DailyPatternRow,
  dayIndex: number,
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  tier: IntegratedTier,
  quota: MonthlyQuotaPlan,
  remainingStaticMCapacity: number,
  remainingForcedMCount: number,
  nightAvailability: boolean[][],
  futureAvailability: FutureQuotaAvailability,
) {
  const rowHasM = EMPLOYEES.some((employee) => row[employee] === "M");
  const tripleNAfterRow =
    state.tripleN +
    EMPLOYEES.filter((employee, employeeIndex) => state.nStreak[employeeIndex] === 3 && row[employee] !== "N").length;
  const resultingNCounts = [...state.nDayCounts];
  const remainingMNeeded = state.remainingMNeeded - (rowHasM ? 1 : 0);
  if (remainingMNeeded < 0) return `Required M ${quota.requiredM} would be exceeded on day ${dayIndex + 1}.`;
  if (remainingMNeeded > remainingStaticMCapacity) {
    return `Remaining M capacity conflict after day ${dayIndex + 1}: needs ${remainingMNeeded}, capacity ${remainingStaticMCapacity}.`;
  }
  if (remainingMNeeded < remainingForcedMCount) {
    return `Required M ${quota.requiredM} would be exceeded by ${remainingForcedMCount} forced future M day(s).`;
  }

  for (let employeeIndex = 0; employeeIndex < EMPLOYEES.length; employeeIndex += 1) {
    const employee = EMPLOYEES[employeeIndex];
    const shift = row[employee];
    const isOff = shift === "/";
    const wasInNightBlock = state.nStreak[employeeIndex] > 0;
    const closesNightBlock = wasInNightBlock && shift !== "N";
    const recoveryRequired = state.pendingRecovery[employeeIndex] || closesNightBlock;
    if (recoveryRequired && !isOff) return `${employee} day ${dayIndex + 1}: recovery OFF conflict`;
    if (shift === "D" && isEveningLike(state.lastShift[employeeIndex])) return `${employee} day ${dayIndex + 1}: E/M -> D conflict`;
    if (state.nODForbidden[employeeIndex] && shift === "D" && tier < 3) return `${employee} day ${dayIndex + 1}: N-O-D conflict`;

    let nStreak = 0;
    let nDayCount = state.nDayCounts[employeeIndex];
    if (shift === "N") {
      if (wasInNightBlock) {
        if (state.nStreak[employeeIndex] >= 3) return `${employee} day ${dayIndex + 1}: NNNN+ conflict`;
        if (state.nStreak[employeeIndex] === 2 && (days.length % 2 === 0 || state.tripleN > 0)) {
          return "NNN is only allowed at most once in odd-total-N months.";
        }
        nStreak = state.nStreak[employeeIndex] + 1;
      } else {
        const lastEnd = state.lastNBlockEnd[employeeIndex];
        if (lastEnd !== null && dayIndex - lastEnd < MIN_N_BLOCK_START_GAP && tier < 2) {
          return `${employee} day ${dayIndex + 1}: N spacing conflict`;
        }
        nStreak = 1;
      }
      nDayCount += 1;
      if (nDayCount > quota.nMaxTargets[employeeIndex]) return `${employee} day ${dayIndex + 1}: maximum N target exceeded`;
    }
    resultingNCounts[employeeIndex] = nDayCount;

    const workStreak = isOff ? 0 : state.workStreak[employeeIndex] + 1;
    if (workStreak > 5) return `${employee} day ${dayIndex + 1}: max consecutive work conflict`;
    const offCount = state.offCounts[employeeIndex] + (isOff ? 1 : 0);
    const workCount = state.workCounts[employeeIndex] + (isOff ? 0 : 1);
    const remainingDays = days.length - dayIndex - 1;
    if (offCount > quota.offTargets[employeeIndex] || offCount + remainingDays < quota.offTargets[employeeIndex]) {
      return `${employee} day ${dayIndex + 1}: exact OFF target conflict`;
    }
    if (workCount > quota.workTargets[employeeIndex] || workCount + remainingDays < quota.workTargets[employeeIndex]) {
      return `${employee} day ${dayIndex + 1}: exact work target conflict`;
    }

    const dates = futureAvailability.mandatoryDates[dayIndex][employeeIndex];
    const followingDayIndex = dayIndex + 1;
    const canContinueNight =
      nStreak > 0 &&
      followingDayIndex < days.length &&
      nDayCount < quota.nMaxTargets[employeeIndex] &&
      nightAvailability[followingDayIndex][employeeIndex] &&
      nStreak < 3 &&
      !(nStreak === 2 && (days.length % 2 === 0 || tripleNAfterRow > 0));
    const forcedRecoveryDay = nStreak > 0 && !canContinueNight && followingDayIndex < days.length ? followingDayIndex + 1 : null;
    const additionalRecovery = forcedRecoveryDay !== null && !dates.has(forcedRecoveryDay);
    const mandatoryFutureOffCount = dates.size + (additionalRecovery ? 1 : 0);
    if (offCount + mandatoryFutureOffCount > quota.offTargets[employeeIndex]) {
      return `${employee} after day ${dayIndex + 1}: future mandatory OFF capacity conflict`;
    }
    if (quota.workTargets[employeeIndex] - workCount > remainingDays - mandatoryFutureOffCount) {
      return `${employee} after day ${dayIndex + 1}: future legal work capacity conflict`;
    }
    const legalNightCount =
      futureAvailability.legalNightCounts[dayIndex][employeeIndex] -
      (additionalRecovery && nightAvailability[followingDayIndex]?.[employeeIndex] ? 1 : 0);
    if (Math.max(0, quota.nMinTargets[employeeIndex] - nDayCount) > legalNightCount) {
      return `${employee} after day ${dayIndex + 1}: future legal N capacity conflict`;
    }
  }
  const nightQuotaReason = nightQuotaFailure(resultingNCounts, dayIndex, days.length, quota);
  if (nightQuotaReason) return `${nightQuotaReason} after day ${dayIndex + 1}.`;
  return null;
}

function forwardCheckCandidate(
  state: BeamState,
  stateSignature: string,
  currentRow: DailyPatternRow,
  dayIndex: number,
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  tier: IntegratedTier,
  quota: MonthlyQuotaPlan,
  staticData: IntegratedStaticData,
  cacheKeyPrefix: string,
  lookaheadCache: Map<string, LookaheadCacheEntry>,
  metrics: BeamDayMetrics,
) {
  if (dayIndex + 1 >= days.length) return { ok: true as const };
  metrics.forwardCheckCalls += 1;
  const nextDayIndex = dayIndex + 1;
  const cacheKey = `${cacheKeyPrefix}|${stateSignature}`;
  const cached = lookaheadCache.get(cacheKey);
  if (cached) {
    metrics.forwardCheckCacheHits += 1;
    if ("reason" in cached) return { ok: false as const, reason: cached.reason };
    return { ok: true as const };
  }

  const reasonCounts = new Map<string, number>();
  const nextPatterns = staticData.nextPatternCompatibility[dayIndex].get(currentRow) ?? [];
  for (const nextRow of nextPatterns) {
    metrics.nextDayPatternProbes += 1;
    const reason = probeNextDayPatternFeasible(
      state,
      nextRow,
      nextDayIndex,
      days,
      parsed,
      tier,
      quota,
      staticData.remainingStaticMCapacity[nextDayIndex + 1],
      staticData.remainingForcedMCount[nextDayIndex + 1],
      staticData.nightAvailability,
      staticData.futureAvailability,
    );
    if (reason === null) {
      lookaheadCache.set(cacheKey, { feasible: true });
      return { ok: true as const };
    }
    if (reason.startsWith("Remaining M capacity conflict")) metrics.remainingMCapacityRejections += 1;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason]) => reason);
  const reason = `After day ${dayIndex + 1}, no valid day ${dayIndex + 2} continuation exists${topReasons.length > 0 ? `: ${topReasons.join(" / ")}` : ""}.`;
  lookaheadCache.set(cacheKey, { feasible: false, reason });
  return { ok: false as const, reason };
}

function constrainedDailyPatterns(
  state: BeamState,
  dayIndex: number,
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  tier: IntegratedTier,
  quota: MonthlyQuotaPlan,
  staticData: IntegratedStaticData,
) {
  const day = dayIndex + 1;
  const hasVacation = parsed.some((input) => input.vacation.has(day));
  const roleCandidateIsLegal = (employeeIndex: number, role: WorkShift) => {
    const input = parsed[employeeIndex];
    if (input.fixedOff.has(day)) return false;
    const requested = normalizeShift(input.requests.get(day));
    if (requested && requested !== "OFF" && requested !== role) return false;
    const wasInNightBlock = state.nStreak[employeeIndex] > 0;
    if (state.pendingRecovery[employeeIndex] || (wasInNightBlock && role !== "N")) return false;
    if (state.workStreak[employeeIndex] >= 5 || state.workCounts[employeeIndex] >= quota.workTargets[employeeIndex]) return false;
    if (role === "D" && isEveningLike(state.lastShift[employeeIndex])) return false;
    if (role === "D" && state.nODForbidden[employeeIndex] && tier < 3) return false;
    if (role === "M" && hasVacation) return false;
    if (role !== "N") return true;
    if (state.nDayCounts[employeeIndex] >= quota.nMaxTargets[employeeIndex]) return false;
    if (wasInNightBlock) {
      if (state.nStreak[employeeIndex] >= 3) return false;
      if (state.nStreak[employeeIndex] === 2 && (days.length % 2 === 0 || state.tripleN > 0)) return false;
      return true;
    }
    const lastEnd = state.lastNBlockEnd[employeeIndex];
    return lastEnd === null || dayIndex - lastEnd >= MIN_N_BLOCK_START_GAP || tier >= 2;
  };

  const roleCandidates = (role: WorkShift) => {
    const requestedOwner = EMPLOYEES.findIndex((_, index) => normalizeShift(parsed[index].requests.get(day)) === role);
    if (requestedOwner >= 0) return roleCandidateIsLegal(requestedOwner, role) ? [requestedOwner] : [];
    return EMPLOYEES.map((_, index) => index).filter((index) => roleCandidateIsLegal(index, role));
  };
  const coreRoles = (["D", "E", "N"] as WorkShift[])
    .map((role, order) => ({ role, order, candidates: roleCandidates(role) }))
    .sort((a, b) => a.candidates.length - b.candidates.length || a.order - b.order);
  if (coreRoles.some(({ candidates }) => candidates.length === 0)) return [];
  const mCandidates = roleCandidates("M");
  const requestedMOwner = EMPLOYEES.findIndex((_, index) => normalizeShift(parsed[index].requests.get(day)) === "M");
  const selected = new Set<number>();
  const assignments = new Map<WorkShift, number>();
  const result: DailyPatternRow[] = [];
  const emit = () => {
    const remainingMNeeded = state.remainingMNeeded;
    const availableM = mCandidates.filter((index) => !selected.has(index));
    const mOptions: (number | null)[] =
      requestedMOwner >= 0
        ? availableM.includes(requestedMOwner)
          ? [requestedMOwner]
          : []
        : remainingMNeeded / Math.max(1, days.length - dayIndex) >= 0.5
          ? [...availableM, null]
          : [null, ...availableM];
    for (const mEmployeeIndex of mOptions) {
      const row = Object.fromEntries(EMPLOYEES.map((employee) => [employee, "/" as ShiftCode])) as DailyPatternRow;
      assignments.forEach((employeeIndex, role) => {
        row[EMPLOYEES[employeeIndex]] = role;
      });
      if (mEmployeeIndex !== null) row[EMPLOYEES[mEmployeeIndex]] = "M";
      const canonical = staticData.patternByKey[dayIndex].get(dailyPatternKey(row));
      if (canonical) result.push(canonical);
    }
  };
  const visit = (roleIndex: number) => {
    if (roleIndex >= coreRoles.length) {
      emit();
      return;
    }
    const { role, candidates } = coreRoles[roleIndex];
    for (const employeeIndex of candidates) {
      if (selected.has(employeeIndex)) continue;
      selected.add(employeeIndex);
      assignments.set(role, employeeIndex);
      visit(roleIndex + 1);
      assignments.delete(role);
      selected.delete(employeeIndex);
    }
  };
  visit(0);
  return result;
}

function finalizeBeamState(state: BeamState, fairness: PreviousMonthFairness, quota: MonthlyQuotaPlan) {
  const final = {
    ...state,
    nStreak: [...state.nStreak],
    nBlockCounts: [...state.nBlockCounts],
    lastNBlockEnd: [...state.lastNBlockEnd],
  };
  EMPLOYEES.forEach((_, employeeIndex) => {
    if (final.nStreak[employeeIndex] > 0) closeNightBlock(final, employeeIndex, final.dayCount - 1);
  });
  const schedule = Array.from({ length: final.dayCount }) as Schedule;
  let history = final.history;
  for (let dayIndex = final.dayCount - 1; dayIndex >= 0 && history; dayIndex -= 1) {
    schedule[dayIndex] = history.row;
    history = history.previous;
  }
  final.schedule = schedule;
  final.score = beamStateScore(final, fairness, quota);
  return final;
}

function exactSuffixCompletion(
  startingStates: BeamState[],
  startDayIndex: number,
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  tier: IntegratedTier,
  fairness: PreviousMonthFairness,
  quota: MonthlyQuotaPlan,
  staticData: IntegratedStaticData,
  metrics: SolverPerformanceMetrics,
) {
  const startedAt = performance.now();
  const deadline = startedAt + configuredSuffixTimeBudgetMs();
  const deadStates = new Set<string>();
  const quotaKey = [
    quota.offTargets.join(","),
    quota.workTargets.join(","),
    quota.nMinTargets.join(","),
    quota.nMaxTargets.join(","),
    quota.requiredM,
    quota.nTargetMode,
    tier,
  ].join("|");
  const canStillReachExactTotals = (state: BeamState, dayIndex: number) => {
    const remainingDays = days.length - dayIndex;
    if (state.remainingMNeeded < 0 || state.remainingMNeeded > staticData.remainingStaticMCapacity[dayIndex]) return false;
    if (state.remainingMNeeded < staticData.remainingForcedMCount[dayIndex]) return false;
    if (state.remainingOffNeeded.some((remaining) => remaining < 0 || remaining > remainingDays)) return false;
    if (state.remainingWorkNeeded.some((remaining) => remaining < 0 || remaining > remainingDays)) return false;
    if (state.remainingWorkNeeded.reduce((sum, value) => sum + value, 0) !== remainingDays * 3 + state.remainingMNeeded) return false;
    if (nightQuotaFailure(state.nDayCounts, dayIndex - 1, days.length, quota)) return false;
    const processedIndex = Math.max(0, dayIndex - 1);
    for (let employeeIndex = 0; employeeIndex < EMPLOYEES.length; employeeIndex += 1) {
      const minimumNNeeded = Math.max(0, quota.nMinTargets[employeeIndex] - state.nDayCounts[employeeIndex]);
      const legalNCapacity = dayIndex === 0 ? staticData.nightAvailability.filter((row) => row[employeeIndex]).length : staticData.futureAvailability.legalNightCounts[processedIndex][employeeIndex];
      if (minimumNNeeded > legalNCapacity) return false;
      const mandatoryOffCount =
        dayIndex === 0 ? parsed[employeeIndex].fixedOff.size : staticData.futureAvailability.mandatoryDates[processedIndex][employeeIndex].size;
      if (state.remainingOffNeeded[employeeIndex] < mandatoryOffCount) return false;
    }
    return true;
  };

  let timedOut = false;
  const dfs = (state: BeamState, dayIndex: number): BeamState | null => {
    metrics.suffixNodesVisited += 1;
    if (performance.now() > deadline) {
      timedOut = true;
      return null;
    }
    if (!canStillReachExactTotals(state, dayIndex)) return null;
    if (dayIndex >= days.length) {
      const final = finalizeBeamState(state, fairness, quota);
      return validateHard(final.schedule, parsed, days, integratedRelaxations(tier), quota).length === 0 ? final : null;
    }
    const memoKey = `${dayIndex}|${quotaKey}|${beamQuotaSignature(state)}`;
    if (deadStates.has(memoKey)) {
      metrics.suffixMemoHits += 1;
      return null;
    }
    const patterns = constrainedDailyPatterns(state, dayIndex, days, parsed, tier, quota, staticData);
    metrics.suffixConstrainedPatterns += patterns.length;
    const nextStates: BeamState[] = [];
    for (const row of patterns) {
      const reason = probeNextDayPatternFeasible(
        state,
        row,
        dayIndex,
        days,
        parsed,
        tier,
        quota,
        staticData.remainingStaticMCapacity[dayIndex + 1],
        staticData.remainingForcedMCount[dayIndex + 1],
        staticData.nightAvailability,
        staticData.futureAvailability,
      );
      if (reason !== null) continue;
      const expanded = expandBeamStateCore(
        state,
        row,
        dayIndex,
        days,
        parsed,
        tier,
        fairness,
        quota,
        staticData.remainingStaticMCapacity[dayIndex + 1],
        staticData.remainingForcedMCount[dayIndex + 1],
        staticData.nightAvailability,
        staticData.futureAvailability,
      );
      if (expanded.ok) nextStates.push(expanded.state);
    }
    nextStates.sort((a, b) => a.score - b.score);
    for (const next of nextStates) {
      const solved = dfs(next, dayIndex + 1);
      if (solved) return solved;
      if (timedOut) return null;
    }
    deadStates.add(memoKey);
    metrics.suffixDeadStates = deadStates.size;
    return null;
  };

  const orderedStartingStates = [...startingStates].sort((a, b) => a.score - b.score);
  let solved: BeamState | null = null;
  for (const state of orderedStartingStates) {
    metrics.suffixStartingStatesAttempted += 1;
    solved = dfs(state, startDayIndex);
    if (solved || timedOut) break;
  }
  metrics.exactSuffixMs += performance.now() - startedAt;
  metrics.suffixTimedOut = timedOut;
  return { state: solved, timedOut, exhausted: !solved && !timedOut };
}

type BeamCandidate = { state: BeamState; row: DailyPatternRow; order: number };

function configuredSolverTimeBudgetMs() {
  const value = (globalThis as typeof globalThis & { __EMT_SOLVER_TIME_BUDGET_MS__?: unknown }).__EMT_SOLVER_TIME_BUDGET_MS__;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function configuredSuffixStartDay(daysInMonth: number) {
  const value = (globalThis as typeof globalThis & { __EMT_SUFFIX_START_DAY__?: unknown }).__EMT_SUFFIX_START_DAY__;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= daysInMonth) return value;
  return daysInMonth === 31 ? 18 : Math.max(1, daysInMonth - 13);
}

function configuredSuffixTimeBudgetMs() {
  const value = (globalThis as typeof globalThis & { __EMT_SUFFIX_TIME_BUDGET_MS__?: unknown }).__EMT_SUFFIX_TIME_BUDGET_MS__;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 30000;
}

function boundedBest<T>(items: Iterable<T>, limit: number, compare: (a: T, b: T) => number) {
  if (limit <= 0) return [];
  const heap: T[] = [];
  const swap = (a: number, b: number) => {
    [heap[a], heap[b]] = [heap[b], heap[a]];
  };
  const bubbleUp = (index: number) => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], heap[index]) >= 0) break;
      swap(parent, index);
      index = parent;
    }
  };
  const sinkDown = (index: number) => {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
      if (worst === index) break;
      swap(index, worst);
      index = worst;
    }
  };
  for (const item of items) {
    if (heap.length < limit) {
      heap.push(item);
      bubbleUp(heap.length - 1);
    } else if (compare(item, heap[0]) < 0) {
      heap[0] = item;
      sinkDown(0);
    }
  }
  return heap.sort(compare);
}

function createMinHeap<T>(items: Iterable<T>, compare: (a: T, b: T) => number) {
  const heap: T[] = [];
  const push = (item: T) => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  for (const item of items) push(item);
  return {
    get size() {
      return heap.length;
    },
    pop() {
      const first = heap[0];
      const last = heap.pop();
      if (heap.length > 0 && last !== undefined) {
        heap[0] = last;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let best = index;
          if (left < heap.length && compare(heap[left], heap[best]) < 0) best = left;
          if (right < heap.length && compare(heap[right], heap[best]) < 0) best = right;
          if (best === index) break;
          [heap[index], heap[best]] = [heap[best], heap[index]];
          index = best;
        }
      }
      return first;
    },
  };
}

function performanceDiagnostics(metrics: SolverPerformanceMetrics, quota: MonthlyQuotaPlan, tier: IntegratedTier) {
  const constrainedPatternCount = metrics.days.reduce((sum, day) => sum + day.constrainedPatternsGenerated, 0) + metrics.suffixConstrainedPatterns;
  const header = `Solver timing: ${quota.name}; Tier ${tier}; N mode ${quota.nTargetMode}; targets ${quota.nMinTargets.join("/")}-${quota.nMaxTargets.join("/")}; total ${Math.round(metrics.elapsedMs)} ms; early beam ${Math.round(metrics.earlyBeamMs)} ms; exact suffix ${Math.round(metrics.exactSuffixMs)} ms; suffix starts ${metrics.suffixStartingStatesAttempted}; DFS nodes ${metrics.suffixNodesVisited}; memo hits ${metrics.suffixMemoHits}; dead states ${metrics.suffixDeadStates}; suffix timeout ${metrics.suffixTimedOut ? "yes" : "no"}; constrained patterns ${constrainedPatternCount}; forward checks ${metrics.forwardCheckCalls}; cache hits ${metrics.forwardCheckCacheHits}; probes ${metrics.nextDayPatternProbes}; remaining-M-capacity rejections ${metrics.remainingMCapacityRejections}.`;
  const days = metrics.days.map(
    (day) =>
      `Day ${day.day} timing: states ${day.currentStates}; theoretical raw patterns ${day.theoreticalRawPatterns}; constrained patterns ${day.constrainedPatternsGenerated}; attempts ${day.patternAttempts}; direct successes ${day.successfulDirectExpansions}; forward calls ${day.forwardCheckCalls}; cache hits ${day.forwardCheckCacheHits}; probes ${day.nextDayPatternProbes}; unique signatures ${day.uniqueSignatures}; M-capacity rejections ${day.remainingMCapacityRejections}; ${Math.round(day.elapsedMs)} ms.`,
  );
  return [header, ...days];
}

function solverAttemptSummary(
  metrics: SolverPerformanceMetrics,
  quota: MonthlyQuotaPlan,
  tier: IntegratedTier,
  suffixOutcome: SuffixOutcome,
): SolverAttemptSummary {
  return {
    planName: quota.name,
    tier,
    elapsedMs: metrics.elapsedMs,
    earlyBeamMs: metrics.earlyBeamMs,
    suffixMs: metrics.exactSuffixMs,
    suffixOutcome,
    dfsNodes: metrics.suffixNodesVisited,
    suffixStartingStates: metrics.suffixStartingStatesAttempted,
  };
}

function formatSolverAttempt(summary: SolverAttemptSummary) {
  return `Solver attempt: plan ${summary.planName}; Tier ${summary.tier}; elapsed ${Math.round(summary.elapsedMs)} ms; early beam ${Math.round(summary.earlyBeamMs)} ms; suffix ${Math.round(summary.suffixMs)} ms; suffix ${summary.suffixOutcome}; DFS nodes ${summary.dfsNodes}; suffix starting states ${summary.suffixStartingStates}.`;
}

function integratedBeamSolve(
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  tier: IntegratedTier,
  variant: number,
  fairness: PreviousMonthFairness,
  quota: MonthlyQuotaPlan,
  staticData: IntegratedStaticData,
): IntegratedSolveResult {
  const beamWidth = 2000;
  const statesPerQuotaSignature = 3;
  const startedAt = performance.now();
  const timeBudgetMs = configuredSolverTimeBudgetMs();
  const metrics: SolverPerformanceMetrics = {
    elapsedMs: 0,
    earlyBeamMs: 0,
    exactSuffixMs: 0,
    suffixStartingStatesAttempted: 0,
    suffixNodesVisited: 0,
    suffixMemoHits: 0,
    suffixDeadStates: 0,
    suffixTimedOut: false,
    suffixConstrainedPatterns: 0,
    forwardCheckCalls: 0,
    forwardCheckCacheHits: 0,
    nextDayPatternProbes: 0,
    remainingMCapacityRejections: 0,
    days: [],
  };
  const lookaheadCache = new Map<string, LookaheadCacheEntry>();
  const forwardCacheSolvePrefix = [
    `spacing:${tier >= 2 ? 1 : 0}`,
    `nod:${tier >= 3 ? 1 : 0}`,
    quota.offTargets.join(","),
    quota.workTargets.join(","),
    quota.nMinTargets.join(","),
    quota.nMaxTargets.join(","),
  ].join("|");
  const forwardCacheDayPrefixes = staticData.dayConstraintSignatures.map(
    (signature, dayIndex) => `${forwardCacheSolvePrefix}|${dayIndex}|${signature}`,
  );
  let beam: BeamState[] = [initialBeamState(parsed, quota)];
  let candidateOrder = 0;
  const suffixStartIndex = configuredSuffixStartDay(days.length) - 1;

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    if (dayIndex === suffixStartIndex) {
      metrics.earlyBeamMs = performance.now() - startedAt;
      const suffix = exactSuffixCompletion(beam, dayIndex, days, parsed, tier, fairness, quota, staticData, metrics);
      metrics.elapsedMs = performance.now() - startedAt;
      const diagnostics = performanceDiagnostics(metrics, quota, tier);
      if (suffix.state) {
        const state = suffix.state;
        const warnings = [`Tier ${tier} used.`, `Exact suffix completion used from day ${dayIndex + 1}.`];
        if (tier === 2) warnings.push("Tier 2 used: N spacing rule relaxed.");
        if (tier === 3) {
          warnings.push("Tier 3 used: N spacing rule relaxed.");
          warnings.push("Tier 3 used: N-O-D rule relaxed.");
        }
        if (state.spacingRelaxations > 0) warnings.push(`N spacing relaxations: ${state.spacingRelaxations}.`);
        if (state.nODRelaxations > 0) warnings.push(`N-O-D relaxations: ${state.nODRelaxations}.`);
        return {
          ok: true,
          state,
          schedule: state.schedule,
          warnings,
          performanceDiagnostics: diagnostics,
          attemptSummary: solverAttemptSummary(metrics, quota, tier, "succeeded"),
        };
      }
      return {
        ok: false,
        failures: [
          suffix.timedOut
            ? `Exact suffix search timed out from day ${dayIndex + 1}; no invalid partial schedule was returned.`
            : `Exact suffix search exhausted all retained day-${dayIndex} beam states without a valid completion.`,
        ],
        performanceDiagnostics: diagnostics,
        attemptSummary: solverAttemptSummary(metrics, quota, tier, suffix.timedOut ? "timed out" : "exhausted"),
      };
    }
    const dayStartedAt = performance.now();
    const dayMetrics: BeamDayMetrics = {
      day: dayIndex + 1,
      currentStates: beam.length,
      theoreticalRawPatterns: 0,
      constrainedPatternsGenerated: 0,
      patternAttempts: 0,
      successfulDirectExpansions: 0,
      forwardCheckCalls: 0,
      forwardCheckCacheHits: 0,
      nextDayPatternProbes: 0,
      uniqueSignatures: 0,
      remainingMCapacityRejections: 0,
      elapsedMs: 0,
    };
    const { staticFailures } = staticData.dailyPatterns[dayIndex];
    const candidatesBySignature = new Map<string, BeamCandidate[]>();
    const directReasonCounts = new Map<string, number>();
    const forwardReasonCounts = new Map<string, number>();
    const compareCandidates = (a: BeamCandidate, b: BeamCandidate) =>
      a.state.score - b.state.score ||
      seededNoise(variant, dayIndex, a.state.nDayCounts[0], a.state.desiredMAssigned) -
        seededNoise(variant, dayIndex, b.state.nDayCounts[0], b.state.desiredMAssigned) ||
      a.order - b.order;
    for (const state of beam) {
      dayMetrics.theoreticalRawPatterns += 180;
      const constrainedPatterns = constrainedDailyPatterns(state, dayIndex, days, parsed, tier, quota, staticData);
      dayMetrics.constrainedPatternsGenerated += constrainedPatterns.length;
      for (const row of constrainedPatterns) {
          dayMetrics.patternAttempts += 1;
          const precheckReason = probeNextDayPatternFeasible(
            state,
            row,
            dayIndex,
            days,
            parsed,
            tier,
            quota,
            staticData.remainingStaticMCapacity[dayIndex + 1],
            staticData.remainingForcedMCount[dayIndex + 1],
            staticData.nightAvailability,
            staticData.futureAvailability,
          );
          if (precheckReason !== null) {
            directReasonCounts.set(precheckReason, (directReasonCounts.get(precheckReason) ?? 0) + 1);
            if (precheckReason.startsWith("Remaining M capacity conflict")) dayMetrics.remainingMCapacityRejections += 1;
            continue;
          }
          const result = expandBeamStateCore(
            state,
            row,
            dayIndex,
            days,
            parsed,
            tier,
            fairness,
            quota,
            staticData.remainingStaticMCapacity[dayIndex + 1],
            staticData.remainingForcedMCount[dayIndex + 1],
            staticData.nightAvailability,
            staticData.futureAvailability,
          );
          if (!result.ok) {
            directReasonCounts.set(result.reason, (directReasonCounts.get(result.reason) ?? 0) + 1);
            if (result.reason.includes("maximum remaining")) dayMetrics.remainingMCapacityRejections += 1;
            continue;
          }
          dayMetrics.successfulDirectExpansions += 1;
          const candidate = { state: result.state, row, order: candidateOrder++ };
          const signature = beamQuotaSignature(result.state);
          const bucket = candidatesBySignature.get(signature) ?? [];
          bucket.push(candidate);
          bucket.sort(compareCandidates);
          if (bucket.length > statesPerQuotaSignature) bucket.length = statesPerQuotaSignature;
          candidatesBySignature.set(signature, bucket);
          if (timeBudgetMs !== null && dayMetrics.patternAttempts % 8192 === 0 && performance.now() - startedAt > timeBudgetMs) break;
      }
      if (timeBudgetMs !== null && performance.now() - startedAt > timeBudgetMs) break;
    }
    dayMetrics.uniqueSignatures = candidatesBySignature.size;

    const passingBySignature = new Map<string, BeamCandidate[]>();
    const primaryHeap = createMinHeap(
      [...candidatesBySignature.entries()].map(([signature, candidates]) => ({ signature, candidates })),
      (a, b) => compareCandidates(a.candidates[0], b.candidates[0]),
    );
    const selectedPrimary: BeamCandidate[] = [];
    while (primaryHeap.size > 0 && selectedPrimary.length < beamWidth) {
      const entry = primaryHeap.pop();
      if (!entry) break;
      const candidate = entry.candidates[0];
      const result = forwardCheckCandidate(
        candidate.state,
        entry.signature,
        candidate.row,
        dayIndex,
        days,
        parsed,
        tier,
        quota,
        staticData,
        forwardCacheDayPrefixes[dayIndex + 1],
        lookaheadCache,
        dayMetrics,
      );
      if (result.ok) {
        selectedPrimary.push(candidate);
        passingBySignature.set(entry.signature, entry.candidates);
      } else {
        forwardReasonCounts.set(result.reason, (forwardReasonCounts.get(result.reason) ?? 0) + 1);
      }
    }

    dayMetrics.elapsedMs = performance.now() - dayStartedAt;
    metrics.forwardCheckCalls += dayMetrics.forwardCheckCalls;
    metrics.forwardCheckCacheHits += dayMetrics.forwardCheckCacheHits;
    metrics.nextDayPatternProbes += dayMetrics.nextDayPatternProbes;
    metrics.remainingMCapacityRejections += dayMetrics.remainingMCapacityRejections;
    metrics.days.push(dayMetrics);
    metrics.elapsedMs = performance.now() - startedAt;
    const diagnostics = performanceDiagnostics(metrics, quota, tier);
    if (timeBudgetMs !== null && metrics.elapsedMs > timeBudgetMs) {
      return {
        ok: false,
        failures: [`Solver diagnostic time budget ${timeBudgetMs} ms exceeded after day ${dayIndex + 1}; no invalid schedule was returned.`],
        performanceDiagnostics: diagnostics,
        attemptSummary: solverAttemptSummary(metrics, quota, tier, "not started"),
      };
    }
    if (passingBySignature.size === 0) {
      const directReasons = [...directReasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([reason, count]) => `${reason} (${count})`);
      const forwardReasons = [...forwardReasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => `${reason} (${count})`);
      const firstFailure = [
        `First day with no valid daily patterns: day ${dayIndex + 1}.`,
        ...staticFailures,
        `Direct rejection reasons: ${directReasons.length > 0 ? directReasons.join(" / ") : "none"}.`,
        `Forward-check rejection reasons: ${forwardReasons.length > 0 ? forwardReasons.join(" / ") : "none"}.`,
      ];
      return {
        ok: false,
        failures: firstFailure,
        performanceDiagnostics: diagnostics,
        attemptSummary: solverAttemptSummary(metrics, quota, tier, "not started"),
      };
    }

    const remainingSlots = beamWidth - selectedPrimary.length;
    const selectedSecondary = boundedBest(
      [...passingBySignature.values()].flatMap((bucket) => bucket.slice(1)),
      remainingSlots,
      compareCandidates,
    );
    beam = [...selectedPrimary, ...selectedSecondary].map((candidate) => candidate.state);
  }

  const valid = beam
    .map((state) => finalizeBeamState(state, fairness, quota))
    .filter((state) => validateHard(state.schedule, parsed, days, integratedRelaxations(tier), quota).length === 0)
    .sort((a, b) => a.score - b.score);
  if (valid.length === 0) {
    metrics.earlyBeamMs = performance.now() - startedAt - metrics.exactSuffixMs;
    metrics.elapsedMs = performance.now() - startedAt;
    return {
      ok: false,
      failures: [`Tier ${tier}: beam reached month end but no final schedule passed hard validation.`],
      performanceDiagnostics: performanceDiagnostics(metrics, quota, tier),
      attemptSummary: solverAttemptSummary(metrics, quota, tier, metrics.suffixTimedOut ? "timed out" : "exhausted"),
    };
  }
  const state = valid[0];
  const warnings: string[] = [`Tier ${tier} used.`];
  if (tier === 2) warnings.push("Tier 2 used: N spacing rule relaxed.");
  if (tier === 3) {
    warnings.push("Tier 3 used: N spacing rule relaxed.");
    warnings.push("Tier 3 used: N-O-D rule relaxed.");
  }
  if (state.spacingRelaxations > 0) warnings.push(`N spacing relaxations: ${state.spacingRelaxations}.`);
  if (state.nODRelaxations > 0) warnings.push(`N-O-D relaxations: ${state.nODRelaxations}.`);
  metrics.elapsedMs = performance.now() - startedAt;
  metrics.earlyBeamMs = metrics.elapsedMs - metrics.exactSuffixMs;
  return {
    ok: true,
    state,
    schedule: state.schedule,
    warnings,
    performanceDiagnostics: performanceDiagnostics(metrics, quota, tier),
    attemptSummary: solverAttemptSummary(metrics, quota, tier, "succeeded"),
  };
}

function integratedRequestFailures(parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const failures: string[] = [];
  parsed.forEach((input, employeeIndex) => {
    failures.push(...input.requestFailures.map((failure) => `${EMPLOYEES[employeeIndex]}: ${failure}`));
    const educationVacationOverlap = [...input.educationDays].filter((day) => input.vacation.has(day));
    const educationWantedOverlap = [...input.educationDays].filter((day) => input.wantedOff.has(day));
    if (educationVacationOverlap.length > 0) {
      failures.push(
        `${EMPLOYEES[employeeIndex]}: education dates overlap vacation dates: ${educationVacationOverlap.sort((a, b) => a - b).join(", ")}.`,
      );
    }
    if (educationWantedOverlap.length > 0) {
      failures.push(
        `${EMPLOYEES[employeeIndex]}: education dates overlap wanted OFF dates: ${educationWantedOverlap.sort((a, b) => a - b).join(", ")}.`,
      );
    }
    input.requests.forEach((code, day) => {
      if (input.fixedOff.has(day)) {
        failures.push(
          `${EMPLOYEES[employeeIndex]} day ${day}: requested ${code} conflicts with mandatory OFF/vacation/wanted OFF/education date`,
        );
      }
    });
    for (let day = 1; day < days.length; day += 1) {
      const requestedToday = normalizeShift(input.requests.get(day));
      const requestedTomorrow = normalizeShift(input.requests.get(day + 1));
      if (!requestedToday || requestedToday === "OFF" || !conflictsWithKnownNextDayRequest(requestedToday, requestedTomorrow)) continue;
      if ((requestedToday === "E" || requestedToday === "M") && requestedTomorrow === "D") {
        failures.push(
          `${EMPLOYEES[employeeIndex]} day ${day} requested ${requestedToday} conflicts with requested D on day ${day + 1}.`,
        );
      } else if (requestedToday === "N" && requestedTomorrow && requestedTomorrow !== "OFF") {
        failures.push(
          `${EMPLOYEES[employeeIndex]} day ${day} requested N conflicts with requested ${requestedTomorrow} on day ${day + 1} because recovery OFF or N is required.`,
        );
      }
    }
  });
  days.forEach((dayInfo) => {
    const hasVacation = parsed.some((input) => input.vacation.has(dayInfo.day));
    (["D", "E", "M", "N"] as WorkShift[]).forEach((shift) => {
      const owners = EMPLOYEES.filter((_, employeeIndex) => normalizeShift(parsed[employeeIndex].requests.get(dayInfo.day)) === shift);
      if (owners.length > 1) failures.push(`Day ${dayInfo.day}: multiple employees requested ${shift}: ${owners.join(", ")}`);
      if (shift === "M" && hasVacation && owners.length > 0) {
        failures.push(`Day ${dayInfo.day}: requested M is forbidden because at least one employee is on vacation.`);
      }
    });
  });
  return [...new Set(failures)];
}

function buildMonthlyQuotaPlan(
  daysInMonth: number,
  baseOff: number,
  parsed: ParsedEmployeeInput[],
  nTargets: number[],
  nTargetMode: "unified" | "legacy",
): MonthlyQuotaPlan {
  const offTargets = parsed.map((input) => monthlyOffTarget(baseOff, input));
  const workTargets = offTargets.map((target) => daysInMonth - target);
  const requiredTotalWork = workTargets.reduce((sum, target) => sum + target, 0);
  const requiredCoreWork = daysInMonth * 3;
  const nFloorTarget = Math.floor(daysInMonth / EMPLOYEES.length);
  const nRemainder = daysInMonth % EMPLOYEES.length;
  const nCeilTarget = nFloorTarget + (nRemainder > 0 ? 1 : 0);
  return {
    name: "Exact vacation-day OFF plan",
    baseOff,
    offTargets,
    workTargets,
    requiredM: requiredTotalWork - requiredCoreWork,
    nFloorTarget,
    nCeilTarget,
    nRemainder,
    nTargets,
    nMinTargets: nTargetMode === "unified" ? EMPLOYEES.map(() => nFloorTarget) : [...nTargets],
    nMaxTargets: nTargetMode === "unified" ? EMPLOYEES.map(() => nCeilTarget) : [...nTargets],
    nTargetMode,
  };
}

function employeeIndexCombinations(indexes: number[], size: number) {
  const result: number[][] = [];
  const visit = (start: number, selected: number[]) => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let position = start; position <= indexes.length - (size - selected.length); position += 1) {
      selected.push(indexes[position]);
      visit(position + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}

function exactNightTargetVectors(daysInMonth: number) {
  const floorTarget = Math.floor(daysInMonth / EMPLOYEES.length);
  const remainder = daysInMonth % EMPLOYEES.length;
  const employeeIndexes = EMPLOYEES.map((_, employeeIndex) => employeeIndex);
  return employeeIndexCombinations(employeeIndexes, remainder).map((ceilingIndexes) => {
    const ceilingSet = new Set(ceilingIndexes);
    return EMPLOYEES.map((_, employeeIndex) => floorTarget + (ceilingSet.has(employeeIndex) ? 1 : 0));
  });
}

function buildMonthlyQuotaPlans(daysInMonth: number, baseOff: number, parsed: ParsedEmployeeInput[]) {
  const legacyMode = configuredLegacyNightTargetMode();
  const targetPlans = legacyMode
    ? exactNightTargetVectors(daysInMonth).map((nTargets) => ({ nTargets, mode: "legacy" as const }))
    : [{ nTargets: EMPLOYEES.map(() => Math.ceil(daysInMonth / EMPLOYEES.length)), mode: "unified" as const }];
  return targetPlans.map(({ nTargets, mode }) => buildMonthlyQuotaPlan(daysInMonth, baseOff, parsed, nTargets, mode));
}

function applyMonthlyQuotaPlan(parsed: ParsedEmployeeInput[], quota: MonthlyQuotaPlan) {
  parsed.forEach((input, employeeIndex) => {
    input.minOff = quota.offTargets[employeeIndex];
    input.targetOff = quota.offTargets[employeeIndex];
  });
}

function monthlyQuotaSummary(quota: MonthlyQuotaPlan) {
  return [
    `OFF plan: ${quota.name}.`,
    `Base OFF (weekends + holidays): ${quota.baseOff}.`,
    `Selected OFF targets: ${EMPLOYEES.map((employee, index) => `${employee} ${quota.offTargets[index]}`).join(", ")}.`,
    `Selected work targets: ${EMPLOYEES.map((employee, index) => `${employee} ${quota.workTargets[index]}`).join(", ")}.`,
    `Required total M: ${quota.requiredM}.`,
    `N targets: floor ${quota.nFloorTarget}, ceiling ${quota.nCeilTarget}, ceiling employees ${quota.nRemainder}.`,
    `N target mode: ${quota.nTargetMode}.`,
    `N target bounds: ${EMPLOYEES.map((employee, index) => `${employee} ${quota.nMinTargets[index]}-${quota.nMaxTargets[index]}`).join(", ")}.`,
  ];
}

function monthlyQuotaPreflightFailures(
  quota: MonthlyQuotaPlan,
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  dailyPatterns: ReturnType<typeof enumerateDailyPatterns>[],
) {
  const failures: string[] = [];
  const nightAvailability = staticNightAvailability(dailyPatterns);
  const theoreticalMCapacity = dailyPatterns.filter(({ patterns }) =>
    patterns.some((row) => EMPLOYEES.some((employee) => row[employee] === "M")),
  ).length;
  const forcedMDays = days.filter((dayInfo) =>
    parsed.some((input) => normalizeShift(input.requests.get(dayInfo.day)) === "M"),
  ).length;
  if (quota.requiredM < 0) failures.push(`Required M is negative (${quota.requiredM}); selected OFF targets require less than D/E/N core work.`);
  if (quota.requiredM > theoreticalMCapacity) {
    failures.push(`Required M ${quota.requiredM} exceeds theoretical available M capacity ${theoreticalMCapacity}.`);
  }
  if (quota.requiredM < forcedMDays) failures.push(`Required M ${quota.requiredM} is below ${forcedMDays} explicitly requested M day(s).`);
  parsed.forEach((input, employeeIndex) => {
    const target = quota.offTargets[employeeIndex];
    if (input.fixedOff.size > target) {
      failures.push(
        `${EMPLOYEES[employeeIndex]}: OFF target ${target} is below ${input.fixedOff.size} mandatory OFF/vacation/wanted OFF/education dates.`,
      );
    }
    if (target > days.length) failures.push(`${EMPLOYEES[employeeIndex]}: OFF target ${target} exceeds ${days.length} days in month.`);
    const legalNightDays = nightAvailability.filter((available) => available[employeeIndex]).length;
    const requestedNightDays = [...input.requests.values()].filter((shift) => normalizeShift(shift) === "N").length;
    if (quota.nMinTargets[employeeIndex] > legalNightDays) {
      failures.push(
        `${EMPLOYEES[employeeIndex]}: minimum N target ${quota.nMinTargets[employeeIndex]} exceeds ${legalNightDays} statically legal N dates.`,
      );
    }
    if (quota.nMaxTargets[employeeIndex] < requestedNightDays) {
      failures.push(
        `${EMPLOYEES[employeeIndex]}: maximum N target ${quota.nMaxTargets[employeeIndex]} is below ${requestedNightDays} requested N dates.`,
      );
    }
  });
  dailyPatterns.forEach(({ patterns, staticFailures }) => {
    if (patterns.length === 0) failures.push(...staticFailures);
  });
  return failures;
}

function buildTier1Diagnostics(
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  slots: Slot[],
  requestConflicts: string[],
) {
  const selectedSlots = slots.length + days.length;
  const selectedCapacity = regularOffProtectedCapacity(days, parsed);
  const emDBlocked = emToDBlockedDates(parsed);
  const requestedNConflicts = requestedNightOwnersByDay(parsed, days.length).failures;
  return [
    "Tier 1 failure diagnostics",
    `1. Total required N days: ${days.length}. Dynamic N blocks prefer NN; single N is allowed; NNN is allowed at most once only when total N days is odd; NNNN+ is forbidden.`,
    `2. Requested N conflicts by exact day: ${requestedNConflicts.length > 0 ? requestedNConflicts.join(" / ") : "none"}.`,
    `3. Required core slots: D/E+N ${selectedSlots}, regular capacity ${selectedCapacity}.`,
    "4. N blocks are derived dynamically; NN is preferred, single N is mildly penalized, and the odd-month NNN exception is heavily penalized.",
    "5. Exact monthly M quota is assigned inside the integrated day-by-day beam search.",
    "6. Preventive generated OFF remains disabled; exact OFF/work quotas are pruned throughout beam search.",
    `7. E/M -> D request conflicts: ${emDBlocked.length > 0 ? emDBlocked.join(" / ") : "none"}`,
    `8. Request conflicts: ${requestConflicts.length > 0 ? requestConflicts.join(" / ") : "none"}`,
  ];
}
export function generateSchedule(
  year: number,
  month: number,
  inputs: Record<Employee, EmployeeInput>,
  days: DayInfo[],
  variant = 0,
  activeEmployees: readonly Employee[] = Object.keys(inputs),
): ScheduleResult {
  const normalizedEmployees = activeEmployees.map((employee) => employee.trim());
  setActiveEmployees(normalizedEmployees);
  const expectedDays = new Date(year, month, 0).getDate();
  if (
    days.length !== expectedDays ||
    days.some((day, index) => day.day !== index + 1 || day.date.getFullYear() !== year || day.date.getMonth() !== month - 1)
  ) {
    return { ok: false, days, failures: ["Official holiday calendar does not match the selected year and month."] };
  }
  if (
    normalizedEmployees.length === 0 ||
    normalizedEmployees.some((employee) => employee.length === 0) ||
    new Set(normalizedEmployees).size !== normalizedEmployees.length ||
    normalizedEmployees.some((employee) => !inputs[employee])
  ) {
    return { ok: false, days, failures: ["Employee names must be non-empty and unique."] };
  }
  const previousMonthLength = new Date(year, month - 1, 0).getDate();
  const baseOff = baseOffCount(days);
  const parsed = EMPLOYEES.map((employee) => {
    const input = inputs[employee];
    const parsedInput = parseEmployeeInput(input, days.length) as ParsedWithPrevious;
    const offTarget = monthlyOffTarget(baseOff, parsedInput);
    parsedInput.minOff = offTarget;
    parsedInput.targetOff = offTarget;
    parsedInput.previousMonthSchedule = normalizePreviousMonthSchedule(input, previousMonthLength);
    return parsedInput;
  });
  const previousMatchedEmployees = EMPLOYEES.filter((_, employeeIndex) => previousTailFor(parsed, employeeIndex).length > 0);
  const previousUnmatchedEmployees = EMPLOYEES.filter((employee) => !previousMatchedEmployees.includes(employee));
  const previousMatchDiagnostic = `Previous-month matched employees: ${previousMatchedEmployees.length}/${EMPLOYEES.length}; unmatched current employees: ${previousUnmatchedEmployees.length > 0 ? previousUnmatchedEmployees.join(", ") : "none"}.`;
  const requestFailures = integratedRequestFailures(parsed, days);
  const capacityFailures = dailyHardOffCapacityFailures(days, parsed);
  const dailyPatterns = days.map((_, dayIndex) => enumerateDailyPatterns(dayIndex, parsed, days));
  const staticData = buildIntegratedStaticData(days, parsed, dailyPatterns);
  if (requestFailures.length > 0 || capacityFailures.length > 0) {
    return {
      ok: false,
      days,
      failures: [
        "Integrated solver preflight failed.",
        previousMatchDiagnostic,
        ...requestFailures,
        ...capacityFailures,
      ],
    };
  }

  const quotas = buildMonthlyQuotaPlans(days.length, baseOff, parsed);
  const attemptGroups: { quotas: MonthlyQuotaPlan[]; tier: IntegratedTier }[] = [];
  for (const tier of [1, 2, 3] as IntegratedTier[]) {
    attemptGroups.push({ quotas, tier });
  }

  const tierFailures: string[] = [];
  const attemptDiagnostics: string[] = [];
  const reportedPreflightPlans = new Set<string>();
  const allAttemptsStartedAt = performance.now();
  for (const { quotas, tier } of attemptGroups) {
    let selected:
      | {
          quota: MonthlyQuotaPlan;
          tier: IntegratedTier;
          solved: Extract<IntegratedSolveResult, { ok: true }>;
          previousFairness: PreviousMonthFairness;
        }
      | null = null;
    for (const quota of quotas) {
      const preflightStartedAt = performance.now();
      applyMonthlyQuotaPlan(parsed, quota);
      const quotaPreflightFailures = monthlyQuotaPreflightFailures(quota, parsed, days, dailyPatterns);
      if (quotaPreflightFailures.length > 0) {
        attemptDiagnostics.push(
          formatSolverAttempt({
            planName: quota.name,
            tier,
            elapsedMs: performance.now() - preflightStartedAt,
            earlyBeamMs: 0,
            suffixMs: 0,
            suffixOutcome: "not started",
            dfsNodes: 0,
            suffixStartingStates: 0,
          }),
        );
        const preflightKey = `${quota.name}|${quota.nTargetMode}|${quota.nMinTargets.join(",")}|${quota.nMaxTargets.join(",")}`;
        if (!reportedPreflightPlans.has(preflightKey)) {
          tierFailures.push(`${quota.name} quota preflight failed.`, ...monthlyQuotaSummary(quota), ...quotaPreflightFailures);
          reportedPreflightPlans.add(preflightKey);
        }
        continue;
      }
      const previousFairness = buildPreviousMonthFairness(parsed, previousMonthLength, days.length);
      const solved = integratedBeamSolve(days, parsed, tier, variant, previousFairness, quota, staticData);
      attemptDiagnostics.push(formatSolverAttempt(solved.attemptSummary));
      if (solved.ok === false) {
        const dominantDay = solved.performanceDiagnostics
          .slice(1)
          .sort((a, b) => Number(b.match(/; (\d+) ms\.$/)?.[1] ?? 0) - Number(a.match(/; (\d+) ms\.$/)?.[1] ?? 0))[0];
        tierFailures.push(
          `${quota.name}, Tier ${tier} failed.`,
          ...monthlyQuotaSummary(quota),
          solved.performanceDiagnostics[0],
          ...(dominantDay ? [`Dominant timing section: ${dominantDay}`] : []),
          ...solved.failures,
        );
        continue;
      }
      if (!selected || solved.state.score < selected.solved.state.score) {
        selected = { quota, tier, solved, previousFairness };
      }
    }
    if (!selected) continue;
    const { quota, solved, previousFairness } = selected;
    applyMonthlyQuotaPlan(parsed, quota);

    const desiredMDays = days
      .filter((day) => day.isRestDay && !parsed.some((input) => input.vacation.has(day.day)))
      .map((day) => day.day);
    const removedM = desiredMDays.filter((day) => currentMCount(solved.schedule, day - 1) === 0);
    const finalFailures = validateHard(solved.schedule, parsed, days, integratedRelaxations(tier), quota);
    if (finalFailures.length > 0) {
      tierFailures.push(`${quota.name}, Tier ${tier} final validation failed.`, ...finalFailures);
      continue;
    }

    const stats = computeStats(solved.schedule, days);
    const totalElapsedMs = performance.now() - allAttemptsStartedAt;
    const warnings = [
      `Overall solver timing: ${Math.round(totalElapsedMs)} ms across ${attemptDiagnostics.length} attempt(s).`,
      ...attemptDiagnostics,
    ];

    return {
      ok: true,
      schedule: solved.schedule,
      days,
      stats,
      balance: computeBalanceStats(stats),
      removedM,
      warnings,
      score: tier2Score(solved.schedule, days, parsed),
    };
  }

  return {
    ok: false,
    days,
    failures: [
      "Integrated day-by-day solver failed in all tiers.",
      previousMatchDiagnostic,
      `Overall solver timing: ${Math.round(performance.now() - allAttemptsStartedAt)} ms across ${attemptDiagnostics.length} attempt(s).`,
      ...attemptDiagnostics,
      ...tierFailures,
    ],
  };
}
