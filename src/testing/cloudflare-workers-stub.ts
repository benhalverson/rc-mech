export class DurableObject<Env = unknown> {
	protected ctx: DurableObjectState;
	protected env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}

export class WorkflowEntrypoint<Env = unknown, Payload = unknown> {
	protected ctx: ExecutionContext;
	protected env: Env;

	constructor(ctx: ExecutionContext, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}

	run(
		_event: Readonly<{ payload: Payload }>,
		_step: unknown,
	): Promise<unknown> {
		throw new Error('WorkflowEntrypoint.run must be implemented');
	}
}
