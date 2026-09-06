/**
 * Runs the real prompt against the real model, so the README quotes measurements
 * rather than expectations.
 *
 *   GEMINI_API_KEY=... node test/live-gemini.js
 *
 * The key is read from the environment and never written anywhere. This file is
 * not part of `node --test`: the unit tests must pass with no network and no
 * key, and this is the separate question of whether the model behaves the way
 * the design assumes.
 */
const { loadAppsScript } = require('./harness');

const ctx = loadAppsScript();
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('set GEMINI_API_KEY'); process.exit(1); }

const MODEL = 'gemini-3.6-flash';

async function askGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: ctx.EXTRACTION_SCHEMA
        }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return JSON.parse(body.candidates[0].content.parts[0].text);
}

/**
 * 503 "high demand" is a normal answer from a shared endpoint, not a failure of
 * the extraction. Retrying it is the difference between a donation landing in
 * the ledger and a volunteer being told to try again later, so the deployed
 * Apps Script version needs the same backoff around UrlFetchApp.
 */
async function askWithBackoff(prompt, attempts = 4, onRetry = () => {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await askGemini(prompt);
    } catch (err) {
      const retryable = /\b(429|500|502|503|504)\b/.test(err.message);
      if (!retryable || i === attempts - 1) throw err;
      const wait = 400 * Math.pow(2, i);
      onRetry(err);
      console.log(`   (${err.message.slice(0, 40)}... retrying in ${wait}ms)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Real shapes a charity's WhatsApp actually receives, including the two that
// are supposed to fail: a message with no amount at all, and one that names a
// currency the sender did not send in.
const MESSAGES = [
  'abi 250 tl yolladım montlara yazın',
  'Sending 40 EUR for the winter fund, please keep me anonymous',
  'bugün 1.250,50 TL havale ettim, dekontu sonra atarım',
  'Ben Ayşe, çocuklara kırtasiye için 500 lira gönderdim',
  'yarın bir miktar göndereceğim inşallah',
  'I gave 100 dollars last week, that is about 3400 lira right?'
];

// Why each message is in the list. Shown on the walkthrough page so a reader
// knows which cases were chosen on purpose rather than cherry-picked after.
const WHY = {
  0: 'Ordinary case, lowercase currency, written the way people actually type.',
  1: 'Names a currency that is not the local one, and asks to stay unnamed.',
  2: 'European decimal comma with a thousands dot: 1.250,50 is not 1.25.',
  3: 'Names the donor inside the sentence, and writes the currency as a word.',
  4: 'A promise, not a donation. There is no amount to read.',
  5: 'Two numbers, one of them a conversion the sender did in their head.'
};

(async () => {
  console.log('model:', MODEL, '| temperature: 0 | structured output on\n');
  const transcript = [];
  let posted = 0;
  let retries = 0;

  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    let read;
    try {
      read = await askWithBackoff(ctx.TEXT_PROMPT + msg, 4, () => { retries++; });
    } catch (err) {
      console.log(`✗ ${msg}\n   request failed: ${err.message}\n`);
      transcript.push({ message: msg, why: WHY[i], error: err.message });
      continue;
    }
    const verdict = ctx.verifyQuote(msg, read.amount_quote, read.amount);
    if (verdict.ok) posted++;

    transcript.push({
      message: msg,
      why: WHY[i],
      read: read,
      verdict: verdict,
      // Where in the message the quote was found, so the page can highlight the
      // characters the model says it read the amount from.
      quoteAt: verdict.ok
        ? msg.toLowerCase().replace(/\s+/g, ' ').indexOf(String(read.amount_quote).toLowerCase().replace(/\s+/g, ' ').trim())
        : -1
    });

    console.log(`  message : ${msg}`);
    console.log(`  read    : ${read.amount} ${read.currency}` +
      (read.donor ? ` from ${read.donor}` : '') +
      (read.anonymous ? ' (anonymous)' : ''));
    console.log(`  quote   : ${JSON.stringify(read.amount_quote)}`);
    console.log(`  verdict : ${verdict.ok ? 'POSTED' : 'NEEDS REVIEW - ' + verdict.reason}\n`);
  }

  console.log(`${posted}/${MESSAGES.length} posted straight to the ledger, ` +
    `${MESSAGES.length - posted} held for a human.`);

  require('node:fs').writeFileSync(
    require('node:path').join(__dirname, '..', 'docs', 'extraction-run.json'),
    JSON.stringify({
      model: MODEL,
      temperature: 0,
      ranAt: new Date().toISOString(),
      prompt: ctx.TEXT_PROMPT,
      schema: ctx.EXTRACTION_SCHEMA,
      retries: retries,
      posted: posted,
      total: MESSAGES.length,
      runs: transcript
    }, null, 2)
  );
  console.log('docs/extraction-run.json written');
})();
