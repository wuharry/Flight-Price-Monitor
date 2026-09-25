import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { createHash } from 'node:crypto';

export type GmailTransport = { sendMail(message: SendMailOptions): Promise<{ accepted: unknown[]; rejected: unknown[] }>; close(): void };
export type GmailFactory = (options: SMTPTransport.Options) => GmailTransport;
export async function sendGmail(user: string, password: string, to: string,
  message: { subject: string; text: string; html: string }, id: string,
  factory: GmailFactory = options => nodemailer.createTransport(options)) {
  const transport = factory({ host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass: password.replace(/\s/g, '') },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  try {
    const result = await transport.sendMail({ from: { name: 'Flight Monitor', address: user }, to: [to], ...message,
      messageId: `<flight-alert-${createHash('sha256').update(id).digest('hex')}@${user.split('@')[1]}>` });
    if (!result.accepted.length || result.rejected.length) throw new Error('Recipient rejected');
  } catch (error) {
    // Do not surface raw SMTP responses or authentication values in shared logs.
    const code = (error as { code?: string }).code;
    const reason = code === 'EAUTH' ? 'authentication failed; check Google app password' : code === 'ETIMEDOUT' ? 'connection timed out' : 'message was not confirmed as accepted';
    throw new Error('Gmail SMTP: ' + reason);
  } finally { transport.close(); }
}
