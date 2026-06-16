import { buildDays } from "./holidays";
import { parseEmployeeInput } from "./input";
import {
  EMPLOYEES,
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
type NightBlock = { startDay: number; endDay: number; days: number[]; length: 2 | 3 };
type NightAssignmentResult =
  | { ok: true; schedule: Schedule; lockedRecoveryOff: Set<string>; blockCounts: number[] }
  | { ok: false; failures: string[] };
type NightSearchDiagnostics = {
  nodesVisited: number;
  deepestDepth: number;
  deepestCounts: number[];
  mostConstrained?: {
    block: NightBlock;
    candidates: number[];
    rejected: { employee: Employee; reason: string }[];
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
  if (normalized === "E1" || normalized === "E竊?" || normalized === "E竊") return "M";
  if (normalized === "D" || normalized === "E" || normalized === "M" || normalized === "N") return normalized;
  if (normalized === "/" || normalized === "OFF") return "OFF";
  return null;
}

function isEveningLike(code: unknown) {
  const normalized = normalizeShift(code);
  return normalized === "E" || normalized === "M";
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

function normalizePreviousMonthSchedule(input: EmployeeInput, previousMonthLength: number): (NormalizedShift | null)[] {
  const raw = previousMonthCandidates(input).find((candidate) => candidate !== undefined && candidate !== null);
  if (raw === undefined || raw === null) return [];

  if (Array.isArray(raw)) return raw.map((code) => normalizeShift(code));

  if (typeof raw === "string") {
    const byDay = new Map<number, NormalizedShift | null>();
    const dayPattern = /(\d+)\s*[:=]\s*(E\s*1|OFF|D|E|M|N|\/)/gi;
    let match: RegExpExecArray | null;
    while ((match = dayPattern.exec(raw)) !== null) {
      const day = Number(match[1]);
      if (Number.isInteger(day) && day >= 1 && day <= previousMonthLength) byDay.set(day, normalizeShift(match[2]));
    }
    if (byDay.size > 0) {
      return Array.from({ length: previousMonthLength }, (_, index) => byDay.get(index + 1) ?? null);
    }
    return raw
      .split(/[\s,;]+/)
      .map((code) => normalizeShift(code))
      .filter((code): code is NormalizedShift => code !== null);
  }

  if (typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>)
      .map(([day, code]) => [Number(day), normalizeShift(code)] as const)
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

function buildNightBlocks(dayCount: number): NightBlock[] {
  const blocks: NightBlock[] = [];
  let day = 1;
  while (day <= dayCount) {
    const remaining = dayCount - day + 1;
    const length = remaining === 3 ? 3 : 2;
    const days = Array.from({ length }, (_, offset) => day + offset);
    blocks.push({ startDay: day, endDay: day + length - 1, days, length: length as 2 | 3 });
    day += length;
  }
  return blocks;
}

function blockRequestOwner(block: NightBlock, parsed: ParsedEmployeeInput[]) {
  const owners = new Set<number>();
  block.days.forEach((day) => {
    parsed.forEach((input, employeeIndex) => {
      if (normalizeShift(input.requests.get(day)) === "N") owners.add(employeeIndex);
    });
  });
  return owners;
}

function blockStartIndex(block: NightBlock) {
  return block.startDay - 1;
}

function blockEndIndex(block: NightBlock) {
  return block.endDay - 1;
}

function nightBlocksTooClose(a: NightBlock, b: NightBlock) {
  const earlier = blockStartIndex(a) <= blockStartIndex(b) ? a : b;
  const later = earlier === a ? b : a;
  return blockStartIndex(later) - blockEndIndex(earlier) < MIN_N_BLOCK_START_GAP;
}

function assignedBlocksForEmployee(schedule: Schedule, blocks: NightBlock[], employeeIndex: number) {
  const employee = EMPLOYEES[employeeIndex];
  return blocks.filter((block) => block.days.every((day) => schedule[day - 1][employee] === "N"));
}

function canAssignNightBlock(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  blocks: NightBlock[],
  block: NightBlock,
  employeeIndex: number,
  blockCounts: number[],
  blockMax: number,
  forcedOwner?: number,
) {
  const employee = EMPLOYEES[employeeIndex];
  if (forcedOwner !== undefined && forcedOwner !== employeeIndex) return `${employee}: requested N forces this block to ${EMPLOYEES[forcedOwner]}`;
  if (blockCounts[employeeIndex] + 1 > blockMax) return `${employee}: N block count target exceeded`;
  for (const day of block.days) {
    if (parsed[employeeIndex].fixedOff.has(day)) return `${employee} day ${day}: N block day fixedOff/vacation/wantedOff`;
    const requested = normalizeShift(parsed[employeeIndex].requests.get(day));
    if (requested && requested !== "N") return `${employee} day ${day}: requested incompatible ${requested}`;
    if (schedule[day - 1][employee] !== "/") return `${employee} day ${day}: already assigned`;
  }

  const shiftAt = (dayIndex: number) => getShiftAtWithPrev(schedule, parsed, dayIndex, employeeIndex);
  const previousLimit = -previousTailFor(parsed, employeeIndex).length;
  const startIndex = blockStartIndex(block);
  if (nightSpacingViolation(shiftAt, startIndex, "N", previousLimit)) {
    return `${employee} day ${block.startDay}: night spacing conflict: requires at least ${MIN_NON_N_DAYS_BETWEEN_N_BLOCKS} non-N days between N blocks`;
  }

  const closeBlock = assignedBlocksForEmployee(schedule, blocks, employeeIndex).find((assignedBlock) => nightBlocksTooClose(assignedBlock, block));
  if (closeBlock) {
    return `${employee} ${block.startDay}-${block.endDay}: night spacing conflict: requires at least ${MIN_NON_N_DAYS_BETWEEN_N_BLOCKS} non-N days between N blocks; conflicts with ${closeBlock.startDay}-${closeBlock.endDay}`;
  }

  const recoveryDay = block.endDay + 1;
  if (recoveryDay <= schedule.length) {
    const requested = normalizeShift(parsed[employeeIndex].requests.get(recoveryDay));
    if (requested && requested !== "OFF") {
      return `${employee} day ${recoveryDay}: requested work ${requested} on recovery OFF day`;
    }
  }

  return null;
}

function canNightCountsStillBalance(blockCounts: number[], assignedBlocks: number, totalBlocks: number, blockMin: number, blockMax: number) {
  const remainingBlocks = totalBlocks - assignedBlocks;
  if (blockCounts.some((count) => count > blockMax)) return false;
  const neededToReachMin = blockCounts.reduce((sum, count) => sum + Math.max(0, blockMin - count), 0);
  if (neededToReachMin > remainingBlocks) return false;
  return true;
}

function compatibleRemainingCountForEmployee(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  blocks: NightBlock[],
  unassignedBlockIndexes: number[],
  employeeIndex: number,
  blockCounts: number[],
  blockMax: number,
  forcedOwners: Map<number, number>,
) {
  return unassignedBlockIndexes.filter((blockIndex) => {
    const forcedOwner = forcedOwners.get(blockIndex);
    return !canAssignNightBlock(schedule, parsed, blocks, blocks[blockIndex], employeeIndex, blockCounts, blockMax, forcedOwner);
  }).length;
}

function canNightCountsStillReachTargets(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  blocks: NightBlock[],
  unassignedBlockIndexes: number[],
  blockCounts: number[],
  blockMin: number,
  blockMax: number,
  forcedOwners: Map<number, number>,
) {
  if (blockCounts.some((count) => count > blockMax)) return false;
  const neededToReachMin = blockCounts.reduce((sum, count) => sum + Math.max(0, blockMin - count), 0);
  if (neededToReachMin > unassignedBlockIndexes.length) return false;
  return EMPLOYEES.every((_, employeeIndex) => {
    const needed = Math.max(0, blockMin - blockCounts[employeeIndex]);
    if (needed === 0) return true;
    return (
      compatibleRemainingCountForEmployee(
        schedule,
        parsed,
        blocks,
        unassignedBlockIndexes,
        employeeIndex,
        blockCounts,
        blockMax,
        forcedOwners,
      ) >= needed
    );
  });
}

function summarizeNightBlockCandidates(
  schedule: Schedule,
  parsed: ParsedEmployeeInput[],
  blocks: NightBlock[],
  blockCounts: number[],
  blockMax: number,
  forcedOwners = new Map<number, number>(),
) {
  const summaries = blocks.map((block, blockIndex) => {
    const forcedOwner = forcedOwners.get(blockIndex);
    const rejected = EMPLOYEES.map((employee, employeeIndex) => ({
      employee,
      reason: canAssignNightBlock(schedule, parsed, blocks, block, employeeIndex, blockCounts, blockMax, forcedOwner),
    }));
    const eligible = rejected.filter((item) => !item.reason).map((item) => item.employee);
    return { block, eligible, rejected: rejected.filter((item): item is { employee: Employee; reason: string } => Boolean(item.reason)) };
  });
  const mostConstrained = [...summaries].sort((a, b) => a.eligible.length - b.eligible.length || a.block.startDay - b.block.startDay)[0];
  const firstZero = summaries.find((summary) => summary.eligible.length === 0);
  const reasonCounts = new Map<string, number>();
  summaries.forEach((summary) => {
    summary.rejected.forEach(({ reason }) => reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1));
  });
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([reason, count]) => `${reason} (${count})`);
  return [
    ...(firstZero
      ? [`First N block with zero candidates: ${firstZero.block.startDay}-${firstZero.block.endDay}.`]
      : ["No N block has zero candidates before recursive spacing/count choices."]),
    ...(mostConstrained
      ? [
          `Most constrained N block: ${mostConstrained.block.startDay}-${mostConstrained.block.endDay}; eligible employees: ${
            mostConstrained.eligible.length > 0 ? mostConstrained.eligible.join(", ") : "none"
          }.`,
        ]
      : []),
    `N candidate counts by block: ${summaries.map((summary) => `${summary.block.startDay}-${summary.block.endDay}:${summary.eligible.length}`).join(", ")}.`,
    `Top N rejection reasons: ${topReasons.length > 0 ? topReasons.join(" / ") : "none"}.`,
    ...summaries.slice(0, 15).map(
      (summary) =>
        `N block ${summary.block.startDay}-${summary.block.endDay}: eligible ${
          summary.eligible.length > 0 ? summary.eligible.join(", ") : "none"
        }; rejected ${
          summary.rejected.length > 0
            ? summary.rejected.map(({ employee, reason }) => `${employee}=${reason}`).join("; ")
            : "none"
        }`,
    ),
  ];
}

function assignNightBlocks(
  baseSchedule: Schedule,
  parsed: ParsedEmployeeInput[],
  blocks: NightBlock[],
  days: DayInfo[],
  seed: number,
): NightAssignmentResult {
  const schedule = baseSchedule.map((row) => ({ ...row })) as Schedule;
  const blockMin = Math.floor(blocks.length / EMPLOYEES.length);
  const blockMax = Math.ceil(blocks.length / EMPLOYEES.length);
  const blockCounts = EMPLOYEES.map(() => 0);
  const lockedRecoveryOff = new Set<string>();
  const failures: string[] = [];
  const forcedOwners = new Map<number, number>();
  const assignedBlockIndexes = new Set<number>();
  const diagnostics: NightSearchDiagnostics = {
    nodesVisited: 0,
    deepestDepth: 0,
    deepestCounts: [...blockCounts],
    rejectionReasons: [],
  };

  blocks.forEach((block, blockIndex) => {
    const owners = blockRequestOwner(block, parsed);
    if (owners.size > 1) {
      failures.push(
        `${block.startDay}-${block.endDay}: N block has conflicting N requests: ${[...owners].map((index) => EMPLOYEES[index]).join(", ")}`,
      );
    } else if (owners.size === 1) {
      forcedOwners.set(blockIndex, [...owners][0]);
    }
  });

  const formatNightDiagnostics = () => {
    const unassignedBlockIndexes = blocks.map((_, index) => index).filter((index) => !assignedBlockIndexes.has(index));
    const mostConstrained =
      diagnostics.mostConstrained ??
      unassignedBlockIndexes
        .map((blockIndex) => candidateSummaryForBlock(blockIndex))
        .sort((a, b) => a.candidates.length - b.candidates.length || a.block.startDay - b.block.startDay)[0];
    const topReasons = commonFailureSummary("Top N rejection reasons", diagnostics.rejectionReasons);
    return [
      `N recursive nodes visited: ${diagnostics.nodesVisited}.`,
      `Deepest N recursion depth: ${diagnostics.deepestDepth}.`,
      `N block counts at deepest failure: ${EMPLOYEES.map((employee, index) => `${employee}:${diagnostics.deepestCounts[index]}`).join(", ")}.`,
      ...(mostConstrained
        ? [
            `Most constrained unresolved N block: ${mostConstrained.block.startDay}-${mostConstrained.block.endDay}.`,
            `Dynamic candidates for that block: ${
              mostConstrained.candidates.length > 0 ? mostConstrained.candidates.map((index) => EMPLOYEES[index]).join(", ") : "none"
            }.`,
            `Rejections for that block: ${
              mostConstrained.rejected.length > 0
                ? mostConstrained.rejected.map(({ employee, reason }) => `${employee}=${reason}`).join("; ")
                : "none"
            }.`,
          ]
        : []),
      ...topReasons,
    ];
  };

  const candidateSummaryForBlock = (blockIndex: number) => {
    const block = blocks[blockIndex];
    const forcedOwner = forcedOwners.get(blockIndex);
    const rejected = EMPLOYEES.map((employee, employeeIndex) => ({
      employee,
      reason: canAssignNightBlock(schedule, parsed, blocks, block, employeeIndex, blockCounts, blockMax, forcedOwner),
    }));
    return {
      block,
      candidates: rejected.filter((item) => !item.reason).map((item) => EMPLOYEES.indexOf(item.employee)),
      rejected: rejected.filter((item): item is { employee: Employee; reason: string } => Boolean(item.reason)),
    };
  };

  if (failures.length > 0) {
    const candidateDiagnostics = summarizeNightBlockCandidates(baseSchedule, parsed, blocks, EMPLOYEES.map(() => 0), blockMax, forcedOwners);
    return { ok: false, failures: [...failures, ...formatNightDiagnostics(), ...candidateDiagnostics] };
  }

  const dfs = (): boolean => {
    diagnostics.nodesVisited += 1;
    const depth = assignedBlockIndexes.size;
    if (depth > diagnostics.deepestDepth) {
      diagnostics.deepestDepth = depth;
      diagnostics.deepestCounts = [...blockCounts];
    }

    if (assignedBlockIndexes.size >= blocks.length) {
      return Math.min(...blockCounts) >= blockMin && Math.max(...blockCounts) <= blockMax;
    }

    const unassignedBlockIndexes = blocks.map((_, index) => index).filter((index) => !assignedBlockIndexes.has(index));
    if (!canNightCountsStillBalance(blockCounts, assignedBlockIndexes.size, blocks.length, blockMin, blockMax)) {
      failures.push("N block count balance impossible");
      return false;
    }
    if (!canNightCountsStillReachTargets(schedule, parsed, blocks, unassignedBlockIndexes, blockCounts, blockMin, blockMax, forcedOwners)) {
      failures.push("N block count target cannot be reached from remaining compatible blocks");
      return false;
    }

    const remaining = unassignedBlockIndexes
      .map((index) => {
        const summary = candidateSummaryForBlock(index);
        summary.rejected.forEach(({ reason }) => diagnostics.rejectionReasons.push(reason));
        return {
          ...summary,
          index,
          forced: forcedOwners.has(index),
        };
      })
      .sort(
        (a, b) =>
          a.candidates.length - b.candidates.length ||
          Number(b.forced) - Number(a.forced) ||
          seededNoise(seed, a.index, a.block.startDay, diagnostics.nodesVisited) -
            seededNoise(seed, b.index, b.block.startDay, diagnostics.nodesVisited) ||
          a.block.startDay - b.block.startDay,
      );

    const selected = remaining[0];
    diagnostics.mostConstrained = selected;
    if (selected.candidates.length === 0) return false;

    const { block, index } = selected;
    const candidates = [...selected.candidates];
    candidates.sort(
      (a, b) =>
        blockCounts[a] - blockCounts[b] ||
        seededNoise(seed, index, block.startDay, a) - seededNoise(seed, index, block.startDay, b),
    );

    for (const employeeIndex of candidates) {
      const reason = canAssignNightBlock(schedule, parsed, blocks, block, employeeIndex, blockCounts, blockMax, forcedOwners.get(index));
      if (reason) continue;
      const employee = EMPLOYEES[employeeIndex];
      block.days.forEach((day) => {
        schedule[day - 1][employee] = "N";
      });
      blockCounts[employeeIndex] += 1;
      assignedBlockIndexes.add(index);
      const recoveryDay = block.endDay + 1;
      if (recoveryDay <= schedule.length) lockedRecoveryOff.add(offKey(employeeIndex, recoveryDay));

      const nextUnassigned = blocks.map((_, blockIndex) => blockIndex).filter((blockIndex) => !assignedBlockIndexes.has(blockIndex));
      if (
        canNightCountsStillBalance(blockCounts, assignedBlockIndexes.size, blocks.length, blockMin, blockMax) &&
        canNightCountsStillReachTargets(schedule, parsed, blocks, nextUnassigned, blockCounts, blockMin, blockMax, forcedOwners) &&
        dfs()
      ) {
        return true;
      }

      if (recoveryDay <= schedule.length) lockedRecoveryOff.delete(offKey(employeeIndex, recoveryDay));
      assignedBlockIndexes.delete(index);
      blockCounts[employeeIndex] -= 1;
      block.days.forEach((day) => {
        schedule[day - 1][employee] = "/";
      });
    }
    return false;
  };

  if (!dfs()) {
    const candidateDiagnostics = summarizeNightBlockCandidates(baseSchedule, parsed, blocks, EMPLOYEES.map(() => 0), blockMax, forcedOwners);
    return {
      ok: false,
      failures: [
        ...(failures.length > 0 ? [...new Set(failures)] : ["Unable to assign N blocks with spacing, recovery OFF, and block-count balance"]),
        ...formatNightDiagnostics(),
        ...candidateDiagnostics,
      ],
    };
  }

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

function validateHard(schedule: Schedule, parsed: ParsedEmployeeInput[], days: DayInfo[]) {
  const failures: string[] = [];
  const nightBlocks = buildNightBlocks(days.length);
  const blockMin = Math.floor(nightBlocks.length / EMPLOYEES.length);
  const blockMax = Math.ceil(nightBlocks.length / EMPLOYEES.length);
  const nightBlockCounts = EMPLOYEES.map(() => 0);
  const finalBlock = nightBlocks[nightBlocks.length - 1];

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
      if (parsed[employeeIndex].fixedOff.has(day) && rawShift !== "/") failures.push(`${employee} day ${day}: work assigned on fixed OFF/vacation`);
      if (isOffLike(current)) {
        streak = 0;
      } else {
        streak += 1;
        if (streak > 5) failures.push(`${employee}: more than 5 consecutive work days`);
      }
      const isAllowedFinalNnn =
        current === "N" &&
        prev === "N" &&
        prevPrev === "N" &&
        finalBlock?.length === 3 &&
        day === finalBlock.endDay &&
        finalBlock.days.every((blockDay) => schedule[blockDay - 1][employee] === "N");
      if (current === "D" && isEveningLike(prev)) failures.push(`${employee} day ${day}: E/M -> D pattern is forbidden`);
      if (prev === "N" && !isOffLike(current) && current !== "N") failures.push(`${employee} day ${day}: after N, ${current} is forbidden`);
      if (dayIndex >= 2 && current === "N" && prev === "N" && prevPrev === "N" && !isAllowedFinalNnn) failures.push(`${employee} day ${day}: NNN pattern is forbidden`);
      else if (prev === "N" && prevPrev === "N" && !isOffLike(current) && current !== "N") failures.push(`${employee} day ${day}: after NN, ${current} is forbidden`);
      if (current === "D" && isOffLike(prev) && prevPrev === "N") failures.push(`${employee} day ${day}: N-O-D pattern is forbidden`);
      if (nightSpacingViolation(shiftAt, dayIndex, current, previousLimit)) {
        failures.push(
          `${employee} day ${day}: night spacing conflict: requires at least ${MIN_NON_N_DAYS_BETWEEN_N_BLOCKS} non-N days between N blocks`,
        );
      }
    }
    const offCount = schedule.filter((row) => row[employee] === "/").length;
    if (offCount < parsed[employeeIndex].minOff) failures.push(`${employee}: OFF count ${offCount} is below minimum ${parsed[employeeIndex].minOff}`);
  });

  nightBlocks.forEach((block, blockIndex) => {
    const assigned = EMPLOYEES.filter((employee) => block.days.every((day) => schedule[day - 1][employee] === "N"));
    if (assigned.length !== 1) {
      failures.push(`${block.startDay}-${block.endDay}: N block must be assigned to exactly one employee`);
      return;
    }
    const employeeIndex = EMPLOYEES.indexOf(assigned[0]);
    nightBlockCounts[employeeIndex] += 1;
    if (block.length === 3 && blockIndex !== nightBlocks.length - 1) {
      failures.push(`${block.startDay}-${block.endDay}: NNN is only allowed in final odd-month block`);
    }
    const recoveryDay = block.endDay + 1;
    if (recoveryDay <= days.length && schedule[recoveryDay - 1][assigned[0]] !== "/") {
      failures.push(`${assigned[0]} day ${recoveryDay}: night recovery OFF required`);
    }
  });

  const regularOffCounts = EMPLOYEES.map((employee, index) => ({
    employee,
    off: schedule.filter((row) => row[employee] === "/").length,
    isLeaveAdjusted: parsed[index].vacation.size > 0 || parsed[index].minOff > 8,
  })).filter((item) => !item.isLeaveAdjusted);
  if (regularOffCounts.length >= 2) {
    const minOff = Math.min(...regularOffCounts.map((item) => item.off));
    const maxOff = Math.max(...regularOffCounts.map((item) => item.off));
    if (maxOff - minOff > 1) {
      failures.push(`Non-leave employee OFF count range ${maxOff - minOff} exceeds 1`);
    }
  }

  days.forEach((dayInfo, dayIndex) => {
    const row = schedule[dayIndex];
    const counts = SHIFTS.reduce((acc, code) => ({ ...acc, [code]: EMPLOYEES.filter((employee) => row[employee] === code).length }), {} as Record<WorkShift, number>);
    if (counts.D !== 1) failures.push(`${dayInfo.day} day D count ${counts.D}`);
    if (counts.E !== 1) failures.push(`${dayInfo.day} day E count ${counts.E}`);
    if (counts.N !== 1) failures.push(`${dayInfo.day} day N count ${counts.N}`);
  });
  if (Math.min(...nightBlockCounts) < blockMin || Math.max(...nightBlockCounts) > blockMax) {
    failures.push(`Employee N block count range ${Math.min(...nightBlockCounts)}-${Math.max(...nightBlockCounts)} outside target ${blockMin}-${blockMax}`);
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
  const workCounts = stats.map((item) => item.totalWork);
  const offCounts = stats.map((item) => item.off);
  const balancePenalty =
    balance.dRange * 35 +
    balance.eveningRange * 25 +
    range(workCounts) * 20 +
    range(offCounts) * 20 +
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
  return buildNightBlocks(schedule.length)
    .map((block) => {
      const owner = EMPLOYEES.find((employee) => block.days.every((day) => schedule[day - 1][employee] === "N"));
      return `${block.startDay}-${block.endDay}:${owner ?? "?"}`;
    })
    .join("|");
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
    else if (input.requests.get(day - 1) === "N" && input.requests.get(day - 2) === "N") reason = "NNN is forbidden";
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

function buildTier1Diagnostics(
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  slots: Slot[],
  requestConflicts: string[],
) {
  const nightBlocks = buildNightBlocks(days.length);
  const blockMin = Math.floor(nightBlocks.length / EMPLOYEES.length);
  const blockMax = Math.ceil(nightBlocks.length / EMPLOYEES.length);
  const selectedSlots = slots.length + days.length;
  const selectedCapacity = regularOffProtectedCapacity(days, parsed);
  const emDBlocked = emToDBlockedDates(parsed);
  return [
    "Tier 1 failure diagnostics",
    `1. Monthly N block count: ${nightBlocks.length}; employee target N block count: ${blockMin}${blockMin === blockMax ? "" : `-${blockMax}`}`,
    `2. N block structure: ${nightBlocks.map((block) => `${block.startDay}-${block.endDay}`).join(", ")}`,
    "3. Hard N balance rule: employee N block count range <= 1. N day count is not a hard balance rule.",
    `4. Required core slots: D/E+N ${selectedSlots}, regular capacity ${selectedCapacity}.`,
    "5. M service is deferred until after a valid D/E+N core schedule is found.",
    "6. Preventive generated OFF: skipped before D/E search; final OFF minimum is validated after search.",
    `7. E/M -> D request conflicts: ${emDBlocked.length > 0 ? emDBlocked.join(" / ") : "none"}`,
    `8. Request conflicts: ${requestConflicts.length > 0 ? requestConflicts.join(" / ") : "none"}`,
  ];
}
export function generateSchedule(
  year: number,
  month: number,
  inputs: Record<Employee, EmployeeInput>,
  manualHolidayDays: Set<number>,
  variant = 0,
): ScheduleResult {
  const days = buildDays(year, month, manualHolidayDays);
  const previousMonthLength = new Date(year, month - 1, 0).getDate();
  const parsed = EMPLOYEES.map((employee) => {
    const input = inputs[employee];
    const parsedInput = parseEmployeeInput(input, days.length) as ParsedWithPrevious;
    parsedInput.previousMonthSchedule = normalizePreviousMonthSchedule(input, previousMonthLength);
    return parsedInput;
  });
  const { activeMDays, removedM: removedMDays } = activeMDaysForMonth(days, parsed);
  const preferredMDays = new Set([...activeMDays, ...removedMDays]);
  const slots = requiredSlots(days);
  const nightBlocks = buildNightBlocks(days.length);
  const hardOffCapacityFailures = dailyHardOffCapacityFailures(days, parsed);
  const requestConflicts = [
    ...new Set([
      ...requestImpossible(parsed, days),
      ...requestedShiftConflicts(parsed, days),
      ...duplicateRequestedShiftConflicts(parsed, days),
    ]),
  ];
  let lastNightAssignmentFailures: string[] = [];
  let lastDemAssignmentFailures: string[] = [];
  let sawFixedNightBlocks = false;
  let nightPlanAttempts = 0;
  let deFailedPlanCount = 0;
  const distinctNightPlans = new Set<string>();
  const allNightFailures: string[] = [];
  const allDEFailures: string[] = [];
  const diagnostics = () => buildTier1Diagnostics(days, parsed, slots, requestConflicts);
  if (hardOffCapacityFailures.length > 0) {
    return {
      ok: false,
      days,
      failures: [
        "Daily hard OFF capacity exceeded.",
        ...hardOffCapacityFailures,
        ...diagnostics(),
      ],
    };
  }
  if (requestConflicts.length > 0) {
    return {
      ok: false,
      days,
      failures: [
        "Requested shifts conflict with Tier 1 rules.",
        ...requestConflicts,
        ...diagnostics(),
      ],
    };
  }

  const totalCapacity = EMPLOYEES.length * days.length - slots.length - days.length;
  const minOffTotal = parsed.reduce((sum, item) => sum + item.minOff, 0);

  if (totalCapacity >= minOffTotal) {
    const maxWork = parsed.map((input) => days.length - input.minOff);

    let bestResult: { schedule: Schedule; score: number; selectionScore: number; stats: EmployeeStats[]; mPostProcess: MPostProcessResult } | null = null;
    let candidateCoreSchedulesEvaluated = 0;
    let firstValidCoreWeekendMCount: number | null = null;
    let bestWeekendHolidayMCount = 0;
    const seedAttempts = 120;
    for (let seed = 0; seed < seedAttempts; seed += 1) {
      const effectiveSeed = variant * seedAttempts + seed;
      nightPlanAttempts += 1;
      const nightAssignment = assignNightBlocks(emptySchedule(days.length), parsed, nightBlocks, days, effectiveSeed);
      if (!nightAssignment.ok) {
        lastNightAssignmentFailures = nightAssignment.failures;
        allNightFailures.push(...nightAssignment.failures);
        continue;
      }
      sawFixedNightBlocks = true;
      const schedule = nightAssignment.schedule;
      distinctNightPlans.add(nightPlanSignature(schedule));
      const requestFillFailures = fillRequests(schedule, parsed, slots, nightAssignment.lockedRecoveryOff);
      if (requestFillFailures.length > 0) {
        lastDemAssignmentFailures = requestFillFailures;
        allDEFailures.push(...requestFillFailures);
        deFailedPlanCount += 1;
        continue;
      }
      const duplicateFailure = validateHard(schedule, parsed, days).filter((failure) => failure.includes("work assigned on fixed OFF/vacation"));
      if (duplicateFailure.length > 0) {
        lastDemAssignmentFailures = duplicateFailure;
        allDEFailures.push(...duplicateFailure);
        deFailedPlanCount += 1;
        continue;
      }

      const lockedOff = buildSearchLockedOff(parsed, nightAssignment.lockedRecoveryOff);
      const counts = recomputeCounts(schedule);
      const searchSlots = buildSearchSlots(slots, schedule, parsed, days);
      const attempt: Attempt = {
        schedule,
        lockedOff,
        ...counts,
        slotIndex: 0,
        deadline: performance.now() + 3000,
      };
      const calls = { count: 0 };
      const coreSolutions: Schedule[] = [];
      const solutionsPerNightPlan = 5;

      collectSearchSolutions(attempt, searchSlots, parsed, days, maxWork, calls, effectiveSeed, preferredMDays, solutionsPerNightPlan, coreSolutions);

      if (coreSolutions.length > 0) {
        for (const coreSchedule of coreSolutions) {
          candidateCoreSchedulesEvaluated += 1;
          const improved = improve(coreSchedule, parsed, days, lockedOff);
          const withM = postProcessM(improved.schedule, parsed, days, lockedOff, activeMDays, removedMDays, effectiveSeed + candidateCoreSchedulesEvaluated);
          if (firstValidCoreWeekendMCount === null) firstValidCoreWeekendMCount = withM.assignedWeekendHolidayMCount;
          bestWeekendHolidayMCount = Math.max(bestWeekendHolidayMCount, withM.assignedWeekendHolidayMCount);
          const stats = computeStats(withM.schedule, days);
          const score = tier2Score(withM.schedule, days, parsed);
          const selectionScore = mPreservationScore(withM.schedule, days, parsed, withM);
          if (!bestResult || selectionScore > bestResult.selectionScore) {
            bestResult = {
              schedule: withM.schedule,
              score,
              selectionScore,
              stats,
              mPostProcess: withM,
            };
          }
        }
        const bestPossibleWeekendM = preferredMDays.size;
        if (bestWeekendHolidayMCount >= bestPossibleWeekendM && candidateCoreSchedulesEvaluated >= 12) break;
      } else {
        const firstFailing = firstFailingDESlotSummary(schedule, parsed, days, lockedOff, searchSlots);
        lastDemAssignmentFailures = ["Search exhausted before a valid D/E assignment was found.", ...(firstFailing ?? [])];
        allDEFailures.push(...lastDemAssignmentFailures);
        deFailedPlanCount += 1;
      }
    }

    if (bestResult) {
      const stats = computeStats(bestResult.schedule, days);
      const selectionWarnings = [
        `Core selection: evaluated ${candidateCoreSchedulesEvaluated} candidate D/E/N schedules; first valid weekend/holiday M count ${
          firstValidCoreWeekendMCount ?? "none"
        }; best weekend/holiday M count ${bestWeekendHolidayMCount}; selected schedule score ${Math.round(bestResult.selectionScore * 100) / 100}.`,
      ];

      return {
        ok: true,
        schedule: bestResult.schedule,
        days,
        stats,
        balance: computeBalanceStats(stats),
        removedM: bestResult.mPostProcess.removedM,
        warnings: [...selectionWarnings, ...bestResult.mPostProcess.warnings],
        score: bestResult.score,
      };
    }
  }

  return {
    ok: false,
    days,
    failures: [
      sawFixedNightBlocks
        ? `Tried ${nightPlanAttempts} N-block plans; D/E search failed for all of them.`
        : "Night block assignment failed for all attempts.",
      ...(sawFixedNightBlocks
        ? [
            `Distinct N-block plans tried: ${distinctNightPlans.size}. D/E failed plans: ${deFailedPlanCount}.`,
            ...lastDemAssignmentFailures,
            ...commonFailureSummary("Most common D/E failures", allDEFailures),
          ]
        : [
            `N-block plans attempted: ${nightPlanAttempts}.`,
            ...lastNightAssignmentFailures,
            ...commonFailureSummary("Top night block assignment failure reasons", allNightFailures),
          ]),
      ...diagnostics(),
    ],
  };
}
