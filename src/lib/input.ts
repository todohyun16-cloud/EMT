import type { EmployeeInput, ParsedEmployeeInput, WorkShift } from "./types";

const WORK_CODES = new Set(["D", "E", "M", "N"]);
const OFF_CODES = new Set(["OFF", "/"]);

export function parseDays(value: string, maxDay: number): Set<number> {
  const days = new Set<number>();
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const day = Number(item);
      if (Number.isInteger(day) && day >= 1 && day <= maxDay) {
        days.add(day);
      }
    });
  return days;
}

export type ParsedRequests = {
  requests: Map<number, WorkShift>;
  requestedOff: Set<number>;
  failures: string[];
};

export function parseRequestsStrict(value: string, maxDay: number): ParsedRequests {
  const requests = new Map<number, WorkShift>();
  const requestedOff = new Set<number>();
  const failures: string[] = [];
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const parts = item.split(":");
      if (parts.length !== 2) {
        failures.push(`Invalid requested shift "${item}": use day:shift.`);
        return;
      }
      const dayText = parts[0].trim();
      const codeText = parts[1].normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
      const day = Number(dayText);
      if (!Number.isInteger(day) || day < 1 || day > maxDay) {
        failures.push(`Invalid requested shift day "${dayText}": expected 1-${maxDay}.`);
      } else if (WORK_CODES.has(codeText)) {
        requests.set(day, codeText as WorkShift);
        requestedOff.delete(day);
      } else if (OFF_CODES.has(codeText)) {
        requests.delete(day);
        requestedOff.add(day);
      } else {
        failures.push(`Invalid requested shift code "${parts[1].trim()}": use D, E, M, N, OFF, or / only.`);
      }
    });
  return { requests, requestedOff, failures };
}

export function parseRequests(value: string, maxDay: number): Map<number, WorkShift> {
  return parseRequestsStrict(value, maxDay).requests;
}

export function parseEmployeeInput(input: EmployeeInput, maxDay: number): ParsedEmployeeInput {
  const wantedOff = parseDays(input.wantedOff, maxDay);
  const vacation = parseDays(input.vacation, maxDay);
  const educationDays = parseDays(input.educationDays ?? "", maxDay);
  const parsedRequests = parseRequestsStrict(input.requests, maxDay);
  const fixedOff = new Set([...wantedOff, ...vacation, ...educationDays, ...parsedRequests.requestedOff]);
  const minOff = 8 + vacation.size + educationDays.size;

  return {
    wantedOff,
    vacation,
    educationDays,
    fixedOff,
    requests: parsedRequests.requests,
    requestFailures: parsedRequests.failures,
    minOff,
    targetOff: minOff,
  };
}

export function normalizeEmployeeInput(value: Partial<EmployeeInput> | null | undefined): EmployeeInput {
  return {
    wantedOff: typeof value?.wantedOff === "string" ? value.wantedOff : "",
    vacation: typeof value?.vacation === "string" ? value.vacation : "",
    educationDays: typeof value?.educationDays === "string" ? value.educationDays : "",
    requests: typeof value?.requests === "string" ? value.requests : "",
    ...(Array.isArray(value?.previousMonthSchedule) ? { previousMonthSchedule: value.previousMonthSchedule } : {}),
  };
}

export function serializeEmployeeInputs(inputs: readonly EmployeeInput[]) {
  return JSON.stringify(inputs.map((input) => normalizeEmployeeInput(input)));
}

export function deserializeEmployeeInputs(json: string): EmployeeInput[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("Saved employee inputs must be an array.");
  return parsed.map((input) => normalizeEmployeeInput(typeof input === "object" && input !== null ? input as Partial<EmployeeInput> : null));
}

export type SavedRosterInputState = {
  employeeNames: string[];
  inputs: EmployeeInput[];
};

export function serializeRosterInputState(employeeNames: readonly string[], inputs: readonly EmployeeInput[]) {
  return JSON.stringify({
    employeeNames: [...employeeNames],
    inputs: inputs.map((input) => normalizeEmployeeInput(input)),
  });
}

export function deserializeRosterInputState(json: string, defaultEmployeeNames: readonly string[]): SavedRosterInputState {
  const parsed: unknown = JSON.parse(json);
  if (Array.isArray(parsed)) {
    const inputs = parsed.map((input) =>
      normalizeEmployeeInput(typeof input === "object" && input !== null ? input as Partial<EmployeeInput> : null)
    );
    return {
      employeeNames: [...defaultEmployeeNames],
      inputs: defaultEmployeeNames.map((_, index) => normalizeEmployeeInput(inputs[index])),
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).employeeNames) ||
    !Array.isArray((parsed as Record<string, unknown>).inputs)
  ) {
    throw new Error("Saved roster inputs have an invalid format.");
  }
  const employeeNames = (parsed as { employeeNames: unknown[] }).employeeNames.map((name) =>
    typeof name === "string" ? name : String(name ?? "")
  );
  const savedInputs = (parsed as { inputs: unknown[] }).inputs;
  return {
    employeeNames,
    inputs: employeeNames.map((_, index) =>
      normalizeEmployeeInput(
        typeof savedInputs[index] === "object" && savedInputs[index] !== null
          ? savedInputs[index] as Partial<EmployeeInput>
          : null,
      )
    ),
  };
}
