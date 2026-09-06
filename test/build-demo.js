/**
 * Builds the GitHub Pages demo out of the real code.
 *
 * The demo is not a mockup: the sample messages below go through the same
 * recordEntry() and publicView() the deployed script uses, and the page is
 * Page.html with its one Apps Script template tag swapped for a fetch. If the
 * ledger rules change, the demo changes with them or the build fails.
 *
 *   node test/build-demo.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadAppsScript, memoryLedger, asObjects } = require('./harness');

const ctx = loadAppsScript();
const ROOT = path.join(__dirname, '..');

// One month of a small neighbourhood fund, including the things that go wrong:
// a typo that had to be corrected, a receipt two volunteers forwarded, and a
// reading the checks refused to trust.
const HISTORY = [
  { entry_id: 'whatsapp:w1', amount: 250, currency: 'TRY', donor: 'Ayşe K.', consentToPublish: true, purpose: 'Winter coats', source: 'whatsapp', confidence: 0.99 },
  { entry_id: 'whatsapp:w2', amount: 40, currency: 'EUR', donor: 'Jonas', consentToPublish: false, purpose: 'Winter coats', source: 'whatsapp', confidence: 0.99 },
  { entry_id: 'receipt-photo:r1', amount: 1200, currency: 'TRY', donor: 'M. Yılmaz', consentToPublish: false, purpose: 'School supplies', source: 'receipt-photo', confidence: 0.95 },
  { entry_id: 'receipt-photo:r1', amount: 1200, currency: 'TRY', donor: 'M. Yılmaz', consentToPublish: false, purpose: 'School supplies', source: 'receipt-photo', confidence: 0.95 }, // same photo, forwarded twice
  { entry_id: 'whatsapp:w3', amount: 5000, currency: 'TRY', donor: 'Anonymous', consentToPublish: false, purpose: 'General fund', source: 'whatsapp', confidence: 0.4, status: 'needs-review' },
  { entry_id: 'whatsapp:w4', amount: 3400, currency: 'TRY', donor: 'Selim', consentToPublish: true, purpose: 'Winter coats', source: 'whatsapp', confidence: 0.99 },
  { entry_id: 'manual:c1', amount: 340, currency: 'TRY', donor: 'Selim', consentToPublish: true, purpose: 'Winter coats', source: 'manual', kind: 'correction', corrects: 'whatsapp:w4' },
  { entry_id: 'manual:s1', amount: 590, currency: 'TRY', donor: 'Coat supplier', consentToPublish: true, purpose: 'Winter coats', source: 'manual', kind: 'spend' },
  { entry_id: 'manual:s2', amount: 780, currency: 'TRY', donor: 'Stationery shop', consentToPublish: true, purpose: 'School supplies', source: 'manual', kind: 'spend' },
  { entry_id: 'whatsapp:w5', amount: 1250.5, currency: 'TRY', donor: 'Anonymous', consentToPublish: false, purpose: 'School supplies', source: 'whatsapp', confidence: 0.99 }
];

const sheet = memoryLedger(new Date('2026-09-06T09:00:00Z'));
let duplicates = 0;
for (const entry of HISTORY) {
  if (ctx.recordEntry(entry, sheet).status === 'duplicate') duplicates++;
}

const view = ctx.publicView(asObjects(ctx, sheet.rows), { now: () => new Date('2026-09-06T09:00:00Z') });

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'data.json'), JSON.stringify(view, null, 2));

const page = fs.readFileSync(path.join(ROOT, 'apps-script', 'Page.html'), 'utf8');
if (!page.includes('var DATA = <?= data ?>;')) {
  throw new Error('Page.html no longer has the template tag the demo swaps out');
}
fs.writeFileSync(
  path.join(ROOT, 'docs', 'index.html'),
  page
    .replace(
      'var DATA = <?= data ?>;',
      "// Deployed, this line is Apps Script's `<?= data ?>`. On GitHub Pages the\n" +
      '  // same JSON is loaded from a file so the page can be read without a Google\n' +
      '  // account. Everything below is byte for byte the deployed page.\n' +
      '  var DATA = null;'
    )
    .replace('(function render() {', 'function render() {')
    .replace(
      '  })();\n</script>',
      '  }\n\n  fetch("data.json").then(function (r) { return r.json(); })\n' +
      '    .then(function (d) { DATA = d; render(); });\n</script>'
    )
);

console.log(`docs/data.json and docs/index.html written`);
console.log(`${HISTORY.length} entries in, ${sheet.rows.length} rows recorded, ${duplicates} duplicate rejected`);
console.log(`totals: ${JSON.stringify(view.raised)} raised, ${JSON.stringify(view.spent)} spent, ${view.pendingReview} pending`);
