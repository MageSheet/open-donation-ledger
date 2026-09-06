/**
 * Loads the .gs files into one shared context, the way Apps Script does.
 *
 * Apps Script has no modules: every file shares one global scope, which is why
 * Extract.gs can call entryIdFor() from Ledger.gs. Requiring the files
 * separately in node would hide that, so they are evaluated into a single vm
 * context instead. The tests then exercise the same globals the deployed script
 * does.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'apps-script');

function loadAppsScript(files = ['Ledger.gs', 'Extract.gs', 'WebApp.gs']) {
  const context = vm.createContext({ console, JSON, Math, Date, Number, String, isFinite, parseFloat });
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

/** An in-memory stand-in for the Ledger sheet. */
function memoryLedger(now = new Date('2026-09-06T12:00:00Z')) {
  const rows = [];
  const ids = new Set();
  return {
    rows,
    now: () => now,
    hasEntry: (id) => ids.has(id),
    appendRow: (values) => { rows.push(values); ids.add(values[0]); }
  };
}

/** Turns appended arrays back into objects, the way the web app reads them. */
function asObjects(context, rows) {
  const headers = context.LEDGER_HEADERS;
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

module.exports = { loadAppsScript, memoryLedger, asObjects };
