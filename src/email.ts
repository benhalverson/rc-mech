export type OutboundEmail = {
	from: string;
	to: string;
	subject: string;
	text: string;
};

export interface EmailSender {
	send(message: OutboundEmail): Promise<void>;
}

const noopEmailSender: EmailSender = {
	async send() {
		// Email delivery is intentionally deferred to issue #3.
	},
};

const platformEmailSender = (binding: SendEmail): EmailSender => ({
	async send(message) {
		await binding.send(message);
	},
});

export const createEmailSender = (env: Env): EmailSender => {
	const binding = (env as Env & { EMAIL?: SendEmail }).EMAIL;
	return binding ? platformEmailSender(binding) : noopEmailSender;
};
