/**
 * Open Donation Ledger - the reading part.
 *
 * Donations arrive as sentences and photographs, not as forms:
 *
 *   "abi 250 tl yolladım montlara yazın"
 *   "Sending 40 EUR, please keep me anonymous"
 *   [a photo of a bank transfer receipt]
 *
 * A model reads those well. The problem is not accuracy on the easy ones, it is
 * that a wrong number looks exactly like a right one, and this number ends up
 * on a public page next to a stranger's name. So nothing the model says is
 * trusted on its own. Two checks stand between the model and the ledger:
 *
 *   Text  - the model must return the exact substring it read the amount from,
 *           and that substring has to actually occur in the message.
 *   Image - there is no source text to check against, so the page is read twice
 *           with two differently framed prompts and the readings must agree.
 *
 * Anything that fails a check is still recorded, with status 'needs-review'.
 * The row exists so the money is not lost; it just does not count until a
 * person has looked at it.
 */

var GEMINI_MODEL = 'gemini-3.6-flash';
var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

var EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'number' },
    currency: { type: 'string', description: 'ISO 4217, e.g. TRY, EUR, USD' },
    donor: { type: 'string', description: 'name as written, or empty if none given' },
    purpose: { type: 'string', description: 'what the donation is earmarked for, or empty' },
    anonymous: { type: 'boolean', description: 'true if the sender asked not to be named' },
    amount_quote: {
      type: 'string',
      description: 'the exact characters from the input that state the amount, copied verbatim'
    }
  },
  required: ['amount', 'currency', 'amount_quote']
};

var TEXT_PROMPT =
  'Read this message from a charity donor and extract the donation.\n' +
  'Copy amount_quote character for character out of the message. Do not tidy it, ' +
  'do not convert it, do not translate it. If the message states no amount, ' +
  'return amount 0 and an empty amount_quote.\n\nMessage:\n';

// The two image prompts ask for the same fact from different directions so a
// misreading is unlikely to repeat identically. Same model, same temperature:
// what is being tested is whether the page is legible, not whether the model
// is creative.
var IMAGE_PROMPT_A =
  'This is a photograph of a bank transfer receipt. Report the transferred amount ' +
  'and its currency, plus the sender name if it is printed.';
var IMAGE_PROMPT_B =
  'Read every number visible on this receipt image, then report only the one that ' +
  'is the amount of money transferred, with its currency and the sender name if shown.';

/**
 * Extracts a donation from a text message. Returns an entry ready for
 * recordEntry(), already carrying its own verdict.
 */
function extractFromText(message, transportId, deps) {
  var read = deps.askGemini(TEXT_PROMPT + message, null);
  var verdict = verifyQuote(message, read.amount_quote, read.amount);

  return {
    entry_id: entryIdFor('whatsapp', transportId),
    amount: read.amount,
    currency: read.currency,
    donor: read.donor || 'Anonymous',
    consentToPublish: !read.anonymous && !!read.donor,
    purpose: read.purpose || 'General fund',
    source: 'whatsapp',
    confidence: verdict.ok ? 0.99 : 0.4,
    status: verdict.ok ? 'posted' : 'needs-review',
    review_reason: verdict.reason
  };
}

/**
 * Extracts a donation from a receipt photo. Two reads, and they have to agree
 * on both the amount and the currency before the row counts.
 */
function extractFromReceipt(imageBytes, mimeType, transportId, deps) {
  var a = deps.askGemini(IMAGE_PROMPT_A, { bytes: imageBytes, mimeType: mimeType });
  var b = deps.askGemini(IMAGE_PROMPT_B, { bytes: imageBytes, mimeType: mimeType });

  var agree = a.amount === b.amount &&
    String(a.currency).toUpperCase() === String(b.currency).toUpperCase();

  return {
    entry_id: entryIdFor('receipt-photo', transportId),
    amount: a.amount,
    currency: a.currency,
    donor: a.donor || b.donor || 'Anonymous',
    consentToPublish: false,          // a name printed on a receipt is not consent
    purpose: 'General fund',
    source: 'receipt-photo',
    confidence: agree ? 0.95 : 0.3,
    status: agree ? 'posted' : 'needs-review',
    review_reason: agree ? '' : 'two reads disagreed: ' +
      a.amount + ' ' + a.currency + ' vs ' + b.amount + ' ' + b.currency
  };
}

