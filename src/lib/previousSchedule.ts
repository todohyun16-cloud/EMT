import type { Employee } from "./types";

type ExcelJSModule = typeof import("exceljs");
type NormalizedPreviousShift = "D" | "E" | "N" | "OFF";

export type PreviousScheduleImportResult = {
  schedules: Partial<Record<Employee, (NormalizedPreviousShift | null)[]>>;
  matchedEmployees: Employee[];
  unmatchedEmployees: Employee[];
};

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

function normalizeName(value: unknown) {
  return cellValueText(value).normalize("NFKC").trim();
}

function normalizeHeader(value: unknown) {
  return normalizeName(value).replace(/\s+/g, "");
}

export function normalizePreviousMonthShift(value: unknown): NormalizedPreviousShift | null {
  const text = cellValueText(value).normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (text === "") return null;
  if (text.startsWith("D")) return "D";
  if (text.startsWith("E")) return "E";
  if (text.startsWith("N")) return "N";
  if (text === "OFF" || text === "Y1" || text === "X1" || text === "XH") return "OFF";
  return "OFF";
}

function dayHeader(value: unknown, previousMonthLength: number): number | null {
  const resolved = isRecord(value) && "result" in value ? value.result : value;
  if (typeof resolved === "number" && Number.isInteger(resolved)) {
    return resolved >= 1 && resolved <= previousMonthLength ? resolved : null;
  }
  const text = cellValueText(resolved).normalize("NFKC").trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const day = Number(text);
  return day >= 1 && day <= previousMonthLength ? day : null;
}

function findNameHeader(worksheet: import("exceljs").Worksheet) {
  const matchesByMaster = new Map<string, { row: number; column: number }>();
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      if (normalizeHeader(cell.value) === "성명") {
        const master = cell.isMerged ? cell.master : cell;
        matchesByMaster.set(master.address, { row: master.fullAddress.row, column: master.fullAddress.col });
      }
    });
  });
  const matches = [...matchesByMaster.values()];
  if (matches.length === 0) throw new Error('Previous schedule workbook is missing the employee-name header "성명".');
  if (matches.length > 1) throw new Error('Previous schedule workbook has duplicate employee-name header rows "성명".');
  return matches[0];
}

function findDateColumns(worksheet: import("exceljs").Worksheet, previousMonthLength: number, preferredRow: number) {
  const candidates: { row: number; columns: Map<number, number>; duplicates: number[] }[] = [];
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const columns = new Map<number, number>();
    const sources = new Map<number, string>();
    const duplicates: number[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      const day = dayHeader(cell.value, previousMonthLength);
      if (day === null) return;
      const master = cell.isMerged ? cell.master : cell;
      if (columns.has(day)) {
        if (sources.get(day) !== master.address) duplicates.push(day);
      } else {
        columns.set(day, master.fullAddress.col ?? column);
        sources.set(day, master.address);
      }
    });
    candidates.push({ row: rowNumber, columns, duplicates });
  });
  candidates.sort(
    (a, b) =>
      b.columns.size - a.columns.size ||
      Math.abs(a.row - preferredRow) - Math.abs(b.row - preferredRow) ||
      a.row - b.row,
  );
  const selected = candidates[0];
  if (!selected || selected.columns.size === 0) throw new Error("Previous schedule workbook has no day-number header row.");
  if (selected.duplicates.length > 0) {
    throw new Error(`Previous schedule workbook has duplicate day headers: ${[...new Set(selected.duplicates)].join(", ")}.`);
  }
  const missing = Array.from({ length: previousMonthLength }, (_, index) => index + 1).filter(
    (day) => !selected.columns.has(day),
  );
  if (missing.length > 0) throw new Error(`Previous schedule workbook is missing day headers: ${missing.join(", ")}.`);
  return selected.columns;
}

export function parsePreviousScheduleWorksheet(
  worksheet: import("exceljs").Worksheet,
  previousMonthLength: number,
  employees: readonly Employee[],
): PreviousScheduleImportResult {
  const nameHeader = findNameHeader(worksheet);
  const dateColumns = findDateColumns(worksheet, previousMonthLength, nameHeader.row);
  const normalizedActive = employees.map((employee) => employee.normalize("NFKC").trim());
  const activeByName = new Map(normalizedActive.map((employee, index) => [employee, employees[index].trim()]));
  const rows = new Map<Employee, number>();

  for (let rowNumber = nameHeader.row + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const nameCell = worksheet.getCell(rowNumber, nameHeader.column);
    if (nameCell.isMerged && nameCell.master.fullAddress.row !== rowNumber) continue;
    const normalized = normalizeName(nameCell.value);
    const employee = activeByName.get(normalized);
    if (!employee) continue;
    if (rows.has(employee)) throw new Error(`Previous schedule workbook has duplicate employee rows for ${employee}.`);
    rows.set(employee, rowNumber);
  }

  const schedules: PreviousScheduleImportResult["schedules"] = {};
  employees.forEach((rawEmployee) => {
    const employee = rawEmployee.trim();
    const row = rows.get(employee);
    if (!row) return;
    schedules[employee] = Array.from({ length: previousMonthLength }, (_, index) => {
      const column = dateColumns.get(index + 1)!;
      return normalizePreviousMonthShift(worksheet.getCell(row, column).value);
    });
  });

  const matchedEmployees = employees.map((employee) => employee.trim()).filter((employee) => rows.has(employee));
  const unmatchedEmployees = employees.map((employee) => employee.trim()).filter((employee) => !rows.has(employee));
  return { schedules, matchedEmployees, unmatchedEmployees };
}

export async function parsePreviousScheduleXlsx(
  file: Blob,
  previousMonthLength: number,
  employees: readonly Employee[],
): Promise<PreviousScheduleImportResult> {
  const imported = await import("exceljs");
  const ExcelJS = ((imported as ExcelJSModule & { default?: ExcelJSModule }).default ?? imported) as ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  const buffer = await file.arrayBuffer();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Previous schedule workbook has no worksheets.");
  return parsePreviousScheduleWorksheet(worksheet, previousMonthLength, employees);
}
