import { CalendarDays, Download, Loader2, Play, RefreshCw, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { exportScheduleXlsx } from "@/lib/excel";
import { buildDays } from "@/lib/holidays";
import { parseDays } from "@/lib/input";
import { parsePreviousScheduleXlsx } from "@/lib/previousSchedule";
import { generateSchedule } from "@/lib/scheduler";
import { DEFAULT_EMPLOYEES, type Employee, type EmployeeInput, type ScheduleResult } from "@/lib/types";
import styles from "./styles/App.module.css";

const now = new Date();
const emptyEmployeeInput: EmployeeInput = { wantedOff: "", vacation: "", requests: "" };
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function defaultInputs() {
  return DEFAULT_EMPLOYEES.map(() => ({ ...emptyEmployeeInput }));
}

function shiftClass(code: string) {
  if (code === "D") return styles.dayShift;
  if (code === "E" || code === "M") return styles.eveningShift;
  if (code === "N") return styles.nightShift;
  return styles.offShift;
}

export default function App() {
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [employeeNames, setEmployeeNames] = useState<string[]>([...DEFAULT_EMPLOYEES]);
  const [inputs, setInputs] = useState<EmployeeInput[]>(defaultInputs);
  const [manualHolidays, setManualHolidays] = useState("");
  const [template, setTemplate] = useState<File | null>(null);
  const [result, setResult] = useState<ScheduleResult | null>(null);
  const [generationVariant, setGenerationVariant] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const maxDay = useMemo(() => new Date(year, month, 0).getDate(), [year, month]);

  const updateEmployee = (employeeIndex: number, field: keyof EmployeeInput, value: string) => {
    setInputs((current) => current.map((input, index) => (index === employeeIndex ? { ...input, [field]: value } : input)));
  };

  const runGenerate = (variant: number) => {
    setIsGenerating(true);
    window.setTimeout(() => {
      void (async () => {
        const holidays = parseDays(manualHolidays, maxDay);
        const activeEmployees = employeeNames.map((name) => name.trim());
        if (activeEmployees.some((name) => name.length === 0) || new Set(activeEmployees).size !== activeEmployees.length) {
          setResult({
            ok: false,
            days: buildDays(year, month, holidays),
            failures: ["Employee names must be non-empty and unique."],
          });
          setIsGenerating(false);
          return;
        }

        try {
          const previousMonthLength = new Date(year, month - 1, 0).getDate();
          let previousSchedules: Partial<Record<Employee, (string | null)[]>> = {};
          if (template) {
            try {
              previousSchedules = await parsePreviousScheduleXlsx(template, previousMonthLength, activeEmployees);
            } catch {
              setResult({
                ok: false,
                days: buildDays(year, month, holidays),
                failures: ["Failed to read previous-month Excel schedule. Please check employee names and date headers."],
              });
              return;
            }
          }

          const inputsWithPrevious = Object.fromEntries(
            activeEmployees.map((employee, index) => [
              employee,
              {
                ...inputs[index],
                previousMonthSchedule: previousSchedules[employee] ?? [],
              },
            ]),
          ) as Record<Employee, EmployeeInput>;

          const next = generateSchedule(year, month, inputsWithPrevious, holidays, variant, activeEmployees);
          if (next.ok && template) {
            const loadedCount = activeEmployees.filter((employee) => previousSchedules[employee]?.length).length;
            const unmatched = activeEmployees.filter((employee) => !previousSchedules[employee]?.length);
            setResult({
              ...next,
              warnings: [
                ...next.warnings,
                `Previous-month schedule loaded for ${loadedCount} of ${activeEmployees.length} employees.`,
                ...(unmatched.length > 0 ? [`No previous-month match for: ${unmatched.join(", ")}.`] : []),
              ],
            });
          } else {
            setResult(next);
          }
        } finally {
          setIsGenerating(false);
        }
      })();
    }, 20);
  };

  const generate = () => {
    setGenerationVariant(0);
    runGenerate(0);
  };

  const regenerate = () => {
    const nextVariant = generationVariant + 1;
    setGenerationVariant(nextVariant);
    runGenerate(nextVariant);
  };

  const reset = () => {
    setEmployeeNames([...DEFAULT_EMPLOYEES]);
    setInputs(defaultInputs());
    setManualHolidays("");
    setGenerationVariant(0);
    setResult(null);
  };

  const exportXlsx = async () => {
    if (!result?.ok) return;
    setIsExporting(true);
    try {
      await exportScheduleXlsx({
        year,
        month,
        days: result.days,
        schedule: result.schedule,
        stats: result.stats,
        employees: result.stats.map((stat) => stat.employee),
        template,
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.toolbar}>
        <div>
          <p className={styles.eyebrow}>EMS duty roster</p>
          <h1>응급구조사 당직표 생성</h1>
        </div>
        <div className={styles.periodControls}>
          <label>
            연도
            <input type="number" value={year} min={2024} max={2050} onChange={(event) => setYear(Number(event.target.value))} />
          </label>
          <label>
            월
            <input type="number" value={month} min={1} max={12} onChange={(event) => setMonth(Number(event.target.value))} />
          </label>
        </div>
      </section>

      <section className={styles.inputBand}>
        <div className={styles.sectionHeader}>
          <CalendarDays size={18} />
          <h2>입력</h2>
        </div>
        <div className={styles.holidayRow}>
          <label>
            임시공휴일
            <input value={manualHolidays} onChange={(event) => setManualHolidays(event.target.value)} placeholder="예: 3,4,10" />
          </label>
          <label>
            이전 달 Excel 일정
            <input type="file" accept=".xlsx" onChange={(event) => setTemplate(event.target.files?.[0] ?? null)} />
          </label>
        </div>

        <div className={styles.employeeGrid}>
          {employeeNames.map((employee, employeeIndex) => (
            <article className={styles.employeePanel} key={employeeIndex}>
              <label>
                직원 이름
                <input
                  value={employee}
                  onChange={(event) =>
                    setEmployeeNames((current) => current.map((name, index) => (index === employeeIndex ? event.target.value : name)))
                  }
                />
              </label>
              <label>
                원티드오프
                <input value={inputs[employeeIndex].wantedOff} onChange={(event) => updateEmployee(employeeIndex, "wantedOff", event.target.value)} placeholder="3,4,10,11" />
              </label>
              <label>
                휴가
                <input value={inputs[employeeIndex].vacation} onChange={(event) => updateEmployee(employeeIndex, "vacation", event.target.value)} placeholder="12,13,14,15,16,17" />
              </label>
              <label>
                희망근무
                <input value={inputs[employeeIndex].requests} onChange={(event) => updateEmployee(employeeIndex, "requests", event.target.value)} placeholder="7:D, 18:N, 25:E" />
              </label>
            </article>
          ))}
        </div>

        <div className={styles.actions}>
          <button className={styles.secondaryButton} type="button" onClick={reset}>
            <RotateCcw size={16} />
            초기화
          </button>
          <button className={styles.primaryButton} type="button" onClick={generate} disabled={isGenerating}>
            {isGenerating ? <Loader2 className={styles.spin} size={17} /> : <Play size={17} />}
            Generate Schedule
          </button>
          {result?.ok && (
            <button className={styles.secondaryButton} type="button" onClick={regenerate} disabled={isGenerating}>
              {isGenerating ? <Loader2 className={styles.spin} size={17} /> : <RefreshCw size={17} />}
              Regenerate Schedule
            </button>
          )}
          <button className={styles.secondaryButton} type="button" onClick={exportXlsx} disabled={!result?.ok || isExporting}>
            {isExporting ? <Loader2 className={styles.spin} size={17} /> : <Download size={17} />}
            엑셀 내보내기
          </button>
        </div>
      </section>

      {result && !result.ok && (
        <section className={styles.failureBox}>
          <h2>생성 실패</h2>
          {result.failures.map((failure) => (
            <p key={failure}>{failure}</p>
          ))}
        </section>
      )}

      {result?.ok && (
        <>
          <section className={styles.statusLine}>
            <span>Tier 1 통과</span>
            <span>최적화 점수 {result.score}</span>
            <span>D 최대-최소 {result.balance.dRange}</span>
            <span>E/M 최대-최소 {result.balance.eveningRange}</span>
            {result.removedM.length > 0 && <span>M 제거일 {result.removedM.join(", ")}</span>}
          </section>
          {result.warnings.map((warning) => (
            <p className={styles.warning} key={warning}>
              {warning}
            </p>
          ))}

          <section className={styles.tableWrap}>
            <table className={styles.scheduleTable}>
              <thead>
                <tr>
                  <th>일</th>
                  <th>요일</th>
                  <th>구분</th>
                  {result.stats.map(({ employee }) => (
                    <th key={employee}>{employee}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.days.map((day, index) => (
                  <tr key={day.day} className={day.isRestDay ? styles.restDayRow : undefined}>
                    <td>{day.day}</td>
                    <td>{WEEKDAYS[day.weekday]}</td>
                    <td>{day.holidayName ?? (day.isWeekend ? "주말" : "평일")}</td>
                    {result.stats.map(({ employee }) => {
                      const code = result.schedule[index][employee];
                      return (
                        <td key={employee}>
                          <span className={`${styles.shiftPill} ${shiftClass(code)}`}>{code}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className={styles.statsGrid}>
            {result.stats.map((stat) => (
              <article className={styles.statPanel} key={stat.employee}>
                <h3>{stat.employee}</h3>
                <div><span>D</span><strong>{stat.D}</strong></div>
                <div><span>E/M</span><strong>{stat.evening}</strong></div>
                <div><span>N</span><strong>{stat.N}</strong></div>
                <div><span>OFF</span><strong>{stat.off}</strong></div>
                <div><span>토요일</span><strong>{stat.saturday}</strong></div>
                <div><span>일요일</span><strong>{stat.sunday}</strong></div>
                <div><span>공휴일</span><strong>{stat.holiday}</strong></div>
                <div><span>주말 2오프</span><strong>{stat.weekendTwoOff ? "Y" : "N"}</strong></div>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
