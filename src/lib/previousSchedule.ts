import type { Employee } from "./types";

type ExcelJSModule = typeof import("exceljs");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cellValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return String(value.getDate());
  if (!isRecord(value)) return "";

  if ("result" in value) return cellValueText(value.result);
  if ("text" in value) return cellValueText(value.text);
  if ("richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => (isRecord(part) ? cellValueText(part.text) : "")).join("");
  }

  return "";
}

function cellDay(value: unknown, previousMonthLength: number): number | null {
  if (value instanceof Date) {
    const day = value.getDate();
    return day >= 1 && day <= previousMonthLength ? day : null;
  }

  if (isRecord(value) && "result" in value) return cellDay(value.result, previousMonthLength);

  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= previousMonthLength) return value;

  const text = cellValueText(value).normalize("NFKC").trim();
  const match = text.match(/^(\d{1,2})(?:\D*)$/);
  if (!match) return null;

  const day = Number(match[1]);
  return Number.isInteger(day) && day >= 1 && day <= previousMonthLength ? day : null;
}

function normalizeShift(value: unknown): string | null {
  const text = cellValueText(value).normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (text === "") return null;
  if (text === "/" || text === "OFF") return "OFF";
  if (text === "E1" || text === "E竊?" || text === "E竊") return "M";
  if (text === "D" || text === "E" || text === "M" || text === "N") return text;
  return null;
}

function findEmployeeRows(worksheet: import("exceljs").Worksheet, employees: readonly Employee[]) {
  const rows = new Map<Employee, number>();

  worksheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      const text = cellValueText(cell.value).normalize("NFKC").trim();
      if (employees.includes(text)) rows.set(text, rowNumber);
    });
  });

  return rows;
}

function findDateColumns(worksheet: import("exceljs").Worksheet, previousMonthLength: number) {
  let bestMatches = new Map<number, number>();

  worksheet.eachRow((row) => {
    const matches = new Map<number, number>();

    row.eachCell((cell, colNumber) => {
      const day = cellDay(cell.value, previousMonthLength);
      if (day && !matches.has(day)) matches.set(day, colNumber);
    });

    if (matches.size > bestMatches.size) bestMatches = matches;
  });

  return bestMatches;
}

export async function parsePreviousScheduleXlsx(
  file: File,
  previousMonthLength: number,
  employees: readonly Employee[],
): Promise<Partial<Record<Employee, (string | null)[]>>> {
  const ExcelJS = (await import("exceljs")) as ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  const buffer = await file.arrayBuffer();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Previous schedule workbook has no worksheets.");

  const activeEmployees = employees.map((employee) => employee.trim());
  const employeeRows = findEmployeeRows(worksheet, activeEmployees);
  const dateColumns = findDateColumns(worksheet, previousMonthLength);

  const missingDays = Array.from({ length: previousMonthLength }, (_, index) => index + 1).filter((day) => !dateColumns.has(day));
  if (missingDays.length > 0) throw new Error(`Previous schedule workbook is missing day columns: ${missingDays.join(", ")}`);

  const schedules: Partial<Record<Employee, (string | null)[]>> = {};

  activeEmployees.forEach((employee) => {
    const row = employeeRows.get(employee);
    if (!row) return;

    schedules[employee] = Array.from({ length: previousMonthLength }, (_, index) => {
      const column = dateColumns.get(index + 1)!;
      return normalizeShift(worksheet.getCell(row, column).value);
    });
  });

  return schedules;
}
