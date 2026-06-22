import type { DayInfo, Employee, EmployeeStats, Schedule } from "./types";

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

function findEmployeeRows(worksheet: import("exceljs").Worksheet, employees: readonly Employee[]) {
  const rows = new Map<Employee, number>();
  worksheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      const text = String(cell.value ?? "").trim();
      if (employees.includes(text)) rows.set(text, rowNumber);
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

function dayColor(day: DayInfo) {
  if (day.isSunday || day.isHoliday) return "FFFF0000";
  if (day.isSaturday) return "FF0000FF";
  return "FF666666";
}

function colorDayCells(worksheet: import("exceljs").Worksheet, rowNumbers: number[], column: number, day: DayInfo) {
  rowNumbers.forEach((row) => {
    const cell = worksheet.getCell(row, column);
    cell.font = { ...cell.font, color: { argb: dayColor(day) } };
  });
}

function ensureSheetLayout(
  workbook: import("exceljs").Workbook,
  year: number,
  month: number,
  days: DayInfo[],
  employees: readonly Employee[],
) {
  let worksheet = workbook.worksheets[0] ?? workbook.addWorksheet(`${month}월 당직표`);
  const foundRows = findEmployeeRows(worksheet, employees);
  const foundColumns = findDateColumns(worksheet, days);
  const hasLayout = foundRows.size === employees.length && foundColumns.columns.size === days.length;
  if (hasLayout) {
    worksheet.name = `${month}월 당직표`;
    worksheet.getCell(1, 1).value = `${year}년 ${month}월 응급구조사 당직표`;
    days.forEach((day) => {
      const column = foundColumns.columns.get(day.day);
      if (column) colorDayCells(worksheet, [foundColumns.headerRow, foundColumns.headerRow + 1, foundColumns.headerRow + 2], column, day);
    });
    return { worksheet, employeeRows: foundRows, dateColumns: foundColumns.columns };
  }

  if (workbook.worksheets.includes(worksheet)) workbook.removeWorksheet(worksheet.id);
  worksheet = workbook.addWorksheet(`${month}월 당직표`);
  const sheet = worksheet;
  sheet.getCell(1, 1).value = `${year}년 ${month}월 응급구조사 당직표`;
  sheet.getCell(2, 1).value = "직원";
  sheet.getCell(3, 1).value = "요일";
  sheet.getCell(4, 1).value = "구분";
  days.forEach((day, index) => {
    const column = index + 2;
    sheet.getCell(2, column).value = day.day;
    sheet.getCell(3, column).value = ["일", "월", "화", "수", "목", "금", "토"][day.weekday];
    sheet.getCell(4, column).value = day.holidayName ?? (day.isWeekend ? "주말" : "평일");
    colorDayCells(sheet, [2, 3, 4], column, day);
    sheet.getColumn(column).width = 5;
  });
  sheet.getColumn(1).width = 12;
  const employeeRows = new Map<Employee, number>();
  employees.forEach((employee, index) => {
    const rowNumber = index + 5;
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
  employees: Employee[];
  template?: File | null;
}) {
  const ExcelJS = (await import("exceljs")) as ExcelJSModule;
  const workbook = new ExcelJS.Workbook();

  if (args.template) {
    const buffer = await args.template.arrayBuffer();
    await workbook.xlsx.load(buffer);
  }

  const { worksheet, employeeRows, dateColumns } = ensureSheetLayout(workbook, args.year, args.month, args.days, args.employees);
  args.days.forEach((day, dayIndex) => {
    const col = dateColumns.get(day.day);
    if (!col) return;
    args.employees.forEach((employee) => {
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
