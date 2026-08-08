import type { AuthEnvironment } from './auth-policy.ts';

export type OutboundEmail = {
	from: string;
	to: string;
	subject: string;
	text: string;
};

export interface EmailSender {
	readonly available: boolean;
	send(message: OutboundEmail): Promise<void>;
}

const noopEmailSender: EmailSender = {
	available: false,
	async send() {
		// Local development deliberately permits a no-op sender.
	},
};

const platformEmailSender = (binding: SendEmail): EmailSender => ({
	available: true,
	async send(message) {
		await binding.send({
			from: message.from,
			to: message.to,
			subject: message.subject,
			text: message.text,
		});
	},
});

export const createEmailSender = (
	env: Pick<Env, 'EMAIL'> & AuthEnvironment,
): EmailSender => {
	if (env.ENVIRONMENT === 'local') return noopEmailSender;
	const binding = (env as Env & { EMAIL?: SendEmail }).EMAIL;
	return binding ? platformEmailSender(binding) : noopEmailSender;
};
