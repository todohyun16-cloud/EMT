import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildDays } from "../src/lib/holidays";
import {
  deserializeEmployeeInputs,
  deserializeRosterInputState,
  parseEmployeeInput,
  parseRequestsStrict,
  serializeEmployeeInputs,
  serializeRosterInputState,
} from "../src/lib/input";
import {
  normalizePreviousMonthShift,
  parsePreviousScheduleWorksheet,
} from "../src/lib/previousSchedule";
import {
  baseOffCount,
  generateSchedule,
  monthlyOffTarget,
  normalizePreviousMonthSchedule,
} from "../src/lib/scheduler";
import { DEFAULT_EMPLOYEES, type EmployeeInput } from "../src/lib/types";

const emptyInput = (): EmployeeInput => ({
  wantedOff: "",
  vacation: "",
  educationDays: "",
  requests: "",
});

function inputs(overrides: Partial<Record<(typeof DEFAULT_EMPLOYEES)[number], Partial<EmployeeInput>>> = {}) {
  return Object.fromEntries(
    DEFAULT_EMPLOYEES.map((employee) => [employee, { ...emptyInput(), ...overrides[employee] }]),
  );
}

function syntheticPreviousWorksheet(options: {
  omitEmployee?: string;
  duplicateEmployee?: string;
  duplicateDay?: number;
} = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("ERP");
  sheet.getCell(2, 3).value = "성 명";
  for (let day = 1; day <= 31; day += 1) {
    sheet.getCell(2, 5 + day * 2).value = day;
  }
  if (options.duplicateDay) sheet.getCell(2, 6 + options.duplicateDay * 2).value = options.duplicateDay;
  sheet.getCell(2, 70).value = "근무별 합계";
  sheet.getCell(2, 71).value = "D";
  const reordered = ["신민아", "외부직원", "임세민", "조한승", "박대성", "이우석"];
  let row = 4;
  for (const employee of reordered) {
    if (employee === options.omitEmployee) continue;
    sheet.getCell(row, 3).value = employee;
    sheet.getCell(row, 7).value = employee === "신민아" ? "B2C" : "D7";
    sheet.getCell(row, 9).value = null;
    row += 2;
  }
  if (options.duplicateEmployee) {
    sheet.getCell(row, 3).value = options.duplicateEmployee;
  }
  return sheet;
}

test("base OFF counts weekday holidays and counts weekend overlap once", () => {
  const august = buildDays(2026, 8, new Set());
  assert.equal(august.filter((day) => day.isWeekend).length, 10);
  assert.equal(baseOffCount(august), 11);
  assert.equal(baseOffCount(buildDays(2026, 8, new Set([1]))), 11);
  assert.equal(baseOffCount(buildDays(2026, 8, new Set([3]))), 12);
});

test("education dates are unique mandatory OFF dates with exact quota bonuses", () => {
  const normal = parseEmployeeInput({ ...emptyInput(), educationDays: "8,8,22" }, 31);
  assert.deepEqual([...normal.educationDays], [8, 22]);
  assert(normal.fixedOff.has(8));
  assert(normal.fixedOff.has(22));
  assert.equal(monthlyOffTarget(11, normal), 13);

  const vacation = parseEmployeeInput({ ...emptyInput(), vacation: "24,25,26,27,28,29", educationDays: "8,22" }, 31);
  assert.equal(monthlyOffTarget(11, vacation), 15);
  assert.equal(monthlyOffTarget(11, vacation, true), 16);
});

test("education overlap and invalid current-month shift codes are diagnosed", () => {
  const overlap = generateSchedule(
    2026,
    8,
    inputs({ 조한승: { wantedOff: "8", vacation: "9", educationDays: "8,9" } }),
    new Set(),
  );
  assert.equal(overlap.ok, false);
  if (!overlap.ok) {
    assert(overlap.failures.some((failure) => failure.includes("education dates overlap vacation dates: 9")));
    assert(overlap.failures.some((failure) => failure.includes("education dates overlap wanted OFF dates: 8")));
  }

  const strict = parseRequestsStrict("1:D7, 2:E, 3:OFF, 4:/", 31);
  assert.equal(strict.requests.get(2), "E");
  assert.deepEqual([...strict.requestedOff], [3, 4]);
  assert(strict.failures.some((failure) => failure.includes('Invalid requested shift code "D7"')));
});

