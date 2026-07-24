import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parsePreviousScheduleXlsx } from "../src/lib/previousSchedule";
import { baseOffCount, generateSchedule } from "../src/lib/scheduler";
import { DEFAULT_EMPLOYEES, type EmployeeInput } from "../src/lib/types";

const fixturePath = process.env.ERP_FIXTURE ??
  "C:/Users/Administrator/Documents/스마트 메신저 받은 파일/7월 응급구조사 스케줄.xlsx";

const emptyInput = (): EmployeeInput => ({
  wantedOff: "",
  vacation: "",
  educationDays: "",
  requests: "",
});

async function importFixture() {
  const bytes = await readFile(fixturePath);
  return parsePreviousScheduleXlsx(new Blob([bytes]), 31, DEFAULT_EMPLOYEES);
}

function withPrevious(
  schedules: Awaited<ReturnType<typeof importFixture>>["schedules"],
  overrides: Partial<Record<(typeof DEFAULT_EMPLOYEES)[number], Partial<EmployeeInput>>> = {},
) {
  return Object.fromEntries(
    DEFAULT_EMPLOYEES.map((employee) => [
      employee,
      {
        ...emptyInput(),
        ...overrides[employee],
        previousMonthSchedule: schedules[employee] ?? [],
      },
    ]),
  );
}

async function main() {
  const imported = await importFixture();
  assert.deepEqual(imported.matchedEmployees, [...DEFAULT_EMPLOYEES]);
  assert.deepEqual(imported.unmatchedEmployees, []);
  assert.equal(imported.schedules.조한승?.[0], "OFF");
  assert.equal(imported.schedules.조한승?.[24], "OFF");
  assert.equal(imported.schedules.신민아?.[0], "D");
  assert.equal(imported.schedules.임세민?.[0], "D");

  const augustInputs = withPrevious(imported.schedules, {
    조한승: { wantedOff: "10,11" },
    이우석: { wantedOff: "21" },
    신민아: {
      wantedOff: "3,4",
      vacation: "24,25,26,27,28,29",
      requests: "1:N,2:N,23:D,30:N",
    },
  });
  const augustStarted = performance.now();
  const august = generateSchedule(2026, 8, augustInputs, new Set(), 0, DEFAULT_EMPLOYEES);
  const augustRuntimeMs = performance.now() - augustStarted;
  assert.equal(august.ok, true, august.ok ? undefined : august.failures.slice(0, 20).join("\n"));

  if (!august.ok) throw new Error("August regression failed.");
  const augustOff = august.stats.map((stat) => stat.off);
  const augustWork = august.stats.map((stat) => stat.totalWork);
  const augustN = august.stats.map((stat) => stat.N);
  const augustM = august.schedule.filter((row) => DEFAULT_EMPLOYEES.some((employee) => row[employee] === "M")).length;
  assert.equal(baseOffCount(august.days), 11);
  assert.deepEqual(augustOff.slice(0, 2), [11, 11]);
  assert.equal(augustOff[2] === 13 || augustOff[2] === 14, true);
  assert.deepEqual(augustOff.slice(3), [11, 11]);
  assert(august.schedule.slice(23, 29).every((row) => row.신민아 === "/"));
  assert(august.schedule.slice(23, 29).every((row) => !DEFAULT_EMPLOYEES.some((employee) => row[employee] === "M")));
  assert.equal(august.warnings.length, 1);
  assert.match(august.warnings[0], /^Solver timing:/);

  const educationInputs = withPrevious({}, {
    임세민: { educationDays: "8" },
  });
  const educationStarted = performance.now();
  const education = generateSchedule(2026, 2, educationInputs, new Set(), 0, DEFAULT_EMPLOYEES);
  const educationRuntimeMs = performance.now() - educationStarted;
  assert.equal(education.ok, true, education.ok ? undefined : education.failures.slice(0, 20).join("\n"));
  if (!education.ok) throw new Error("Education schedule regression failed.");
  assert.equal(education.schedule[7].임세민, "/");
  assert.equal(education.stats[4].off, baseOffCount(education.days) + 1);

  console.log(JSON.stringify({
    fixture: {
      matched: imported.matchedEmployees,
      unmatched: imported.unmatchedEmployees,
    },
    august: {
      baseOff: baseOffCount(august.days),
      offTargetsAndActual: augustOff,
      workTargetsAndActual: augustWork,
      nCounts: augustN,
      requiredAndAssignedM: augustM,
      runtimeMs: Math.round(augustRuntimeMs),
    },
    education: {
      employee: "임세민",
      day: 8,
      offTargetAndActual: education.stats[4].off,
      runtimeMs: Math.round(educationRuntimeMs),
    },
  }, null, 2));
}

void main();