/**
 * The check that does the actual work.
 *
 * Three ways it says no, and the third is the one that matters:
 *   - nothing was quoted at all
 *   - the quote is not in the message, so the model wrote it rather than read it
 *   - the quote is in the message but its digits are not the amount returned,
 *     which is what a currency conversion or a decimal slip looks like
 *
 * Whitespace and case are normalised because people type the way people type.
 * The digits are not normalised, because that is the part being verified.
 */
function verifyQuote(sourceText, quote, amount) {
  if (!quote) return { ok: false, reason: 'model quoted nothing' };

  var haystack = String(sourceText).toLowerCase().replace(/\s+/g, ' ');
  var needle = String(quote).toLowerCase().replace(/\s+/g, ' ').trim();
  if (haystack.indexOf(needle) === -1) {
    return { ok: false, reason: 'quote "' + quote + '" does not occur in the message' };
  }

  var quoted = parseQuotedNumber(needle);
  if (!isFinite(quoted)) return { ok: false, reason: 'quote carries no number' };
  if (Math.abs(quoted - Number(amount)) > 0.005) {
    return { ok: false, reason: 'quote says ' + quoted + ' but amount says ' + amount };
  }

  return { ok: true, reason: '' };
}

/**
 * Reads the number out of a quote without assuming a locale.
 *
 * "1.250,50 TL" and "1,250.50 USD" are the same amount written by two people,
 * and a charity that takes transfers from abroad sees both in the same week.
 * Which of '.' and ',' is the decimal point cannot be decided from the
 * character, only from position: the last separator followed by one or two
 * digits is the decimal point, and every other separator is grouping. Three
 * digits after a separator means it was grouping all along, so "1.250" is a
 * thousand two hundred fifty and not one point two five.
 */
function parseQuotedNumber(text) {
  var digits = String(text).replace(/[^0-9.,]/g, '');
  if (!digits) return NaN;

  var sep = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
  var decimals = sep === -1 ? 0 : digits.length - sep - 1;

  if (sep !== -1 && decimals >= 1 && decimals <= 2) {
    return parseFloat(digits.slice(0, sep).replace(/[.,]/g, '') + '.' + digits.slice(sep + 1));
  }
  return parseFloat(digits.replace(/[.,]/g, ''));
}

/* ---------------------------------------------------------------------------
 * Apps Script wiring.
 * ------------------------------------------------------------------------ */

/**
 * One call, structured output, no free-form JSON parsing. responseSchema makes
 * the model return the shape instead of a paragraph containing the shape.
 */
function geminiCaller() {                                  // eslint-disable-line no-unused-vars
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('set GEMINI_API_KEY in Project Settings > Script Properties');

  return function askGemini(prompt, image) {
    var parts = [{ text: prompt }];
    if (image) {
      parts.push({ inline_data: { mime_type: image.mimeType, data: Utilities.base64Encode(image.bytes) } });
    }
    var res = UrlFetchApp.fetch(GEMINI_ENDPOINT + GEMINI_MODEL + ':generateContent?key=' + key, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_SCHEMA
        }
      })
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    }
    var body = JSON.parse(res.getContentText());
    return JSON.parse(body.candidates[0].content.parts[0].text);
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    EXTRACTION_SCHEMA: EXTRACTION_SCHEMA,
    TEXT_PROMPT: TEXT_PROMPT,
    IMAGE_PROMPT_A: IMAGE_PROMPT_A,
    IMAGE_PROMPT_B: IMAGE_PROMPT_B,
    extractFromText: extractFromText,
    extractFromReceipt: extractFromReceipt,
    verifyQuote: verifyQuote
  };
}
