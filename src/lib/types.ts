export const EMPLOYEES = ["정채현", "조한승", "이우석", "신민아", "박대성"] as const;

export type Employee = (typeof EMPLOYEES)[number];
export type ShiftCode = "D" | "E" | "M" | "N" | "/";
export type WorkShift = Exclude<ShiftCode, "/">;

export type EmployeeInput = {
  wantedOff: string;
  vacation: string;
  requests: string;
};

export type ParsedEmployeeInput = {
  wantedOff: Set<number>;
  vacation: Set<number>;
  fixedOff: Set<number>;
  requests: Map<number, WorkShift>;
  minOff: number;
  targetOff: number;
};

export type DayInfo = {
  day: number;
  date: Date;
  weekday: number;
  isSaturday: boolean;
  isSunday: boolean;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  isRestDay: boolean;
};

export type ScheduleRow = Record<Employee, ShiftCode>;
export type Schedule = ScheduleRow[];

export type EmployeeStats = {
  employee: Employee;
  D: number;
  evening: number;
  N: number;
  off: number;
  saturday: number;
  sunday: number;
  holiday: number;
  weekendTwoOff: boolean;
  totalWork: number;
};

export type BalanceStats = {
  dRange: number;
  eveningRange: number;
};

export type ScheduleResult =
  | {
      ok: true;
      schedule: Schedule;
      days: DayInfo[];
      stats: EmployeeStats[];
      balance: BalanceStats;
      removedM: number[];
      warnings: string[];
      score: number;
    }
  | {
      ok: false;
      days: DayInfo[];
      failures: string[];
    };
