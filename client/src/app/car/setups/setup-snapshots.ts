import { DatePipe, DecimalPipe, JsonPipe, KeyValuePipe } from '@angular/common';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	output,
	signal,
} from '@angular/core';
import {
	LucideCheck,
	LucideClipboardList,
	LucideCopy,
	LucideExternalLink,
	LucidePlus,
	LucideRefreshCw,
	LucideTriangleAlert,
} from '@lucide/angular';
import { SetupEditor, type SetupEditorMode } from './setup-editor';
import { setupFieldLabel, setupSectionLabels } from './setup-form';
import { SetupImportPreview } from './setup-import-preview';
import type { ImportedCarIdentity } from './setup-import-review';
import {
	type ImportCarOption,
	type SetupGatewayFailure,
	type SetupSectionValues,
	type SetupSnapshot,
	type SoDialedImportPreview,
	setupSectionKeys,
} from './setup-snapshot';
import {
	SetupSnapshotStore,
	type SetupWorkflowResult,
} from './setup-snapshot-store';

type SetupEditorSession = {
	readonly mode: SetupEditorMode;
	readonly setup: SetupSnapshot | null;
	readonly importPreview: SoDialedImportPreview | null;
	readonly importSourceUrl: string;
};

const isSessionExpired = (error: SetupGatewayFailure): boolean =>
	error.kind === 'http' && error.status === 401;

