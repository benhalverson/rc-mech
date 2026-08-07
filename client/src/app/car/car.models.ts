export type InstalledComponent = {
	id: string;
	carId: string;
	slot: string;
	slotType?: 'standard' | 'custom' | null;
	name: string;
	manufacturer?: string | null;
	model?: string | null;
	serialNumber?: string | null;
	notes?: string | null;
	installedAt?: string;
	removedAt?: string | null;
};

export type DriveSession = {
	id: string;
	carId: string;
	startedAt: string;
	durationMinutes?: number | null;
	conditions?: string | null;
	notes?: string | null;
	deletedAt?: string | null;
};

export type CarPhoto = {
	id: string;
	carId: string;
	objectKey?: string;
	contentType: string;
	createdAt: string;
	sortOrder?: number;
	position?: number;
	isPrimary?: boolean;
	primary?: boolean;
	url?: string;
};
