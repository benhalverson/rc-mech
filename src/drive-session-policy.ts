export type DriveSessionLifecycle = { deletedAt: string | null };

export const isIanaTimezone = (timezone: string): boolean => {
	if (timezone !== "UTC" && !timezone.includes("/")) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
		return true;
	} catch {
		return false;
	}
};

export const canEditDriveSession = (value: DriveSessionLifecycle): boolean => value.deletedAt === null;
export const canDeleteDriveSession = (value: DriveSessionLifecycle): boolean => value.deletedAt === null;

export type PresentedDateTime = { localDate: string; localTime: string; timezone: string };

export const presentDateTime = (iso: string, timezone: string): PresentedDateTime => {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(iso));
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
	return {
		localDate: `${values.year}-${values.month}-${values.day}`,
		localTime: `${values.hour}:${values.minute}:${values.second}`,
		timezone,
	};
};
