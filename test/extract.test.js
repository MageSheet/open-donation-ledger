const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppsScript, memoryLedger } = require('./harness');

const ctx = loadAppsScript();

/** A Gemini stand-in that returns whatever the test hands it, in order. */
function fakeGemini(...replies) {
  let i = 0;
  return { askGemini: () => replies[Math.min(i++, replies.length - 1)] };
}

test('a quote that occurs in the message and matches the amount passes', () => {
  assert.deepEqual(
    ctx.verifyQuote('abi 250 tl yolladım montlara yazın', '250 tl', 250),
    { ok: true, reason: '' }
  );
});

test('a quote the model wrote rather than read is rejected', () => {
  const v = ctx.verifyQuote('sending some money for the coats', '250 TRY', 250);
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not occur/);
});

test('a quote that is present but says a different number is rejected', () => {
  // The classic silent failure: the model converts, or moves a decimal.
  const v = ctx.verifyQuote('I sent 40 EUR today', '40 EUR', 1400);
  assert.equal(v.ok, false);
  assert.match(v.reason, /quote says 40 but amount says 1400/);
});

test('European decimal commas are read as decimals, not thousands', () => {
  assert.equal(ctx.verifyQuote('bagis 1.250,50 TL', '1.250,50 TL', 1250.5).ok, true);
});

test('an empty quote is rejected before anything else is checked', () => {
  assert.equal(ctx.verifyQuote('no amount here', '', 0).ok, false);
});

test('whitespace and case differences do not fail an honest quote', () => {
  assert.equal(ctx.verifyQuote('Sent  250   TL  today', '250 tl', 250).ok, true);
});

test('a verified text message is posted with the donor named on consent', () => {
  const deps = fakeGemini({
    amount: 250, currency: 'TRY', donor: 'Ayşe K.', purpose: 'Winter coats',
    anonymous: false, amount_quote: '250 tl'
  });
  const entry = ctx.extractFromText('Ayşe K.: 250 tl gonderdim, montlara', 'wamid.1', deps);
  assert.equal(entry.status, 'posted');
  assert.equal(entry.consentToPublish, true);
  assert.equal(entry.entry_id, 'whatsapp:wamid.1');
});

test('a donor who asks to stay unnamed is not published even when named', () => {
  const deps = fakeGemini({
    amount: 40, currency: 'EUR', donor: 'Jonas', purpose: '',
    anonymous: true, amount_quote: '40 EUR'
  });
  const entry = ctx.extractFromText('Sending 40 EUR, please keep me anonymous', 'wamid.2', deps);
  assert.equal(entry.consentToPublish, false);
});

test('an unverifiable reading is kept but held back from the totals', () => {
  const deps = fakeGemini({
    amount: 5000, currency: 'TRY', donor: '', purpose: '',
    anonymous: false, amount_quote: '5000 TL'      // never appears in the message
  });
  const entry = ctx.extractFromText('bir miktar yolladim', 'wamid.3', deps);
  assert.equal(entry.status, 'needs-review');
  assert.equal(entry.amount, 5000);                // not discarded, just not counted
  assert.match(entry.review_reason, /does not occur/);
});

test('two receipt reads that agree are posted', () => {
  const deps = fakeGemini(
    { amount: 1200, currency: 'TRY', donor: 'M. Yilmaz', amount_quote: '' },
    { amount: 1200, currency: 'TRY', donor: 'M. Yilmaz', amount_quote: '' }
  );
  const entry = ctx.extractFromReceipt('bytes', 'image/jpeg', 'wamid.4', deps);
  assert.equal(entry.status, 'posted');
  assert.equal(entry.confidence, 0.95);
});

test('two receipt reads that disagree go to review with both readings named', () => {
  const deps = fakeGemini(
    { amount: 1200, currency: 'TRY', donor: '', amount_quote: '' },
    { amount: 120, currency: 'TRY', donor: '', amount_quote: '' }
  );
  const entry = ctx.extractFromReceipt('bytes', 'image/jpeg', 'wamid.5', deps);
  assert.equal(entry.status, 'needs-review');
  assert.match(entry.review_reason, /1200 TRY vs 120 TRY/);
});

test('a name printed on a receipt is never treated as consent to publish', () => {
  const deps = fakeGemini(
    { amount: 500, currency: 'TRY', donor: 'Fatma D.', amount_quote: '' },
    { amount: 500, currency: 'TRY', donor: 'Fatma D.', amount_quote: '' }
  );
  const entry = ctx.extractFromReceipt('bytes', 'image/jpeg', 'wamid.6', deps);
  assert.equal(entry.consentToPublish, false);
});

test('an extracted entry survives the ledger rules end to end', () => {
  const gemini = fakeGemini({
    amount: 250, currency: 'TRY', donor: 'Ayşe K.', purpose: 'Winter coats',
    anonymous: false, amount_quote: '250 tl'
  });
  const entry = ctx.extractFromText('250 tl gonderdim, montlara', 'wamid.7', gemini);
  const sheet = memoryLedger();
  assert.equal(ctx.recordEntry(entry, sheet).status, 'recorded');
  assert.equal(ctx.recordEntry(entry, sheet).status, 'duplicate');
});

test('a US-grouped amount reads the same as its European twin', () => {
  assert.equal(ctx.verifyQuote('donated 1,250.50 USD', '1,250.50 USD', 1250.5).ok, true);
});

test('three digits after a separator is grouping, not a decimal', () => {
  // "1.250" is a thousand two hundred fifty in half of Europe, never 1.25.
  assert.equal(ctx.verifyQuote('bagis 1.250 TL', '1.250 TL', 1250).ok, true);
});
