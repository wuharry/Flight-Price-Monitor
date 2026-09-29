import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyDesktop, type CommandRunner } from '../src/services/desktop-notify.js';

const capture = () => {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner: CommandRunner = async (file, args, env) => { calls.push({ file, args, env }); };
  return { calls, runner };
};

test('caller text cannot close the script it is embedded in', async () => {
  const { calls, runner } = capture();
  const body = 'price "dropped" & do shell script "boom"';
  assert.equal(await notifyDesktop('✈ TPE → NRT', body, runner), true);
  const [call] = calls;
  if (process.platform === 'darwin') {
    // Every quote arrives escaped, so the notification string never ends early.
    assert.match(call.args[1], /price \\"dropped\\" & do shell script \\"boom\\"/);
    assert.equal(call.args[1].includes('✈ TPE → NRT'), true);
  } else {
    // The other platforms take the text out of band and must not interpolate it.
    assert.equal(call.env.FLIGHT_NOTIFY_BODY, body);
  }
});

test('newlines are flattened so a multi-line reason stays one notification', async () => {
  const { calls, runner } = capture();
  await notifyDesktop('title', 'first\nsecond', runner);
  if (process.platform === 'darwin') assert.equal(calls[0].args[1].includes('\n'), false);
});

test('a desktop with no notifier reports failure instead of throwing', async () => {
  assert.equal(await notifyDesktop('title', 'body', async () => { throw new Error('no session'); }), false);
});
