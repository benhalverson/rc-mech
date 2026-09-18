import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReidentifySubjectCommand } from './reidentification.models';
import { ReidentificationGateway } from './reidentification-gateway';
import { ReidentificationIdentity } from './reidentification-identity';

const command: ReidentifySubjectCommand = {
	analysisId: 'analysis/one',
	context: {
		runId: 'run',
		segmentId: 'segment',
		acceptedDigest: 'digest',
		gap: { startTimestampMs: 100, reason: 'missing' },
	},
	subjectSeed: {
		timestampMs: 200,
		frameIndex: 2,
		identity: 'car',
		box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
	},
};

afterEach(() => TestBed.resetTestingModule());

describe('ReidentificationGateway', () => {
	it('reads owner-authenticated gap context and sends a stable correction identity', async () => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				ReidentificationGateway,
			],
		});
		const gateway = TestBed.inject(ReidentificationGateway);
		const http = TestBed.inject(HttpTestingController);
		TestBed.tick();
		http.expectNone('/api/v1/driving-analyses//reidentification');
		gateway.select(command.analysisId);
		TestBed.tick();
		const read = http.expectOne(
			'/api/v1/driving-analyses/analysis%2Fone/reidentification',
		);
		expect(read.request.withCredentials).toBe(true);
		read.flush({ context: command.context });
		await Promise.resolve();
		TestBed.tick();
		expect(gateway.context.value()).toEqual(command.context);
		gateway.select(command.analysisId);
		TestBed.tick();
		http
			.expectOne('/api/v1/driving-analyses/analysis%2Fone/reidentification')
			.flush({ context: null });
		await Promise.resolve();
		TestBed.tick();
		expect(gateway.context.value()).toBeNull();
		const result = firstValueFrom(gateway.correct(command, 'correction'));
		const write = http.expectOne(
			'/api/v1/driving-analyses/analysis%2Fone/reidentification',
		);
		expect(write.request.withCredentials).toBe(true);
		expect(write.request.body).toEqual({
			runId: 'run',
			segmentId: 'segment',
			acceptedDigest: 'digest',
			correctionId: 'correction',
			subjectSeed: command.subjectSeed,
		});
		write.flush({
			correctionId: 'correction',
			runId: 'run',
			segmentId: 'new-segment',
		});
		await expect(result).resolves.toEqual({
			correctionId: 'correction',
			runId: 'run',
			segmentId: 'new-segment',
		});
		const invalid = firstValueFrom(gateway.correct(command, 'correction'));
		const rejection = expect(invalid).rejects.toThrow();
		http
			.expectOne('/api/v1/driving-analyses/analysis%2Fone/reidentification')
			.flush({ privateHost: 'invalid' });
		await rejection;
		http.verify();
	});
	it('reuses an unchanged correction ID and gives changed seeds a distinct identity', () => {
		TestBed.configureTestingModule({ providers: [ReidentificationIdentity] });
		const identities = TestBed.inject(ReidentificationIdentity);
		const id = identities.forCommand(command);
		expect(identities.forCommand(structuredClone(command))).toBe(id);
		expect(
			identities.forCommand({
				...command,
				subjectSeed: { ...command.subjectSeed, timestampMs: 300 },
			}),
		).not.toBe(id);
	});
});
