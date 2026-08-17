export type Point = { x: number; y: number };
export type Gate = {
	start: Point;
	end: Point;
	direction: 'forward' | 'reverse';
};
export type CornerView = {
	x: number;
	y: number;
	width: number;
	height: number;
};
export type TrackCorner = {
	key: string;
	name: string;
	order: number;
	entryGate: Gate;
	exitGate: Gate;
	cornerView: CornerView;
};
export type TrackMapVersion = {
	id: string;
	layoutId: string;
	version: number;
	status: 'draft' | 'approved' | 'retired';
	sourceVersionId: string | null;
	createdAt: string;
	updatedAt: string;
	approvedAt: string | null;
	retiredAt: string | null;
	corners: TrackCorner[];
};
export type TrackLayout = {
	id: string;
	name: string;
	status: 'active' | 'retired';
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	retiredAt: string | null;
	mapVersions: Array<{
		id: string;
		version: number;
		status: TrackMapVersion['status'];
		updatedAt: string;
	}>;
};
export type TrackLayoutCollection = {
	readonly canManage: boolean;
	readonly trackLayouts: TrackLayout[];
};
export type CreateTrackLayoutCommand = { readonly name: string };
export type RenameTrackLayoutCommand = { readonly name: string };
export type CreateTrackMapDraftCommand = {
	readonly layoutId: string;
	readonly sourceVersionId?: string;
};
export type SaveTrackMapDraftCommand = {
	readonly corners: readonly TrackCorner[];
};
