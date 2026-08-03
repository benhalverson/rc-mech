export type MaintenanceStatus = "active" | "paused" | "archived";
export type MaintenanceIntervalUnit = "days" | "weeks" | "months";

export type DueCalculationInput = {
	status: MaintenanceStatus;
	baselineAt: string;
	baselineSessionCount: number;
	intervalUnit: MaintenanceIntervalUnit;
	intervalValue: number;
	intervalSessions: number | null;
	currentSessionCount: number;
	now: string;
	timezone: string;
};

export type DueCalculation = {
	dueStatus: "upcoming" | "due" | "overdue" | "paused" | "archived";
	isDue: boolean;
	dateDueAt: string | null;
	sessionDueAtCount: number | null;
	sessionsSinceBaseline: number;
	dueReasons: Array<"calendar" | "drive-sessions">;
};

const localParts = (iso: string, timezone: string) => {
	const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric", month: "2-digit", day: "2-digit",
	}).formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
	return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
};

const localDate = (parts: { year: number; month: number; day: number }) =>
	`${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

const localDateTimeToUtc = (parts: { year: number; month: number; day: number }, timezone: string) => {
	const target = Date.UTC(parts.year, parts.month - 1, parts.day);
	let candidate = target;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const actual = localParts(new Date(candidate).toISOString(), timezone);
		candidate += target - Date.UTC(actual.year, actual.month - 1, actual.day);
	}
	return new Date(candidate).toISOString();
};

export const addCalendarInterval = (baselineAt: string, unit: MaintenanceIntervalUnit, value: number, timezone: string): string => {
	const start = localParts(baselineAt, timezone);
	let year = start.year;
	let month = start.month;
	if (unit === "months") {
		const monthIndex = month - 1 + value;
		year += Math.floor(monthIndex / 12);
		month = (monthIndex % 12) + 1;
	}
	const days = unit === "days" ? value : unit === "weeks" ? value * 7 : 0;
	const date = new Date(Date.UTC(year, month - 1, unit === "months" ? Math.min(start.day, new Date(Date.UTC(year, month, 0)).getUTCDate()) : 1));
	if (unit !== "months") date.setUTCDate(start.day + days);
	return localDateTimeToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }, timezone);
};

export const calculateMaintenanceDue = (input: DueCalculationInput): DueCalculation => {
	const sessionsSinceBaseline = Math.max(0, input.currentSessionCount - input.baselineSessionCount);
	if (input.status !== "active") {
		return {
			dueStatus: input.status,
			isDue: false,
			dateDueAt: null,
			sessionDueAtCount: null,
			sessionsSinceBaseline,
			dueReasons: [],
		};
	}
	const dateDueAt = addCalendarInterval(input.baselineAt, input.intervalUnit, input.intervalValue, input.timezone);
	const calendarDue = new Date(input.now).getTime() >= new Date(dateDueAt).getTime();
	const sessionDueAtCount = input.intervalSessions === null ? null : input.baselineSessionCount + input.intervalSessions;
	const sessionsDue = sessionDueAtCount !== null && input.currentSessionCount >= sessionDueAtCount;
	const dueReasons: DueCalculation["dueReasons"] = [];
	if (calendarDue) dueReasons.push("calendar");
	if (sessionsDue) dueReasons.push("drive-sessions");
	const overdue = calendarDue && localDate(localParts(input.now, input.timezone)) > localDate(localParts(dateDueAt, input.timezone));
	return {
		dueStatus: overdue ? "overdue" : dueReasons.length > 0 ? "due" : "upcoming",
		isDue: dueReasons.length > 0,
		dateDueAt,
		sessionDueAtCount,
		sessionsSinceBaseline,
		dueReasons,
	};
};

export const canTransitionMaintenance = (from: MaintenanceStatus, to: MaintenanceStatus): boolean =>
	(from === "active" || from === "paused" || from === "archived") && (to === "active" || to === "paused" || to === "archived");
