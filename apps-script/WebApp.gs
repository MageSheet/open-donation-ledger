/**
 * Open Donation Ledger - the page a donor can open.
 *
 * This is the half that makes the rest worth building. A donor who can see
 * where the money went asks once instead of asking every month, and a treasurer
 * who knows the page exists writes the purpose down at the time.
 *
 * Two rules the page enforces rather than trusts:
 *   - a row nobody has checked is counted nowhere, only announced as pending
 *   - a donor who did not consent is 'Anonymous' here even though the ledger
 *     knows the name
 */

/** Builds everything the page renders. Pure, so it is tested without a browser. */
function publicView(rows, deps) {
  var totals = ledgerTotals(rows);
  var recent = [];

  for (var i = rows.length - 1; i >= 0 && recent.length < 12; i--) {
    var r = rows[i];
    if (r.status !== 'posted' || r.kind === 'correction') continue;
    recent.push({
      name: r.public_name || 'Anonymous',
      amount: r.amount,
      currency: r.currency,
      purpose: r.purpose,
      kind: r.kind,
      // The date is deliberately coarse. A timestamp plus an amount plus a
      // village is enough to work out who gave what.
      day: String(r.recorded_at).slice(0, 10)
    });
  }

  return {
    generatedAt: deps.now().toISOString(),
    raised: totals.raised,
    spent: totals.spent,
    byPurpose: totals.byPurpose,
    pendingReview: totals.pendingReview,
    recent: recent
  };
}

function readLedgerRows() {                                // eslint-disable-line no-unused-vars
  var sheet = SpreadsheetApp.getActive().getSheetByName('Ledger');
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, LEDGER_HEADERS.length).getValues();
  return values.map(function (row) {
    var o = {};
    for (var i = 0; i < LEDGER_HEADERS.length; i++) o[LEDGER_HEADERS[i]] = row[i];
    o.amount = Number(o.amount);
    return o;
  });
}

function doGet(e) {                                        // eslint-disable-line no-unused-vars
  var view = publicView(readLedgerRows(), { now: function () { return new Date(); } });

  if (e && e.parameter && e.parameter.format === 'json') {
    return ContentService.createTextOutput(JSON.stringify(view))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var page = HtmlService.createTemplateFromFile('Page');
  page.data = JSON.stringify(view);
  return page.evaluate()
    .setTitle('Where the money went')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

if (typeof module !== 'undefined') {
  module.exports = { publicView: publicView };
}
