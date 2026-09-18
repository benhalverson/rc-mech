import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	CorrectionReceipt,
	ReidentificationContext,
	ReidentifySubjectCommand,
} from './reidentification.models';
import { ReidentificationGateway } from './reidentification-gateway';
import { ReidentificationIdentity } from './reidentification-identity';
import { ReidentificationStore } from './reidentification-store';

const context: ReidentificationContext = {
	runId: 'run',
	segmentId: 'segment',
	acceptedDigest: 'digest',
	gap: { startTimestampMs: 100, reason: 'missing' },
};
const command: ReidentifySubjectCommand = {
	analysisId: 'analysis',
	context,
	subjectSeed: {
		timestampMs: 200,
		frameIndex: 2,
		identity: 'car',
		box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
	},
};
const receipt: CorrectionReceipt = {
	correctionId: 'correction',
	runId: 'run',
	segmentId: 'next',
};
const setup = () => {
	const value = signal<ReidentificationContext | null>(context);
	const hasValue = signal(true);
	const loading = signal(false);
	const error = signal<unknown>(null);
	const gateway = {
		context: { value, hasValue, isLoading: loading, error },
		select: vi.fn(),
		correct: vi.fn(() => of(receipt)),
	};
	TestBed.configureTestingModule({
		providers: [
			ReidentificationStore,
			{ provide: ReidentificationGateway, useValue: gateway },
			{
				provide: ReidentificationIdentity,
				useValue: { forCommand: () => 'correction' },
			},
		],
	});
	return {
		store: TestBed.inject(ReidentificationStore),
		gateway,
		value,
		hasValue,
		loading,
		error,
	};
};
afterEach(() => TestBed.resetTestingModule());

describe('ReidentificationStore', () => {
	it('uses the persisted correction identity after remount', () => {
		const f = setup();
		const saved = {
			...context,
			pendingCorrection: {
				correctionId: 'saved',
				subjectSeed: command.subjectSeed,
			},
		};
		f.value.set(saved);
		f.store.select('analysis');
		f.store.correct({ ...command, context: saved });
		expect(f.gateway.correct).toHaveBeenCalledWith(
			{ ...command, context: saved },
			'saved',
		);
	});
	it('projects remote state, rejects mismatched commands, and publishes typed correction outcomes', () => {
		const f = setup();
		expect(f.store.context()).toEqual(context);
		expect(f.store.loading()).toBe(false);
		expect(f.store.readFailed()).toBe(false);
		f.hasValue.set(false);
		expect(f.store.context()).toBeNull();
		f.loading.set(true);
		f.error.set(new Error('unavailable'));
		expect(f.store.loading()).toBe(true);
		expect(f.store.readFailed()).toBe(true);
		f.store.correct(command);
		expect(f.gateway.correct).not.toHaveBeenCalled();
		f.store.select('analysis');
		f.store.select('analysis');
		expect(f.gateway.select).toHaveBeenCalledOnce();
		f.store.correct(command);
		expect(f.gateway.correct).not.toHaveBeenCalled();
		f.hasValue.set(true);
		f.store.correct({
			...command,
			context: { ...context, segmentId: 'stale' },
		});
		expect(f.gateway.correct).not.toHaveBeenCalled();
		f.store.correct(command);
		expect(f.store.outcome()).toEqual({
			status: 'succeeded',
			correctionId: 'correction',
			receipt,
		});
		f.gateway.correct.mockReturnValueOnce(
			throwError(() => new Error('unavailable')),
		);
		f.store.correct(command);
		expect(f.store.outcome()).toEqual({
			status: 'failed',
			correctionId: 'correction',
			receipt: null,
		});
	});
	it.each([
		['success', 'other'],
		['failure', 'other'],
		['success', 'analysis'],
		['failure', 'analysis'],
	])(
		'ignores duplicate in-flight commands and stale %s after selecting %s',
		(outcome, analysisId) => {
			const f = setup();
			const response = new Subject<CorrectionReceipt>();
			f.gateway.correct.mockReturnValue(response);
			f.store.select('analysis');
			f.store.correct(command);
			f.store.correct(command);
			expect(f.gateway.correct).toHaveBeenCalledOnce();
			expect(f.store.outcome().status).toBe('pending');
			f.store.select(analysisId, 1);
			if (outcome === 'success') {
				response.next(receipt);
				response.complete();
			} else response.error(new Error('unavailable'));
			expect(f.store.outcome().status).toBe('idle');
		},
	);
});
