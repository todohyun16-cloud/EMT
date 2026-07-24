import type { DayInfo, Employee, EmployeeStats, Schedule } from "./types";

type ExcelJSModule = typeof import("exceljs");

export type ScheduleWorkbookArgs = {
  year: number;
  month: number;
  days: DayInfo[];
  schedule: Schedule;
  stats: EmployeeStats[];
  employees: Employee[];
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const SCHEDULE_HEADER_ROWS = 4;

async function loadExcelJS() {
  const imported = await import("exceljs");
  return ((imported as ExcelJSModule & { default?: ExcelJSModule }).default ?? imported) as ExcelJSModule;
}

function dayColor(day: DayInfo) {
  if (day.isSunday || day.isHoliday) return "FFFF0000";
  if (day.isSaturday) return "FF0000FF";
  return "FF444444";
}

function addScheduleSheet(
  workbook: import("exceljs").Workbook,
  args: ScheduleWorkbookArgs,
) {
  const sheet = workbook.addWorksheet(`${args.month}월 당직표`, {
    views: [{ state: "frozen", xSplit: 1, ySplit: SCHEDULE_HEADER_ROWS }],
  });
  const lastColumn = args.days.length + 1;
  sheet.mergeCells(1, 1, 1, lastColumn);
  const title = sheet.getCell(1, 1);
  title.value = `${args.year}년 ${args.month}월 응급구조사 당직표`;
  title.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 28;

  sheet.getCell(2, 1).value = "직원";
  sheet.getCell(3, 1).value = "요일";
  sheet.getCell(4, 1).value = "구분";
  for (let row = 2; row <= 4; row += 1) {
    const cell = sheet.getCell(row, 1);
    cell.font = { bold: true, color: { argb: "FF1F1F1F" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF2F8" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }
  sheet.getColumn(1).width = 12;

  args.days.forEach((day, index) => {
    const column = index + 2;
    const cells = [sheet.getCell(2, column), sheet.getCell(3, column), sheet.getCell(4, column)];
    cells[0].value = day.day;
    cells[1].value = WEEKDAYS[day.weekday];
    cells[2].value = day.holidayName ?? (day.isWeekend ? "주말" : "평일");
    cells.forEach((cell) => {
      cell.font = { bold: true, color: { argb: dayColor(day) } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF2F8" } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    sheet.getColumn(column).width = 5;
  });
  sheet.getRow(4).height = 28;

  args.employees.forEach((employee, employeeIndex) => {
    const rowNumber = employeeIndex + SCHEDULE_HEADER_ROWS + 1;
    const nameCell = sheet.getCell(rowNumber, 1);
    nameCell.value = employee;
    nameCell.font = { bold: true };
    nameCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };
    nameCell.alignment = { horizontal: "center", vertical: "middle" };

    args.days.forEach((_, dayIndex) => {
      const shift = args.schedule[dayIndex][employee];
      const cell = sheet.getCell(rowNumber, dayIndex + 2);
      cell.value = shift === "/" ? "O" : shift;
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
  });

  return sheet;
}

function addStatsSheet(
  workbook: import("exceljs").Workbook,
  employees: readonly Employee[],
  stats: EmployeeStats[],
) {
  const sheet = workbook.addWorksheet("개인별 통계", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(["직원", "D", "E/M", "N", "OFF", "토", "일", "공휴일", "주말2오프", "총근무"]);
  const statsByEmployee = new Map(stats.map((item) => [item.employee, item]));
  employees.forEach((employee) => {
    const item = statsByEmployee.get(employee);
    if (!item) return;
    sheet.addRow([
      item.employee,
      item.D,
      item.evening,
      item.N,
      item.off,
      item.saturday,
      item.sunday,
      item.holiday,
      item.weekendTwoOff ? "Y" : "N",
      item.totalWork,
    ]);
  });
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  sheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  sheet.columns.forEach((column) => {
    column.width = 12;
  });
}

export async function buildScheduleWorkbook(args: ScheduleWorkbookArgs) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  addScheduleSheet(workbook, args);
  addStatsSheet(workbook, args.employees, args.stats);
  return workbook;
}

export async function exportScheduleXlsx(args: ScheduleWorkbookArgs) {
  const workbook = await buildScheduleWorkbook(args);
  const bytes = await workbook.xlsx.writeBuffer();
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${args.year}년_${args.month}월_응급구조사_당직표.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
