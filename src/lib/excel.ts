import { EMPLOYEES, type DayInfo, type Employee, type EmployeeStats, type Schedule } from "./types";

type ExcelJSModule = typeof import("exceljs");

function cellDay(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 31) return value;
  if (value instanceof Date) return value.getDate();
  if (typeof value === "string") {
    const match = value.match(/^(\d{1,2})(일)?$/);
    if (match) return Number(match[1]);
  }
  return null;
}

function findEmployeeRows(worksheet: import("exceljs").Worksheet) {
  const rows = new Map<Employee, number>();
  worksheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      const text = String(cell.value ?? "").trim();
      if (EMPLOYEES.includes(text as Employee)) rows.set(text as Employee, rowNumber);
    });
  });
  return rows;
}

function findDateColumns(worksheet: import("exceljs").Worksheet, days: DayInfo[]) {
  let bestRow = 1;
  let bestMatches = new Map<number, number>();
  worksheet.eachRow((row, rowNumber) => {
    const matches = new Map<number, number>();
    row.eachCell((cell, colNumber) => {
      const day = cellDay(cell.value);
      if (day && day <= days.length) matches.set(day, colNumber);
    });
    if (matches.size > bestMatches.size) {
      bestMatches = matches;
      bestRow = rowNumber;
    }
  });
  return { headerRow: bestRow, columns: bestMatches };
}

function ensureSheetLayout(workbook: import("exceljs").Workbook, days: DayInfo[]) {
  const worksheet = workbook.worksheets[0] ?? workbook.addWorksheet("당직표");
  const foundRows = findEmployeeRows(worksheet);
  const foundColumns = findDateColumns(worksheet, days);
  const hasLayout = foundRows.size === EMPLOYEES.length && foundColumns.columns.size >= Math.min(days.length, 20);
  if (hasLayout) {
    return { worksheet, employeeRows: foundRows, dateColumns: foundColumns.columns };
  }

  const sheet = workbook.addWorksheet("생성 당직표");
  sheet.getCell(1, 1).value = "응급구조사 당직표";
  sheet.getCell(2, 1).value = "직원";
  days.forEach((day, index) => {
    sheet.getCell(2, index + 2).value = day.day;
    sheet.getCell(3, index + 2).value = ["일", "월", "화", "수", "목", "금", "토"][day.weekday];
    sheet.getColumn(index + 2).width = 5;
  });
  sheet.getColumn(1).width = 12;
  const employeeRows = new Map<Employee, number>();
  EMPLOYEES.forEach((employee, index) => {
    const rowNumber = index + 4;
    employeeRows.set(employee, rowNumber);
    sheet.getCell(rowNumber, 1).value = employee;
  });
  const dateColumns = new Map(days.map((day, index) => [day.day, index + 2]));
  return { worksheet: sheet, employeeRows, dateColumns };
}

function addStatsSheet(workbook: import("exceljs").Workbook, stats: EmployeeStats[]) {
  const oldSheet = workbook.getWorksheet("개인별 통계");
  if (oldSheet) workbook.removeWorksheet(oldSheet.id);
  const sheet = workbook.addWorksheet("개인별 통계");
  sheet.addRow(["직원", "D", "E/M", "N", "OFF", "토", "일", "공휴일", "주말2오프", "총근무"]);
  stats.forEach((item) => {
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
  sheet.columns.forEach((column) => {
    column.width = 12;
  });
}

export async function exportScheduleXlsx(args: {
  year: number;
  month: number;
  days: DayInfo[];
  schedule: Schedule;
  stats: EmployeeStats[];
  template?: File | null;
}) {
  const ExcelJS = (await import("exceljs")) as ExcelJSModule;
  const workbook = new ExcelJS.Workbook();

  if (args.template) {
    const buffer = await args.template.arrayBuffer();
    await workbook.xlsx.load(buffer);
  }

  const { worksheet, employeeRows, dateColumns } = ensureSheetLayout(workbook, args.days);
  args.days.forEach((day, dayIndex) => {
    const col = dateColumns.get(day.day);
    if (!col) return;
    EMPLOYEES.forEach((employee) => {
      const row = employeeRows.get(employee);
      if (!row) return;
      worksheet.getCell(row, col).value = args.schedule[dayIndex][employee];
    });
  });

  addStatsSheet(workbook, args.stats);
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
