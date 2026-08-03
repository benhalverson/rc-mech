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

export type EmailMessageFactory = (from: string, to: string, raw: string) => EmailMessage | Promise<EmailMessage>;

const cloudflareEmailMessage: EmailMessageFactory = async (from, to, raw) => {
	const { EmailMessage } = await import("cloudflare:email");
	return new EmailMessage(from, to, raw);
};

const platformEmailSender = (binding: SendEmail, createMessage: EmailMessageFactory): EmailSender => ({
	available: true,
	async send(message) {
		const raw = [
			`From: ${message.from}`,
			`To: ${message.to}`,
			`Subject: ${message.subject}`,
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: 8bit",
			"",
			message.text,
		].join("\r\n");
		await binding.send(await createMessage(message.from, message.to, raw));
	},
});

export const createEmailSender = (env: Env & AuthEnvironment, createMessage: EmailMessageFactory = cloudflareEmailMessage): EmailSender => {
	if (isLocalDevelopment(env)) return noopEmailSender;
	const binding = (env as Env & { EMAIL?: SendEmail }).EMAIL;
	return binding ? platformEmailSender(binding, createMessage) : noopEmailSender;
};
import { isLocalDevelopment, type AuthEnvironment } from "./auth-policy.ts";
