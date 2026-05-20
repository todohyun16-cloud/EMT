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

function emptySchedule(dayCount: number): Schedule {
  return Array.from({ length: dayCount }, () =>
    Object.fromEntries(EMPLOYEES.map((employee) => [employee, "/" as ShiftCode])) as Record<Employee, ShiftCode>,
  );
}

function requiredSlots(days: DayInfo[], activeMDays: Set<number>): Slot[] {
  const slots: Slot[] = [];
  days.forEach((day, index) => {
    slots.push({ dayIndex: index, code: "N" });
    slots.push({ dayIndex: index, code: "D" });
    slots.push({ dayIndex: index, code: "E" });
    if (activeMDays.has(day.day)) {
      slots.push({ dayIndex: index, code: "M" });
    }
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
  const allRestMWork = requiredSlots(days, activeMDays).length;
  const vacationOffBonus = parsed.reduce((sum, input) => sum + Math.max(0, input.minOff - 8), 0);

  for (const day of restDayMRemovalPriority(days, parsed)) {
    const hasHardOff = parsed.some((input) => input.fixedOff.has(day));
    const hardOffCount = parsed.filter((input) => input.fixedOff.has(day)).length;
    const maxOffWithM = EMPLOYEES.length - 4;
    if (!hasHardOff && hardOffCount <= maxOffWithM) continue;
    if (activeMDays.size <= 0) break;
    activeMDays.delete(day);
    removedM.push(day);
  }

  const desiredWork = allRestMWork + vacationOffBonus;
  const weekdayCandidates = days
    .filter((day) => !day.isRestDay && !activeMDays.has(day.day))
    .sort((a, b) => {
      const aHardOff = parsed.filter((input) => input.fixedOff.has(a.day)).length;
      const bHardOff = parsed.filter((input) => input.fixedOff.has(b.day)).length;
      return aHardOff - bHardOff || a.day - b.day;
    });

  let slotCount = requiredSlots(days, activeMDays).length;
  for (const day of weekdayCandidates) {
    if (slotCount >= desiredWork) break;
    activeMDays.add(day.day);
    slotCount += 1;
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

function wouldExceedConsecutive(schedule: Schedule, employee: Employee, dayIndex: number, code: WorkShift) {
  const next = [...schedule.map((row) => row[employee])];
  next[dayIndex] = code;
  let streak = 0;
  for (const shift of next) {
    if (shift === "/") streak = 0;
    else {
      streak += 1;
      if (streak > 5) return true;
    }
  }
  return false;
}

function shiftWithCandidate(schedule: Schedule, employee: Employee, candidateDayIndex: number, candidateCode: WorkShift) {
  return (index: number) => (index === candidateDayIndex ? candidateCode : schedule[index]?.[employee]);
}

function hasKnownPatternViolation(schedule: Schedule, employee: Employee, dayIndex: number, code: WorkShift) {
  const shiftAt = shiftWithCandidate(schedule, employee, dayIndex, code);
  const prev = shiftAt(dayIndex - 1);
  const prevPrev = shiftAt(dayIndex - 2);

  if (prev === "N" && code !== "N") return "N 다음날은 OFF 또는 N만 허용";
  if (prev === "N" && prevPrev === "N") return "NN 다음날은 반드시 OFF";

  if (code === "D") {
    if (prev === "E" || prev === "M") return "E/M 다음날 D 금지";
  }
  if (code === "N") {
    if (prev === "N" && prevPrev === "N") return "NNN 금지";
  }
  return null;
}

function hasFuturePatternViolation(schedule: Schedule, employee: Employee, dayIndex: number, code: WorkShift) {
  const shiftAt = shiftWithCandidate(schedule, employee, dayIndex, code);
  const prev = shiftAt(dayIndex - 1);
  const next = shiftAt(dayIndex + 1);
  const afterNext = shiftAt(dayIndex + 2);

  if ((code === "E" || code === "M") && next === "D") return true;
  if (code !== "N") return false;
  if (prev === "N" && next === "N") return true;
  if (next !== undefined && next !== "/" && next !== "N") return true;
  if (next === "N" && afterNext !== undefined && afterNext !== "/") return true;
  return false;
}

function canAssign(
  attempt: Attempt,
  parsed: ParsedEmployeeInput[],
  slot: Slot,
  employeeIndex: number,
  nMax: number,
  maxWork: number[],
) {
  const employee = EMPLOYEES[employeeIndex];
  const day = slot.dayIndex + 1;
  if (attempt.schedule[slot.dayIndex][employee] !== "/") return false;
  if (isLockedOff(attempt.lockedOff, employeeIndex, day)) return false;
  if (isFixedOff(parsed, employeeIndex, day)) return false;
  if (slot.code === "N" && parsed[employeeIndex].fixedOff.has(day + 1)) return false;
  if (slot.code === "N" && parsed[employeeIndex].requests.has(day + 1) && parsed[employeeIndex].requests.get(day + 1) !== "N") return false;
  if (slot.code === "N" && attempt.schedule[slot.dayIndex - 1]?.[employee] === "N" && parsed[employeeIndex].requests.has(day + 1)) return false;
  if (attempt.workCounts[employeeIndex] + 1 > maxWork[employeeIndex]) return false;
  if (slot.code === "N" && attempt.shiftCounts[employeeIndex].N + 1 > nMax) return false;
  if (wouldExceedConsecutive(attempt.schedule, employee, slot.dayIndex, slot.code)) return false;
  if (hasKnownPatternViolation(attempt.schedule, employee, slot.dayIndex, slot.code)) return false;
  if (hasFuturePatternViolation(attempt.schedule, employee, slot.dayIndex, slot.code)) return false;

  const requested = parsed[employeeIndex].requests.get(day);
  if (requested && requested !== slot.code) return false;
  return true;
}

function requestImpossible(parsed: ParsedEmployeeInput[], days: DayInfo[], activeMDays: Set<number>) {
  const failures: string[] = [];
  parsed.forEach((input, index) => {
    input.requests.forEach((code, day) => {
      const employee = EMPLOYEES[index];
      if (input.fixedOff.has(day)) failures.push(`${employee} ${day}일 희망근무 ${code}: 원티드오프/휴가와 충돌`);
      if (code === "N" && input.fixedOff.has(day + 1)) failures.push(`${employee} ${day}일 N: 다음날 OFF 침범`);
      if (input.requests.get(day - 1) === "N" && code !== "N") failures.push(`${employee} ${day}일 ${code}: N 다음날은 OFF 또는 N만 가능`);
      if (input.requests.get(day - 1) === "N" && input.requests.get(day - 2) === "N") failures.push(`${employee} ${day}일 ${code}: NN 다음날은 반드시 OFF`);
      if (code === "D" && input.requests.get(day - 2) === "N" && input.fixedOff.has(day - 1)) failures.push(`${employee} ${day}일 D: N-O-D 패턴 금지`);
      if (code === "N" && input.requests.has(day + 1) && input.requests.get(day + 1) !== "N") failures.push(`${employee} ${day}일 N: 다음날 희망근무와 충돌`);
      if (code === "N" && input.requests.get(day + 1) === "N" && input.requests.has(day + 2)) failures.push(`${employee} ${day}일 N: NN 다음날 희망근무 불가`);
      const needed = activeMDays.has(day) ? ["D", "E", "M", "N"] : ["D", "E", "N"];
      if (!needed.includes(code)) failures.push(`${employee} ${day}일 ${code}: 해당 날짜 필요 근무가 아님`);
    });
  });
  return failures;
}

function fillRequests(schedule: Schedule, parsed: ParsedEmployeeInput[], slots: Slot[]) {
  for (const [employeeIndex, input] of parsed.entries()) {
    for (const [day, code] of input.requests) {
      const exists = slots.some((slot) => slot.dayIndex === day - 1 && slot.code === code);
      if (!exists) continue;
      schedule[day - 1][EMPLOYEES[employeeIndex]] = code;
    }
  }
}

function buildInitialLockedOff(parsed: ParsedEmployeeInput[]) {
  const lockedOff = new Set<string>();
  parsed.forEach((input, employeeIndex) => {
    input.fixedOff.forEach((day) => lockedOff.add(offKey(employeeIndex, day)));
  });
  return lockedOff;
}

function requiredShiftCountForDay(days: DayInfo[], day: number, activeMDays: Set<number>) {
  return 3 + (activeMDays.has(day) ? 1 : 0);
}

function dailyHardOffCapacityFailures(days: DayInfo[], parsed: ParsedEmployeeInput[], activeMDays: Set<number>) {
  const failures: string[] = [];
  days.forEach((dayInfo) => {
    const requiredShiftCount = requiredShiftCountForDay(days, dayInfo.day, activeMDays);
    const maxOff = EMPLOYEES.length - requiredShiftCount;
    const hardOffEmployees = EMPLOYEES.filter((_, employeeIndex) => parsed[employeeIndex].fixedOff.has(dayInfo.day));
    if (hardOffEmployees.length > maxOff) {
      failures.push(
        `${dayInfo.day}일: 해당 날짜 원티드오프 인원이 근무 가능 OFF 슬롯을 초과했습니다. ` +
          `hard OFF ${hardOffEmployees.length}명(${hardOffEmployees.join(", ")}), 가능 OFF ${maxOff}명`,
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
  if (lockedOffCountForDay(lockedOff, day) >= EMPLOYEES.length - requiredShiftCountForDay(days, day, removedM)) return false;
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
    requiredShiftCountForDay(days, day, removedM) * 10 +
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
          failures.push(`${EMPLOYEES[employeeIndex]} ${start}-${start + 5}일: 6일 구간 안에 선점 가능한 OFF 위치가 없습니다.`);
          continue;
        }
        lockedOff.add(offKey(employeeIndex, selectedDay));
        inserted.push(`${EMPLOYEES[employeeIndex]} ${selectedDay}일 OFF (${start}-${start + 5}일 6일 구간 차단)`);
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
    const uncoveredWindows = () =>
      Array.from({ length: Math.max(0, days.length - 5) }, (_, index) => index + 1).filter(
        (start) => !hasLockedOffInWindow(lockedOff, employeeIndex, start),
      );

    let uncovered = uncoveredWindows();
    while (uncovered.length > 0) {
      if (lockedOffCount(lockedOff, employeeIndex) >= Math.max(input.minOff, input.fixedOff.size)) {
        failures.push(
          `${EMPLOYEES[employeeIndex]} ${uncovered[0]}-${uncovered[0] + 5}일: OFF 총량을 늘리지 않고 6일 구간을 차단할 수 없습니다.`,
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
        }))
        .filter((candidate) => candidate.covered.length > 0)
        .sort((a, b) => {
          const coverageDiff = b.covered.length - a.covered.length;
          if (coverageDiff !== 0) return coverageDiff;
          return b.day - a.day || ((a.day + seed) % 3) - ((b.day + seed) % 3);
        })[0];

      if (!selected) {
        failures.push(`${EMPLOYEES[employeeIndex]} ${uncovered[0]}-${uncovered[0] + 5}일: 삽입 가능한 forced OFF 날짜가 없습니다.`);
        break;
      }

      lockedOff.add(offKey(employeeIndex, selected.day));
      inserted.push(
        `${EMPLOYEES[employeeIndex]} ${selected.day}일 OFF (${selected.covered.map((start) => `${start}-${start + 5}일`).join(", ")} 구간 차단)`,
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
        failures.push(`${EMPLOYEES[employeeIndex]} OFF 최소 ${input.minOff}개를 선점할 수 없습니다.`);
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
) {
  const lockedOff = buildInitialLockedOff(parsed);
  const preventive = reservePreventiveOffsSetCover(schedule, parsed, days, removedM, lockedOff, seed);
  const failures = [
    ...preventive.failures,
    ...reserveMinimumOffs(schedule, parsed, days, removedM, lockedOff, seed),
  ];
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
  const remaining = slots.filter((slot) => !EMPLOYEES.some((employee) => schedule[slot.dayIndex][employee] === slot.code));
  const byKey = new Map(remaining.map((slot) => [`${slot.dayIndex}:${slot.code}`, slot]));
  const used = new Set<string>();
  const ordered: Slot[] = [];
  const addSlot = (slot: Slot | undefined) => {
    if (!slot) return;
    const key = `${slot.dayIndex}:${slot.code}`;
    if (used.has(key)) return;
    used.add(key);
    ordered.push(slot);
  };

  const dayIndexes = days
    .map((_, dayIndex) => dayIndex)
    .sort((a, b) => dayConstraintScore(b, parsed, days) - dayConstraintScore(a, parsed, days) || a - b);

  dayIndexes.forEach((dayIndex) => {
    if (dayConstraintScore(dayIndex, parsed, days) <= 0) return;
    SHIFTS.filter((code) => byKey.has(`${dayIndex - 1}:${code}`))
      .sort((a, b) => SLOT_PRIORITY[a] - SLOT_PRIORITY[b])
      .forEach((code) => addSlot(byKey.get(`${dayIndex - 1}:${code}`)));
    SHIFTS.filter((code) => byKey.has(`${dayIndex}:${code}`))
      .sort((a, b) => SLOT_PRIORITY[a] - SLOT_PRIORITY[b])
      .forEach((code) => addSlot(byKey.get(`${dayIndex}:${code}`)));
  });

  remaining
    .sort((a, b) => a.dayIndex - b.dayIndex || SLOT_PRIORITY[a.code] - SLOT_PRIORITY[b.code])
    .forEach(addSlot);

  return ordered;
}

function scoreCandidate(
  attempt: Attempt,
  parsed: ParsedEmployeeInput[],
  slot: Slot,
  employeeIndex: number,
  days: DayInfo[],
  seed: number,
) {
  const day = slot.dayIndex + 1;
  const employee = EMPLOYEES[employeeIndex];
  const counts = attempt.shiftCounts[employeeIndex];
  const exploration = seed === 0 ? 0 : ((employeeIndex * 17 + day * 13 + seed * 23 + slot.code.charCodeAt(0)) % 11) * 2.5;
  let score = attempt.workCounts[employeeIndex] * 8;
  if (slot.code === "N") score += counts.N * 45;
  if (parsed[employeeIndex].requests.get(day) === slot.code) score -= 90;
  if (slot.code === "D") score -= 5;
  if (slot.code === "N") score += 8;
  if (days[slot.dayIndex].isHoliday) score += counts.D + counts.E + counts.M + counts.N;
  if (parsed[employeeIndex].vacation.has(day + 1) && slot.code === "D") score -= 18;
  if (parsed[employeeIndex].vacation.has(day - 1) && slot.code === "N") score -= 18;
  const projectedOff = days.length - (attempt.workCounts[employeeIndex] + 1);
  if (parsed[employeeIndex].vacation.size > 0 && projectedOff < parsed[employeeIndex].targetOff) score += 180;
  const prev = attempt.schedule[slot.dayIndex - 1]?.[employee];
  if (prev !== "/" && prev !== undefined) score += 8;
  return score + exploration;
}

function search(
  attempt: Attempt,
  searchSlots: Slot[],
  parsed: ParsedEmployeeInput[],
  days: DayInfo[],
  activeMDays: Set<number>,
  nMin: number,
  nMax: number,
  maxWork: number[],
  calls: { count: number },
  seed: number,
): boolean {
  calls.count += 1;
  if (calls.count > MAX_ATTEMPTS || performance.now() > attempt.deadline) return false;
  if (attempt.slotIndex >= searchSlots.length) {
    const nCounts = attempt.shiftCounts.map((counts) => counts.N);
    if (Math.min(...nCounts) < nMin || Math.max(...nCounts) - Math.min(...nCounts) > 1) return false;
    return validateHard(attempt.schedule, parsed, days, activeMDays).length === 0;
  }

  const slot = searchSlots[attempt.slotIndex];
  const candidates = EMPLOYEES.map((_, index) => index)
    .filter((index) => canAssign(attempt, parsed, slot, index, nMax, maxWork))
    .sort((a, b) => scoreCandidate(attempt, parsed, slot, a, days, seed) - scoreCandidate(attempt, parsed, slot, b, days, seed));

  for (const employeeIndex of candidates) {
    const employee = EMPLOYEES[employeeIndex];
    attempt.schedule[slot.dayIndex][employee] = slot.code;
    attempt.workCounts[employeeIndex] += 1;
    attempt.shiftCounts[employeeIndex][slot.code] += 1;
    attempt.slotIndex += 1;

    if (search(attempt, searchSlots, parsed, days, activeMDays, nMin, nMax, maxWork, calls, seed)) return true;

    attempt.slotIndex -= 1;
    attempt.shiftCounts[employeeIndex][slot.code] -= 1;
    attempt.workCounts[employeeIndex] -= 1;
    attempt.schedule[slot.dayIndex][employee] = "/";
  }
  return false;
}

function validateHard(schedule: Schedule, parsed: ParsedEmployeeInput[], days: DayInfo[], activeMDays = new Set(days.filter((day) => day.isRestDay).map((day) => day.day))) {
  const failures: string[] = [];
  EMPLOYEES.forEach((employee, employeeIndex) => {
    let streak = 0;
    let nStreak = 0;
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const day = dayIndex + 1;
      const shift = schedule[dayIndex][employee];
      if (parsed[employeeIndex].fixedOff.has(day) && shift !== "/") failures.push(`${employee} ${day}일 OFF/휴가 근무 배정 금지`);
      if (shift === "N" && parsed[employeeIndex].fixedOff.has(day + 1)) failures.push(`${employee} ${day}일 N이 다음날 OFF를 침범`);
      if (shift === "/") {
        streak = 0;
        nStreak = 0;
      } else {
        streak += 1;
        if (streak > 5) failures.push(`${employee} 6연속 근무 발생`);
        nStreak = shift === "N" ? nStreak + 1 : 0;
        if (nStreak > 2) failures.push(`${employee} NNN 발생`);
      }
      const next = schedule[dayIndex + 1]?.[employee];
      const afterNext = schedule[dayIndex + 2]?.[employee];
      if ((shift === "E" || shift === "M") && next === "D") failures.push(`${employee} ${day}일 ${shift} 다음날 D 발생`);
      if (shift === "N" && next !== undefined && next !== "/" && next !== "N") failures.push(`${employee} ${day}일 N 다음날 ${next} 발생`);
      if (shift === "N" && next === "N" && afterNext !== undefined && afterNext !== "/") failures.push(`${employee} ${day}일 NN 다음날 ${afterNext} 발생`);
      if (shift === "N" && next === "/" && afterNext === "D") failures.push(`${employee} ${day}일 N-O-D 발생`);
    }
    const offCount = schedule.filter((row) => row[employee] === "/").length;
    if (offCount < parsed[employeeIndex].minOff) failures.push(`${employee} 월 OFF ${offCount}개: 최소 ${parsed[employeeIndex].minOff}개 미달`);
  });
  const regularOffCounts = EMPLOYEES.map((employee, index) => ({
    employee,
    off: schedule.filter((row) => row[employee] === "/").length,
    hasVacation: parsed[index].vacation.size > 0,
  })).filter((item) => !item.hasVacation);
  if (regularOffCounts.length >= 2) {
    const minOff = Math.min(...regularOffCounts.map((item) => item.off));
    const maxOff = Math.max(...regularOffCounts.map((item) => item.off));
    if (maxOff - minOff > 1) {
      failures.push(`비휴가 직원 OFF 개수 차이 ${maxOff - minOff}개: 최대 1개 초과`);
    }
  }

  days.forEach((dayInfo, dayIndex) => {
    const row = schedule[dayIndex];
    const counts = SHIFTS.reduce((acc, code) => ({ ...acc, [code]: EMPLOYEES.filter((employee) => row[employee] === code).length }), {} as Record<WorkShift, number>);
    if (counts.D !== 1) failures.push(`${dayInfo.day}일 D ${counts.D}명`);
    if (counts.E !== 1) failures.push(`${dayInfo.day}일 E ${counts.E}명`);
    if (counts.N !== 1) failures.push(`${dayInfo.day}일 N ${counts.N}명`);
    if (activeMDays.has(dayInfo.day) && counts.M !== 1) failures.push(`${dayInfo.day}일 M ${counts.M}명`);
    if (!activeMDays.has(dayInfo.day) && counts.M !== 0) failures.push(`${dayInfo.day}일 M 불필요 배정`);
  });
  const nCounts = EMPLOYEES.map((employee) => schedule.filter((row) => row[employee] === "N").length);
  if (Math.max(...nCounts) - Math.min(...nCounts) > 1) failures.push(`직원별 N 개수 차이 ${Math.max(...nCounts) - Math.min(...nCounts)}개`);
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

function improve(schedule: Schedule, parsed: ParsedEmployeeInput[], days: DayInfo[], lockedOff: Set<string>, activeMDays: Set<number>) {
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
          if (validateHard(candidate, parsed, days, activeMDays).length > 0) continue;

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
              if (validateHard(candidate, parsed, days, activeMDays).length > 0) continue;

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

function listDays(days: number[]) {
  return days.length > 0 ? days.join(", ") : "없음";
}

function nPossibleDaysForEmployee(input: ParsedEmployeeInput, days: DayInfo[]) {
  const possible: number[] = [];
  const blocked: string[] = [];

  days.forEach((dayInfo) => {
    const day = dayInfo.day;
    const nextRequest = input.requests.get(day + 1);
    let reason = "";

    if (input.fixedOff.has(day)) reason = "당일 원티드오프/휴가";
    else if (input.fixedOff.has(day + 1)) reason = "다음날 원티드오프/휴가";
    else if (nextRequest && nextRequest !== "N") reason = `다음날 희망근무 ${nextRequest}`;
    else if (input.requests.get(day - 1) === "N" && input.requests.get(day - 2) === "N") reason = "NNN 금지";
    else if (input.requests.get(day - 1) === "N" && input.requests.has(day + 1)) reason = "NN 다음날 회복 OFF 불가";

    if (reason) blocked.push(`${day}일(${reason})`);
    else possible.push(day);
  });

  return { possible, blocked };
}

function requestedShiftConflicts(parsed: ParsedEmployeeInput[], days: DayInfo[], activeMDays: Set<number>) {
  const conflicts: string[] = [];
  parsed.forEach((input, index) => {
    const employee = EMPLOYEES[index];
    input.requests.forEach((code, day) => {
      const prev = input.requests.get(day - 1);
      const prevPrev = input.requests.get(day - 2);
      const next = input.requests.get(day + 1);
      const nextNext = input.requests.get(day + 2);
      const needed = activeMDays.has(day) ? ["D", "E", "M", "N"] : ["D", "E", "N"];

      if (input.fixedOff.has(day)) conflicts.push(`${employee} ${day}일 ${code}: 원티드오프/휴가와 충돌`);
      if (!needed.includes(code)) conflicts.push(`${employee} ${day}일 ${code}: 해당 날짜 필요 근무가 아님`);
      if ((prev === "E" || prev === "M") && code === "D") conflicts.push(`${employee} ${day - 1}일 ${prev} -> ${day}일 D`);
      if (prev === "N" && code !== "N") conflicts.push(`${employee} ${day - 1}일 N -> ${day}일 ${code}`);
      if (prev === "N" && prevPrev === "N") conflicts.push(`${employee} ${day}일 ${code}: NN 다음날은 반드시 OFF`);
      if (code === "N" && input.fixedOff.has(day + 1)) conflicts.push(`${employee} ${day}일 N: 다음날 원티드오프/휴가 침범`);
      if (code === "N" && next && next !== "N") conflicts.push(`${employee} ${day}일 N -> ${day + 1}일 ${next}`);
      if (code === "N" && next === "N" && nextNext) conflicts.push(`${employee} ${day}일 N -> ${day + 1}일 N -> ${day + 2}일 ${nextNext}`);
      if (code === "D" && input.fixedOff.has(day - 1) && input.requests.get(day - 2) === "N") conflicts.push(`${employee} ${day - 2}일 N -> ${day - 1}일 / -> ${day}일 D`);
    });
  });
  return [...new Set(conflicts)];
}

function emToDBlockedDates(parsed: ParsedEmployeeInput[]) {
  const blocked: string[] = [];
  parsed.forEach((input, index) => {
    const employee = EMPLOYEES[index];
    input.requests.forEach((code, day) => {
      const next = input.requests.get(day + 1);
      const prev = input.requests.get(day - 1);
      if ((code === "E" || code === "M") && next === "D") blocked.push(`${employee}: ${day}일 ${code} -> ${day + 1}일 D`);
      if (code === "D" && (prev === "E" || prev === "M")) blocked.push(`${employee}: ${day - 1}일 ${prev} -> ${day}일 D`);
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
      if (!hasFixedOff) risks.push(`${employee}: ${start}-${start + 5}일 고정 OFF 없음`);
    }
  });
  return risks.slice(0, 12);
}

function buildTier1Diagnostics(
  days: DayInfo[],
  parsed: ParsedEmployeeInput[],
  slots: Slot[],
  removedM: number[],
  activeMDays: Set<number>,
  requestConflicts: string[],
  forcedOffs: string[] = [],
  forcedOffFailures: string[] = [],
) {
  const nNeeded = slots.filter((slot) => slot.code === "N").length;
  const nMin = Math.floor(nNeeded / EMPLOYEES.length);
  const nMax = Math.ceil(nNeeded / EMPLOYEES.length);
  const nAvailability = parsed.map((input, index) => {
    const { possible, blocked } = nPossibleDaysForEmployee(input, days);
    return { employee: EMPLOYEES[index], possible, blocked };
  });
  const nBalancePossible =
    nAvailability.every((item) => item.possible.length >= nMin) &&
    nAvailability.reduce((sum, item) => sum + item.possible.length, 0) >= nNeeded;
  const allMCapacity = regularOffProtectedCapacity(days, parsed);
  const allRestMDays = new Set(days.filter((day) => day.isRestDay).map((day) => day.day));
  const allMSlots = requiredSlots(days, allRestMDays).length;
  const selectedCapacity = regularOffProtectedCapacity(days, parsed);
  const selectedSlots = slots.length;
  const regularOffPossibleWithAllM = allMSlots <= allMCapacity;
  const regularOffPossibleAfterRemoval = selectedSlots <= selectedCapacity;
  const removeCount = removedM.length;
  const emDBlocked = emToDBlockedDates(parsed);
  const consecutiveRisks = [
    `forced OFF 삽입: ${forcedOffs.length > 0 ? forcedOffs.slice(0, 20).join(" / ") : "추가 삽입 없음"}`,
    `forced OFF 삽입 실패: ${forcedOffFailures.length > 0 ? forcedOffFailures.join(" / ") : "없음"}`,
  ];

  return [
    "Tier 1 실패 진단",
    `1. 월 전체 N 필요 개수: ${nNeeded}개 / 직원별 목표 N: ${nMin}${nMin === nMax ? "" : `-${nMax}`}개`,
    "2. 직원별 N 배치 가능한 날짜 수",
    ...nAvailability.map((item) => `- ${item.employee}: ${item.possible.length}일 가능 (${listDays(item.possible)})`),
    `3. N 균등 차이 ≤ 1 필요조건: ${nBalancePossible ? "가능" : "불가능"} (각 직원 최소 ${nMin}개 가능해야 함)`,
    `4. OFF 8개 가능 여부: all-M 기준 ${regularOffPossibleWithAllM ? "가능" : "불가능"} / 적용된 M 제거 ${removeCount}개(${listDays([...removedM].sort((a, b) => a - b))}) 후 ${regularOffPossibleAfterRemoval ? "가능" : "불가능"}`,
    `5. 연속근무 5일 예방 처리: ${consecutiveRisks.join(" / ")}`,
    `6. E/M→D 금지 때문에 막힌 희망근무 날짜: ${emDBlocked.length > 0 ? emDBlocked.join(" / ") : "없음"}`,
    `7. 희망근무 Tier 1 충돌: ${requestConflicts.length > 0 ? requestConflicts.join(" / ") : "없음"}`,
    "참고: OFF 8개 가능 여부는 M 제거 개수 결정에만 사용했고, 실제 생성 가능성은 전체 Tier 1 validator로 별도 판단했습니다.",
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
  const parsed = EMPLOYEES.map((employee) => parseEmployeeInput(inputs[employee], days.length));
  const { activeMDays, removedM: removedMDays } = activeMDaysForMonth(days, parsed);
  const removedM = new Set(removedMDays);
  const slots = requiredSlots(days, activeMDays);
  const hardOffCapacityFailures = dailyHardOffCapacityFailures(days, parsed, activeMDays);
  const requestConflicts = [...new Set([...requestImpossible(parsed, days, activeMDays), ...requestedShiftConflicts(parsed, days, activeMDays)])];
  const forcedOffPreviewSchedule = emptySchedule(days.length);
  fillRequests(forcedOffPreviewSchedule, parsed, slots);
  const forcedOffPreview = reserveGeneratorOffs(forcedOffPreviewSchedule, parsed, days, activeMDays, variant);
  let lastForcedOffs = forcedOffPreview.forcedOffs;
  let lastForcedOffFailures = forcedOffPreview.failures;
  const diagnostics = () => buildTier1Diagnostics(days, parsed, slots, removedMDays, activeMDays, requestConflicts, lastForcedOffs, lastForcedOffFailures);
  if (hardOffCapacityFailures.length > 0) {
    return {
      ok: false,
      days,
      failures: [
        "날짜별 hard OFF 용량을 초과했습니다.",
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
        "희망근무가 Tier 1과 충돌합니다.",
        ...requestConflicts,
        ...diagnostics(),
      ],
    };
  }

  const totalCapacity = EMPLOYEES.length * days.length - slots.length;
  const minOffTotal = parsed.reduce((sum, item) => sum + item.minOff, 0);

  if (totalCapacity >= minOffTotal) {
    const nSlots = slots.filter((slot) => slot.code === "N").length;
    const nMin = Math.floor(nSlots / EMPLOYEES.length);
    const nMax = Math.ceil(nSlots / EMPLOYEES.length);
    const maxWork = parsed.map((input) => days.length - input.minOff);

    let bestResult: { schedule: Schedule; score: number; stats: EmployeeStats[] } | null = null;
    const seedAttempts = 24;
    for (let seed = 0; seed < seedAttempts; seed += 1) {
      const effectiveSeed = variant * 8 + seed;
      const schedule = emptySchedule(days.length);
      fillRequests(schedule, parsed, slots);
      const duplicateFailure = validateHard(schedule, parsed, days, activeMDays).filter((failure) => failure.includes("근무 배정 금지"));
      if (duplicateFailure.length > 0) continue;
      const { lockedOff, failures: offReservationFailures, forcedOffs } = reserveGeneratorOffs(
        schedule,
        parsed,
        days,
        activeMDays,
        effectiveSeed,
      );
      lastForcedOffs = forcedOffs;
      lastForcedOffFailures = offReservationFailures;
      if (offReservationFailures.length > 0) continue;

      const counts = recomputeCounts(schedule);
      const searchSlots = buildSearchSlots(slots, schedule, parsed, days);
      const attempt: Attempt = {
        schedule,
        lockedOff,
        ...counts,
        slotIndex: 0,
        deadline: performance.now() + 2600,
      };
      const calls = { count: 0 };

      if (search(attempt, searchSlots, parsed, days, activeMDays, nMin, nMax, maxWork, calls, effectiveSeed)) {
        const improved = improve(attempt.schedule, parsed, days, lockedOff, activeMDays);
        const stats = computeStats(improved.schedule, days);
        if (!bestResult || improved.score < bestResult.score) {
          bestResult = {
            schedule: improved.schedule,
            score: improved.score,
            stats,
          };
        }
        const balance = computeBalanceStats(stats);
        if (balance.dRange <= 1 && balance.eveningRange <= 1) break;
      }
    }

    if (bestResult) {
      return {
        ok: true,
        schedule: bestResult.schedule,
        days,
        stats: bestResult.stats,
        balance: computeBalanceStats(bestResult.stats),
        removedM: [...removedM].sort((a, b) => a - b),
        warnings: removedM.size > 0 ? [`원티드오프/휴가가 있는 휴일 ${[...removedM].sort((a, b) => a - b).join(", ")}일 M 근무를 제거하고, 필요 근무량은 평일 M으로 보상했습니다.`] : [],
        score: bestResult.score,
      };
    }
  }

  return {
    ok: false,
    days,
    failures: [
      "Tier 1 가능 스케줄을 찾지 못했습니다.",
      ...(removedM.size === 0 ? ["휴일/주말 M 근무를 제거하지 않았습니다."] : [`원티드오프/휴가가 있는 휴일 ${removedM.size}개의 M을 제거하고 평일 M으로 보상했습니다.`]),
      ...diagnostics(),
    ],
  };
}
