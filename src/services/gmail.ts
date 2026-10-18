import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { createHash } from 'node:crypto';

export type GmailTransport = { sendMail(message: SendMailOptions): Promise<{ accepted: unknown[]; rejected: unknown[] }>; close(): void };
export type GmailFactory = (options: SMTPTransport.Options) => GmailTransport;
export interface GmailOptions { fromName?: string; replyTo?: string; factory?: GmailFactory }
export async function sendGmail(user: string, password: string, to: string,
  message: { subject: string; text: string; html: string }, id: string, options: GmailOptions = {}) {
  const factory = options.factory ?? (settings => nodemailer.createTransport(settings));
  let transport: GmailTransport | undefined;
  // Returned so the caller can log it: a recipient's mail admin searches their quarantine by
  // Message-ID, and acceptance here proves nothing about what the receiving server then did.
  const messageId = `<flight-alert-${createHash('sha256').update(id).digest('hex')}@${user.split('@')[1]}>`;
  try {
    transport = factory({ host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user, pass: password.replace(/\s/g, '') },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
    const result = await transport.sendMail({
      from: { name: options.fromName || 'Flight Monitor', address: user }, to: [to], ...message,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}), messageId });
    if (!result.accepted.length || result.rejected.length) throw new Error('Recipient rejected');
    return messageId;
  } catch (error) {
    // Do not surface raw SMTP responses or authentication values in shared logs. The status codes
    // are safe to keep: they carry no address, domain or credential, and without them a refusal
    // reads the same whether the quota ran out, the recipient bounced or the password expired.
    const { code, responseCode, response } = (error && typeof error === 'object' ? error : {}) as {
      code?: unknown; responseCode?: unknown; response?: unknown };
    const reason = code === 'EAUTH' ? 'authentication failed; check Google app password' : code === 'ETIMEDOUT' ? 'connection timed out' : 'message was not confirmed as accepted';
    const smtpCode = typeof responseCode === 'number' && Number.isInteger(responseCode) && responseCode >= 100 && responseCode <= 599 ? responseCode : undefined;
    const status = [smtpCode, /\b[45]\.\d{1,3}\.\d{1,3}\b/.exec(typeof response === 'string' ? response : '')?.[0]].filter(Boolean).join(' ');
    throw new Error('Gmail SMTP: ' + reason + (status ? ` (SMTP ${status})` : ''));
  } finally {
    // Closing a connection after SMTP acceptance cannot undo submission or justify another send.
    try { transport?.close(); } catch { /* Never expose transport diagnostics or credentials. */ }
  }
}