@Component({
	selector: 'app-setup-snapshots',
	host: { class: 'block' },
	imports: [
		DatePipe,
		DecimalPipe,
		JsonPipe,
		KeyValuePipe,
		LucideCheck,
		LucideClipboardList,
		LucideCopy,
		LucideExternalLink,
		LucidePlus,
		LucideRefreshCw,
		LucideTriangleAlert,
		SetupEditor,
		SetupImportPreview,
	],
	templateUrl: './setup-snapshots.html',
})
export class SetupSnapshots {
	private readonly store = inject(SetupSnapshotStore);
	private handledOperationId = this.store.outcome().operationId ?? 0;
	readonly carId = input('');
	readonly archived = input(false);
	readonly availableCars = input<ImportCarOption[]>([]);
	readonly createCarFromImport = output<ImportedCarIdentity>();
	protected readonly setups = this.store.setups;
	protected readonly selectedId = signal<string | null>(null);
	protected readonly editor = signal<SetupEditorSession | null>(null);
	protected readonly editing = computed(() => this.editor() !== null);
	protected readonly state = computed(() =>
		this.store.loading() ? 'loading' : this.store.failure() ? 'error' : 'ready',
	);
	protected readonly actionError = signal('');
	protected readonly actionMessage = signal('');
	protected readonly readFailure = this.store.failure;
	protected readonly action = this.store.action;
	protected readonly syncMark = this.store.syncMark;
	protected readonly sectionKeys = setupSectionKeys;
	protected readonly sectionLabels = setupSectionLabels;
	protected readonly fieldLabel = setupFieldLabel;
	protected readonly selected = computed(
		() => this.setups().find((setup) => setup.id === this.selectedId()) ?? null,
	);
	protected readonly copySource = computed(
		() =>
			this.setups().find((setup) => setup.current) ?? this.setups()[0] ?? null,
	);

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (previousCarId !== undefined && carId !== previousCarId)
				this.resetRouteState();
			previousCarId = carId;
		});
		effect(() => {
			const carId = this.carId();
			if (carId) this.store.selectCar(carId);
		});
		effect(() => {
			const setups = this.setups();
			if (!setups.some((setup) => setup.id === this.selectedId()))
				this.selectedId.set(
					setups.find((setup) => setup.current)?.id ?? setups[0]?.id ?? null,
				);
		});
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === this.handledOperationId
			)
				return;
			this.handledOperationId = outcome.operationId;
			if (outcome.status === 'failed') {
				if (
					outcome.command.kind === 'copy' ||
					outcome.command.kind === 'select-current'
				)
					this.handleFailure(outcome.command.kind, outcome.error);
				return;
			}
			if (
				outcome.command.kind === 'preview' &&
				outcome.result.kind === 'preview'
			) {
				this.openImport(outcome.result.preview, outcome.command.url);
				return;
			}
			this.handleSuccess(outcome.result);
		});
	}

	private resetRouteState(): void {
		this.selectedId.set(null);
		this.editor.set(null);
		this.store.clearOutcome();
		this.actionError.set('');
		this.actionMessage.set('');
	}

	protected retry(): void {
		this.store.retry();
	}

	protected select(setup: SetupSnapshot): void {
		this.selectedId.set(setup.id);
	}

	protected openAdd(): void {
		if (this.archived()) return;
		this.clearMessages();
		this.editor.set({
			mode: 'add',
			setup: null,
			importPreview: null,
			importSourceUrl: '',
		});
	}

	private openImport(preview: SoDialedImportPreview, sourceUrl: string): void {
		if (this.archived()) return;
		this.clearMessages();
		this.editor.set({
			mode: 'add',
			setup: null,
			importPreview: preview,
			importSourceUrl: sourceUrl,
		});
	}

	protected copyPrevious(): void {
		const source = this.copySource();
		if (source) this.copySetup(source);
	}

	protected openEdit(): void {
		const setup = this.selected();
		if (!setup || this.archived()) return;
		this.clearMessages();
		this.openEditorForSetup(setup);
	}

	protected closeEditor(): void {
		this.editor.set(null);
	}

	protected requestCreateCar(identity: ImportedCarIdentity): void {
		this.createCarFromImport.emit(identity);
	}

	protected copy(): void {
		const setup = this.selected();
		if (setup) this.copySetup(setup);
	}

	private copySetup(setup: SetupSnapshot): void {
		if (this.archived() || this.action()) return;
		const carId = this.carId();
		if (!carId) return;
		this.clearMessages();
		this.store.mutate({ kind: 'copy', carId, setupId: setup.id });
	}

	protected makeCurrent(): void {
		const setup = this.selected();
		if (!setup || setup.current || this.archived() || this.action()) return;
		const carId = this.carId();
		if (!carId) return;
		this.clearMessages();
		this.store.mutate({
			kind: 'select-current',
			carId,
			setupId: setup.id,
		});
	}

	private handleFailure(
		kind: 'copy' | 'select-current',
		error: SetupGatewayFailure,
	): void {
		const expired = isSessionExpired(error);
		this.actionError.set(
			expired
				? 'Your garage session has expired. Sign in again to continue.'
				: kind === 'copy'
					? 'The setup could not be copied.'
					: 'The current setup could not be changed.',
		);
	}

	private handleSuccess(result: SetupWorkflowResult): void {
		if (result.kind === 'save') {
			this.editor.set(null);
			if (result.targetCarId === this.carId()) {
				this.selectedId.set(result.setup.id);
				if (result.retainedLocally)
					this.actionMessage.set('Setup saved on this device. Pending sync.');
			} else
				this.actionMessage.set('Imported setup saved to the selected car.');
			return;
		}
		if (result.kind === 'copy') {
			this.selectedId.set(result.setup.id);
			this.openEditorForSetup(result.setup);
			if (result.retainedLocally)
				this.actionMessage.set(
					'Setup copy saved on this device. Pending sync.',
				);
			return;
		}
		if (result.kind === 'select-current' && result.retainedLocally)
			this.actionMessage.set(
				'Current setup saved on this device. Pending sync.',
			);
	}

	private openEditorForSetup(setup: SetupSnapshot): void {
		this.editor.set({
			mode: 'edit',
			setup,
			importPreview: null,
			importSourceUrl: '',
		});
	}

	private clearMessages(): void {
		this.actionError.set('');
		this.actionMessage.set('');
	}

	protected sectionHasValues(section: SetupSectionValues): boolean {
		return Object.values(section).some((value) => Boolean(value));
	}
}
