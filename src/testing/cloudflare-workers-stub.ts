export class DurableObject<Env = unknown> {
	protected ctx: DurableObjectState;
	protected env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}

	protected sql(
		_strings: TemplateStringsArray,
		..._values: unknown[]
	): readonly Record<string, unknown>[] {
		return [];
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

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
	protected ctx: ExecutionContext;
	protected env: Env;
	protected props: Props;

	constructor(ctx: ExecutionContext, env: Env) {
		this.ctx = ctx;
		this.env = env;
		this.props = {} as Props;
	}
}