test("educationDays survives serialization and missing legacy data loads empty", () => {
  const serialized = serializeEmployeeInputs([{ ...emptyInput(), educationDays: "8,22" }]);
  assert.equal(deserializeEmployeeInputs(serialized)[0].educationDays, "8,22");
  assert.equal(deserializeEmployeeInputs('[{"wantedOff":"","vacation":"","requests":""}]')[0].educationDays, "");
});

test("saved custom employee names remain unchanged while legacy arrays use new defaults", () => {
  const customNames = ["A", "B", "C", "D", "E"];
  const custom = deserializeRosterInputState(
    serializeRosterInputState(customNames, customNames.map(() => emptyInput())),
    DEFAULT_EMPLOYEES,
  );
  assert.deepEqual(custom.employeeNames, customNames);

  const legacy = deserializeRosterInputState(
    '[{"wantedOff":"1","vacation":"","requests":""}]',
    DEFAULT_EMPLOYEES,
  );
  assert.deepEqual(legacy.employeeNames, [...DEFAULT_EMPLOYEES]);
  assert.equal(legacy.inputs[0].wantedOff, "1");
  assert.equal(legacy.inputs.length, DEFAULT_EMPLOYEES.length);
});

test("ERP shift normalization preserves blanks and maps unknown non-empty codes to OFF", () => {
  assert.equal(normalizePreviousMonthShift("D8"), "D");
  assert.equal(normalizePreviousMonthShift("E22"), "E");
  assert.equal(normalizePreviousMonthShift("N10"), "N");
  assert.equal(normalizePreviousMonthShift("B2C"), "OFF");
  assert.equal(normalizePreviousMonthShift("Y1"), "OFF");
  assert.equal(normalizePreviousMonthShift(""), null);
  assert.equal(normalizePreviousMonthShift(null), null);
  assert.deepEqual(
    normalizePreviousMonthSchedule(
      { ...emptyInput(), previousMonthSchedule: ["D7", "E11", "N10", "B2C", null] },
      5,
    ),
    ["D", "E", "N", "OFF", null],
  );
});

test("ERP parser uses exact names and non-consecutive day columns", () => {
  const parsed = parsePreviousScheduleWorksheet(syntheticPreviousWorksheet({ omitEmployee: "임세민" }), 31, DEFAULT_EMPLOYEES);
  assert.deepEqual(parsed.matchedEmployees, ["조한승", "이우석", "신민아", "박대성"]);
  assert.deepEqual(parsed.unmatchedEmployees, ["임세민"]);
  assert.equal(parsed.schedules.신민아?.[0], "OFF");
  assert.equal(parsed.schedules.신민아?.[1], null);
  assert.equal(Object.hasOwn(parsed.schedules, "외부직원"), false);
});

test("ERP parser rejects duplicate employee rows, duplicate dates, and missing dates", () => {
  assert.throws(
    () => parsePreviousScheduleWorksheet(syntheticPreviousWorksheet({ duplicateEmployee: "조한승" }), 31, DEFAULT_EMPLOYEES),
    /duplicate employee rows for 조한승/,
  );
  assert.throws(
    () => parsePreviousScheduleWorksheet(syntheticPreviousWorksheet({ duplicateDay: 12 }), 31, DEFAULT_EMPLOYEES),
    /duplicate day headers: 12/,
  );
  const missingDay = syntheticPreviousWorksheet();
  missingDay.getCell(2, 5 + 17 * 2).value = null;
  assert.throws(
    () => parsePreviousScheduleWorksheet(missingDay, 31, DEFAULT_EMPLOYEES),
    /missing day headers: 17/,
  );
});

test("cross-month ERP E and N prefixes enforce day-1 boundaries", () => {
  const previousLength = 31;
  const previousE = Array.from({ length: previousLength }, () => null as string | null);
  previousE[previousLength - 1] = "E22";
  const eBoundary = generateSchedule(
    2026,
    8,
    inputs({ 조한승: { requests: "1:D", previousMonthSchedule: previousE } }),
    new Set(),
  );
  assert.equal(eBoundary.ok, false);
  if (!eBoundary.ok) assert(eBoundary.failures.some((failure) => failure.includes("Day 1")));

  const previousN = Array.from({ length: previousLength }, () => null as string | null);
  previousN[previousLength - 1] = "N10";
  const nBoundary = generateSchedule(
    2026,
    8,
    inputs({ 조한승: { requests: "1:E", previousMonthSchedule: previousN } }),
    new Set(),
  );
  assert.equal(nBoundary.ok, false);
  if (!nBoundary.ok) assert(nBoundary.failures.some((failure) => failure.includes("Day 1")));
});
