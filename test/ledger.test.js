const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript, memoryLedger, asObjects } = require('./harness');

const ctx = loadAppsScript();

function donation(over = {}) {
  return Object.assign({
    entry_id: 'whatsapp:msg-1',
    amount: 250,
    currency: 'TRY',
    donor: 'Ayşe K.',
    consentToPublish: true,
    purpose: 'Winter coats'
  }, over);
}

test('a resent message is recorded once and reported as a duplicate', () => {
  const deps = memoryLedger();
  assert.equal(ctx.recordEntry(donation(), deps).status, 'recorded');
  const second = ctx.recordEntry(donation(), deps);
  assert.equal(second.status, 'duplicate');
  assert.equal(deps.rows.length, 1);
});

test('an amount that did not parse is refused rather than stored as zero', () => {
  const deps = memoryLedger();
  assert.throws(() => ctx.recordEntry(donation({ amount: 'iki yüz elli' }), deps), /positive number/);
  assert.throws(() => ctx.recordEntry(donation({ amount: 0 }), deps), /positive number/);
  assert.equal(deps.rows.length, 0);
});

test('currency is required, because a bare number is not money', () => {
  const deps = memoryLedger();
  assert.throws(() => ctx.recordEntry(donation({ currency: '' }), deps), /currency is required/);
});

test('a donor who did not consent is Anonymous on the public column', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ consentToPublish: false }), deps);
  const [row] = asObjects(ctx, deps.rows);
  assert.equal(row.donor, 'Ayşe K.');          // the ledger still knows
  assert.equal(row.public_name, 'Anonymous');  // the page does not
});

test('a correction must point at a row that exists', () => {
  const deps = memoryLedger();
  assert.throws(
    () => ctx.recordEntry(donation({ entry_id: 'c1', kind: 'correction', corrects: 'nope' }), deps),
    /no such entry/
  );
});

test('a corrected row stops counting and the correction counts instead', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ entry_id: 'a', amount: 2500 }), deps);   // typo: one zero too many
  ctx.recordEntry(donation({ entry_id: 'b', amount: 250, kind: 'correction', corrects: 'a' }), deps);
  const totals = ctx.ledgerTotals(asObjects(ctx, deps.rows));
  assert.equal(totals.raised.TRY, 250);
});

test('rows waiting on a human are counted nowhere but are announced', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ entry_id: 'a', amount: 100 }), deps);
  ctx.recordEntry(donation({ entry_id: 'b', amount: 900, status: 'needs-review' }), deps);
  const totals = ctx.ledgerTotals(asObjects(ctx, deps.rows));
  assert.equal(totals.raised.TRY, 100);
  assert.equal(totals.pendingReview, 1);
});

test('spending is netted against the fund it came from', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ entry_id: 'a', amount: 1000, purpose: 'Winter coats' }), deps);
  ctx.recordEntry(donation({ entry_id: 'b', amount: 640, kind: 'spend', purpose: 'Winter coats' }), deps);
  const totals = ctx.ledgerTotals(asObjects(ctx, deps.rows));
  assert.equal(totals.raised.TRY, 1000);
  assert.equal(totals.spent.TRY, 640);
  assert.deepEqual(totals.byPurpose, [{ purpose: 'Winter coats', currency: 'TRY', raised: 1000, spent: 640 }]);
});

test('two currencies are kept apart instead of added together', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ entry_id: 'a', amount: 250, currency: 'TRY' }), deps);
  ctx.recordEntry(donation({ entry_id: 'b', amount: 40, currency: 'EUR' }), deps);
  const totals = ctx.ledgerTotals(asObjects(ctx, deps.rows));
  assert.equal(totals.raised.TRY, 250);
  assert.equal(totals.raised.EUR, 40);
});

test('an entry id needs a transport id, not a guess', () => {
  assert.throws(() => ctx.entryIdFor('whatsapp', ''), /message id/);
  assert.equal(ctx.entryIdFor('whatsapp', 'wamid.7'), 'whatsapp:wamid.7');
});

test('the public view hides names, coarsens dates and drops unreviewed rows', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ entry_id: 'a', amount: 250, consentToPublish: false }), deps);
  ctx.recordEntry(donation({ entry_id: 'b', amount: 900, status: 'needs-review' }), deps);
  const view = ctx.publicView(asObjects(ctx, deps.rows), { now: () => new Date('2026-09-06T12:00:00Z') });
  assert.equal(view.recent.length, 1);
  assert.equal(view.recent[0].name, 'Anonymous');
  assert.equal(view.recent[0].day, '2026-09-06');
  assert.equal(view.pendingReview, 1);
});

test('one fund holding two currencies is never added into a single number', () => {
  const deps = memoryLedger();
  ctx.recordEntry(donation({ entry_id: 'a', amount: 590, currency: 'TRY', purpose: 'Winter coats' }), deps);
  ctx.recordEntry(donation({ entry_id: 'b', amount: 40, currency: 'EUR', purpose: 'Winter coats' }), deps);
  const totals = ctx.ledgerTotals(asObjects(ctx, deps.rows));
  assert.deepEqual(totals.byPurpose, [
    { purpose: 'Winter coats', currency: 'EUR', raised: 40, spent: 0 },
    { purpose: 'Winter coats', currency: 'TRY', raised: 590, spent: 0 }
  ]);
});
