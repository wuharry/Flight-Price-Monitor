import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL schema, migration, atomic outbox, dedupe, locks and RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    const schema = await readFile('src/db/schema.sql', 'utf8');
    await db.exec(schema);
    await db.exec(schema); // re-running migrations is safe
    const seed = await readFile('src/db/seed.sql', 'utf8');
    await db.exec(seed);
    await db.exec(seed);
    const rules = await db.query('select * from watch_rules');
    assert.equal(rules.rows.length, 1);
    await db.exec('set role service_role');
    const ruleId = '16c47be1-218f-4ae6-9d52-09175e1b8d02';
    const owner = randomUUID(), other = randomUUID();
    const acquire = async (id: string) => (await db.query<{ acquired: boolean }>(
      'select acquire_monitor_lock($1) as acquired', [id])).rows[0].acquired;
    assert.equal(await acquire(owner), true);
    assert.equal(await acquire(other), false);
    await db.query('select release_monitor_lock($1)', [other]);
    assert.equal(await acquire(other), false);
    await db.query('select release_monitor_lock($1)', [owner]);
    assert.equal(await acquire(other), true);
    await db.exec("update monitor_locks set expires_at = now() - interval '1 minute'");
    assert.equal(await acquire(owner), true);
    const now = new Date().toISOString();
    const history = { id: randomUUID(), watchRuleId: ruleId, searchKey: 'key', price: 6500,
      currency: 'TWD', checkedAt: now, result: { outboundPrice: 3000, inboundPrice: 2000, taxAndFees: 1500 } };
    const alert = { id: randomUUID(), watchRuleId: ruleId, searchKey: 'key', price: 6500,
      type: 'below_target', createdAt: now, payload: { trigger: { reason: 'test' } } };
    await db.query('select record_price_check($1, $2)', [history, alert]);
    await db.query('select record_price_check($1, $2)', [{ ...history, id: randomUUID() }, { ...alert, id: randomUUID() }]);
    assert.equal((await db.query('select * from price_history')).rows.length, 2);
    assert.equal((await db.query('select * from alerts')).rows.length, 1);
    await db.exec("update alerts set status = 'sent', sent_at = now()");
    await db.query('select record_price_check($1, $2)', [{ ...history, id: randomUUID() }, { ...alert, id: randomUUID() }]);
    assert.equal((await db.query('select * from alerts')).rows.length, 1);
    // A failed alert insert must also roll back its associated price.
    await assert.rejects(db.query('select record_price_check($1, $2)', [
      { ...history, id: randomUUID() }, { ...alert, id: 'invalid-uuid', price: 6400 },
    ]));
    assert.equal((await db.query('select * from price_history')).rows.length, 3);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from watch_rules'), /permission denied/);
    await assert.rejects(db.query('select acquire_monitor_lock($1)', [randomUUID()]), /permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});
