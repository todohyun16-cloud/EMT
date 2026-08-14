import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildScheduleWorkbook } from "../src/lib/excel";
import {
  buildDays,
  fetchOfficialHolidays,
  parseOfficialHolidayApiXml,
  type OfficialHoliday,
} from "../src/lib/holidays";
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
import {
  DEFAULT_EMPLOYEES,
  type EmployeeInput,
  type EmployeeStats,
  type Schedule,
} from "../src/lib/types";

const emptyInput = (): EmployeeInput => ({
  wantedOff: "",
  vacation: "",
  educationDays: "",
  requests: "",
});

const AUGUST_2026_HOLIDAYS: OfficialHoliday[] = [
  { date: "2026-08-15", name: "광복절" },
  { date: "2026-08-17", name: "광복절 대체공휴일" },
];
const SEPTEMBER_2026_HOLIDAYS: OfficialHoliday[] = [
  { date: "2026-09-24", name: "추석 전날" },
  { date: "2026-09-25", name: "추석" },
  { date: "2026-09-26", name: "추석 다음날" },
];

function calendar(
  year: number,
  month: number,
  officialHolidays: readonly OfficialHoliday[] = [],
  manualHolidayDays: Set<number> = new Set(),
) {
  return buildDays(year, month, officialHolidays, manualHolidayDays);
}

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

test("official and manual holidays produce deduplicated base OFF dates", () => {
  const august = calendar(2026, 8, AUGUST_2026_HOLIDAYS);
  assert.equal(august.filter((day) => day.isWeekend).length, 10);
  assert.equal(baseOffCount(august), 11);
  assert.equal(baseOffCount(calendar(2026, 8, AUGUST_2026_HOLIDAYS, new Set([15]))), 11);
  assert.equal(baseOffCount(calendar(2026, 8, AUGUST_2026_HOLIDAYS, new Set([17]))), 11);
  assert.equal(baseOffCount(calendar(2026, 8, AUGUST_2026_HOLIDAYS, new Set([3]))), 12);
});

test("September 2026 uses only official Chuseok dates and exact vacation-day OFF bonuses", () => {
  const september = calendar(2026, 9, SEPTEMBER_2026_HOLIDAYS);
  assert.deepEqual(
    september.filter((day) => day.isHoliday).map((day) => day.day),
    [24, 25, 26],
  );
  assert.equal(september[27].isHoliday, false);
  assert.equal(baseOffCount(september), 10);

  const none = parseEmployeeInput(emptyInput(), 30);
  const oneVacation = parseEmployeeInput({ ...emptyInput(), vacation: "10" }, 30);
  const twoVacations = parseEmployeeInput({ ...emptyInput(), vacation: "10,11" }, 30);
  const vacationAndEducation = parseEmployeeInput({ ...emptyInput(), vacation: "10", educationDays: "11" }, 30);
  assert.deepEqual(
    [none, oneVacation, twoVacations, vacationAndEducation].map((input) => {
      const off = monthlyOffTarget(10, input);
      return { off, work: 30 - off };
    }),
    [
      { off: 10, work: 20 },
      { off: 11, work: 19 },
      { off: 12, work: 18 },
      { off: 12, work: 18 },
    ],
  );
});

