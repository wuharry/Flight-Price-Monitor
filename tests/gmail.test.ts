import test from 'node:test';
import assert from 'node:assert/strict';
import { sendGmail, type GmailFactory } from '../src/services/gmail.js';
import { parseConfig } from '../src/config.js';
const message = { subject: 'test', text: 'test', html: '<p>test</p>' };
test('Gmail uses TLS, authenticated sender, normalized app password and stable message ID', async () => {
  const ids: unknown[] = []; let closed = 0;
  const factory: GmailFactory = options => {
    assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.secure, true); assert.equal(options.port, 465);
    assert.equal((options.auth as { pass: string }).pass, 'abcdefghijklmnop');
    return { close: () => { closed++; }, sendMail: async mail => {
      assert.deepEqual(mail.from, { name: 'Flight Monitor', address: 'sender@gmail.com' });
      assert.deepEqual(mail.to, ['recipient@example.com']); ids.push(mail.messageId);
      return { accepted: ['recipient@example.com'], rejected: [] };
    } };
  };
  for (let i=0;i<2;i++) await sendGmail('sender@gmail.com', 'abcd efgh ijkl mnop', 'recipient@example.com', message, 'alert-1', factory);
  assert.equal(ids[0], ids[1]); assert.equal(closed, 2);
});
test('Gmail failures close connection and hide raw credentials; rejected recipients fail', async () => {
  let closed = 0;
  await assert.rejects(sendGmail('sender@gmail.com','test','recipient@example.com',message,'id',()=>({
    close:()=>{closed++;}, sendMail:async()=>{throw Object.assign(new Error('SECRET'),{code:'EAUTH'});}
  })), e => /authentication failed/.test(String(e)) && !String(e).includes('SECRET'));
  await assert.rejects(sendGmail('sender@gmail.com','test','recipient@example.com',message,'id',()=>({
    close:()=>{closed++;}, sendMail:async()=>({accepted:[],rejected:['recipient@example.com']})
  })), /not confirmed/);
  assert.equal(closed,2);
});
test('Gmail config accepts app password without requiring Resend or a custom domain', () => {
  const env = { STORAGE:'supabase',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test',EMAIL_MODE:'send',EMAIL_PROVIDER:'gmail',GMAIL_USER:'sender@gmail.com',GMAIL_APP_PASSWORD:'abcd efgh ijkl mnop' };
  assert.equal(parseConfig(env).EMAIL_PROVIDER,'gmail');
  assert.throws(()=>parseConfig({...env,GMAIL_APP_PASSWORD:''}),/GMAIL_APP_PASSWORD/);
  assert.throws(()=>parseConfig({...env,GMAIL_USER:'invalid'}));
});
