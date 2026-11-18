/**
 * Outbound mail.
 *
 * The original app only ever delivers email — WhatsApp and SMS are labelled
 * "Recorded only" (spec §7.3 #3). The rebuild keeps that honesty: there is one
 * email transport and a second channel would need its own adapter and its own
 * "not delivered" state, not a pretend send.
 *
 * `capture` is the test/dev transport: messages are held in memory and can be
 * read back, so an OTP can be asserted end to end without a mail server.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  sentAt: Date;
}

export interface MailTransport {
  readonly kind: string;
  send(message: Omit<MailMessage, 'sentAt'>): Promise<void>;
}

export function createCaptureTransport(): MailTransport & { outbox: MailMessage[]; clear(): void } {
  const outbox: MailMessage[] = [];
  return {
    kind: 'capture',
    outbox,
    clear() {
      outbox.length = 0;
    },
    async send(message) {
      outbox.push({ ...message, sentAt: new Date() });
    },
  };
}

/** Dev transport: writes to the console instead of pretending to deliver. */
export function createConsoleTransport(): MailTransport {
  return {
    kind: 'console',
    async send(message) {
      console.log(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`);
    },
  };
}

/** HTTPS transport for hosts that block SMTP (Render free blocks 25/465/587). */
export function createHttpTransport(): MailTransport {
  const url = process.env.MAIL_API_URL ?? 'https://api.resend.com/emails';
  const key = process.env.MAIL_API_KEY ?? '';
  const from = process.env.MAIL_FROM ?? 'HostSync <onboarding@resend.dev>';
  return {
    kind: 'http',
    async send(message) {
      if (!key) throw new Error('MAIL_API_KEY is required when MAIL_TRANSPORT=http');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        throw new Error(`mail API rejected the message: ${response.status} ${await response.text()}`);
      }
    },
  };
}

export const captureTransport = createCaptureTransport();

export const defaultTransport: MailTransport =
  process.env.MAIL_TRANSPORT === 'http'
    ? createHttpTransport()
    : process.env.MAIL_TRANSPORT === 'console'
      ? createConsoleTransport()
      : captureTransport;
