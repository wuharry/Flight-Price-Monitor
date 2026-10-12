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
      assert.deepEqual(mail.from, { name: 'Tickets', address: 'sender@gmail.com' });
      assert.equal(mail.replyTo, 'desk@example.com');
      assert.deepEqual(mail.to, ['recipient@example.com']); ids.push(mail.messageId);
      return { accepted: ['recipient@example.com'], rejected: [] };
    } };
  };
  const returned: string[] = [];
  for (let i=0;i<2;i++) returned.push(await sendGmail('sender@gmail.com', 'abcd efgh ijkl mnop', 'recipient@example.com', message, 'alert-1',
    { fromName: 'Tickets', replyTo: 'desk@example.com', factory }));
  assert.equal(ids[0], ids[1]); assert.equal(closed, 2);
  // The caller logs this so a refused message can be traced in the recipient's quarantine.
  assert.deepEqual(returned, ids);
  assert.match(returned[0]!, /^<flight-alert-[0-9a-f]{64}@gmail\.com>$/);
});
test('Gmail failures close connection and hide raw credentials; rejected recipients fail', async () => {
  let closed = 0;
  await assert.rejects(sendGmail('sender@gmail.com','test','recipient@example.com',message,'id',{ factory: ()=>({
    close:()=>{closed++;}, sendMail:async()=>{throw Object.assign(new Error('SECRET'),{code:'EAUTH'});}
  }) }), e => /authentication failed/.test(String(e)) && !String(e).includes('SECRET'));
  await assert.rejects(sendGmail('sender@gmail.com','test','recipient@example.com',message,'id',{ factory: ()=>({
    close:()=>{closed++;}, sendMail:async()=>({accepted:[],rejected:['recipient@example.com']})
  }) }), /not confirmed/);
  assert.equal(closed,2);
});

test('Gmail keeps SMTP status codes but not the raw response line', async () => {
  // Without the codes every refusal reads alike; the codes name no address or credential.
  await assert.rejects(sendGmail('sender@gmail.com','test','recipient@example.com',message,'id',{ factory: ()=>({
    close:()=>{}, sendMail:async()=>{ throw Object.assign(new Error('refused'), { code:'EENVELOPE',
      responseCode:550, response:'550 5.4.5 Daily user sending limit exceeded. victim@corp.example' }); },
  }) }), e => {
    const text = String(e);
    assert.match(text, /SMTP 550 5\.4\.5/);
    assert.equal(text.includes('victim@corp.example'), false);
    assert.equal(text.includes('Daily user sending limit'), false);
    return true;
  });
});
test('Gmail config accepts app password without requiring Resend or a custom domain', () => {
  const env = { STORAGE:'supabase',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test',EMAIL_MODE:'send',EMAIL_PROVIDER:'gmail',GMAIL_USER:'sender@gmail.com',GMAIL_APP_PASSWORD:'abcd efgh ijkl mnop' };
  assert.equal(parseConfig(env).EMAIL_PROVIDER,'gmail');
  assert.throws(()=>parseConfig({...env,GMAIL_APP_PASSWORD:''}),/GMAIL_APP_PASSWORD/);
  assert.throws(()=>parseConfig({...env,GMAIL_USER:'invalid'}));
});

test('Gmail keeps the default sender name and omits Reply-To when unset', async () => {
  await sendGmail('sender@gmail.com', 'abcdefghijklmnop', 'recipient@example.com', message, 'alert-2', {
    factory: () => ({ close: () => {}, sendMail: async mail => {
      assert.deepEqual(mail.from, { name: 'Flight Monitor', address: 'sender@gmail.com' });
      assert.equal('replyTo' in mail, false);
      return { accepted: ['recipient@example.com'], rejected: [] };
    } }),
  });
});

test('Reply-To must be a real address when configured', () => {
  const env = { STORAGE:'local',EMAIL_MODE:'send',EMAIL_PROVIDER:'gmail',GMAIL_USER:'sender@gmail.com',
    GMAIL_APP_PASSWORD:'abcd efgh ijkl mnop',NOTIFICATION_TO_EMAIL:'to@example.com' };
  assert.equal(parseConfig({ ...env, EMAIL_REPLY_TO:'desk@example.com' }).EMAIL_REPLY_TO, 'desk@example.com');
  assert.equal(parseConfig(env).EMAIL_FROM_NAME, 'Flight Monitor');
  assert.throws(() => parseConfig({ ...env, EMAIL_REPLY_TO:'not-an-address' }));
});