test("official API payload preserves real substitute holidays and client failures are explicit", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>
      <item><dateName>삼일절</dateName><locdate>20260301</locdate></item>
      <item><dateName>삼일절 대체공휴일</dateName><locdate>20260302</locdate></item>
    </items></body></response>`;
  const holidays = parseOfficialHolidayApiXml(xml, 2026, 3);
  assert.deepEqual(holidays, [
    { date: "2026-03-01", name: "삼일절" },
    { date: "2026-03-02", name: "삼일절 대체공휴일" },
  ]);
  const march = calendar(2026, 3, holidays);
  assert.equal(march[1].isHoliday, true);
  assert.equal(march[1].holidayName, "삼일절 대체공휴일");

  await assert.rejects(
    () => fetchOfficialHolidays(2026, 9, async () => new Response(JSON.stringify({ error: "API unavailable" }), { status: 502 })),
    /Unable to load official holidays: API unavailable/,
  );
});

test("education dates are unique mandatory OFF dates with exact quota bonuses", () => {
  const normal = parseEmployeeInput({ ...emptyInput(), educationDays: "8,8,22" }, 31);
  assert.deepEqual([...normal.educationDays], [8, 22]);
  assert(normal.fixedOff.has(8));
  assert(normal.fixedOff.has(22));
  assert.equal(monthlyOffTarget(11, normal), 13);

  const vacation = parseEmployeeInput({ ...emptyInput(), vacation: "24,25,26,27,28,29", educationDays: "8,22" }, 31);
  assert.equal(monthlyOffTarget(11, vacation), 19);
});

test("education overlap and invalid current-month shift codes are diagnosed", () => {
  const overlap = generateSchedule(
    2026,
    8,
    inputs({ 조한승: { wantedOff: "8", vacation: "9", educationDays: "8,9" } }),
    calendar(2026, 8, AUGUST_2026_HOLIDAYS),
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
    calendar(2026, 8, AUGUST_2026_HOLIDAYS),
  );
  assert.equal(eBoundary.ok, false);
  if (!eBoundary.ok) assert(eBoundary.failures.some((failure) => failure.includes("Day 1")));

  const previousN = Array.from({ length: previousLength }, () => null as string | null);
  previousN[previousLength - 1] = "N10";
  const nBoundary = generateSchedule(
    2026,
    8,
    inputs({ 조한승: { requests: "1:E", previousMonthSchedule: previousN } }),
    calendar(2026, 8, AUGUST_2026_HOLIDAYS),
  );
  assert.equal(nBoundary.ok, false);
  if (!nBoundary.ok) assert(nBoundary.failures.some((failure) => failure.includes("Day 1")));
});

test("standalone Excel export has one ordered employee row and only D/E/M/N/O codes", async () => {
  const days = calendar(2026, 8, AUGUST_2026_HOLIDAYS);
  const codes = ["D", "E", "M", "N", "/"] as const;
  const schedule = days.map((_, dayIndex) =>
    Object.fromEntries(
      DEFAULT_EMPLOYEES.map((employee, employeeIndex) => [
        employee,
        codes[(dayIndex + employeeIndex) % codes.length],
      ]),
    ),
  ) as Schedule;
  const stats = DEFAULT_EMPLOYEES.map((employee) => ({
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
  })) satisfies EmployeeStats[];

  const generated = await buildScheduleWorkbook({
    year: 2026,
    month: 8,
    days,
    schedule,
    stats,
    employees: [...DEFAULT_EMPLOYEES],
  });
  const bytes = await generated.xlsx.writeBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["8월 당직표", "개인별 통계"]);
  const scheduleSheet = workbook.getWorksheet("8월 당직표");
  const statsSheet = workbook.getWorksheet("개인별 통계");
  assert(scheduleSheet);
  assert(statsSheet);
  assert.deepEqual(
    Array.from({ length: DEFAULT_EMPLOYEES.length }, (_, index) => scheduleSheet.getCell(index + 5, 1).value),
    [...DEFAULT_EMPLOYEES],
  );
  assert.deepEqual(
    Array.from({ length: DEFAULT_EMPLOYEES.length }, (_, index) => statsSheet.getCell(index + 2, 1).value),
    [...DEFAULT_EMPLOYEES],
  );
  assert.deepEqual(
    Array.from({ length: days.length }, (_, index) => scheduleSheet.getCell(2, index + 2).value),
    days.map((day) => day.day),
  );

  const employeeNameCounts = new Map(DEFAULT_EMPLOYEES.map((employee) => [employee, 0]));
  scheduleSheet.eachRow((row) => {
    const name = String(row.getCell(1).value ?? "");
    if (employeeNameCounts.has(name as (typeof DEFAULT_EMPLOYEES)[number])) {
      employeeNameCounts.set(name as (typeof DEFAULT_EMPLOYEES)[number], employeeNameCounts.get(name as (typeof DEFAULT_EMPLOYEES)[number])! + 1);
    }
  });
  assert([...employeeNameCounts.values()].every((count) => count === 1));

  const allowedCodes = new Set(["D", "E", "M", "N", "O"]);
  const exportedCodes: string[] = [];
  for (let employeeIndex = 0; employeeIndex < DEFAULT_EMPLOYEES.length; employeeIndex += 1) {
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      const value = String(scheduleSheet.getCell(employeeIndex + 5, dayIndex + 2).value ?? "");
      exportedCodes.push(value);
      assert(allowedCodes.has(value), `Unexpected exported shift code: ${value}`);
    }
  }
  assert(exportedCodes.includes("O"));
  assert(!exportedCodes.includes("/"));
  for (const erpCode of ["D7", "E11", "N10", "OFF", "Y1", "X1", "XH"]) {
    assert(!exportedCodes.includes(erpCode));
  }
});
