# Open Donation Ledger

A donation ledger for a group too small to buy software: a Google Sheet, some
Apps Script, and one public page a donor can open. Donations arrive as WhatsApp
messages and photographs of bank receipts, Gemini reads them, and two checks
decide whether a reading is trustworthy enough to count.

Built for the [DEV Weekend Challenge: Generosity Edition](https://dev.to/challenges/weekend-2026-09-03).

**[Live demo of the public page →](https://magesheet.github.io/open-donation-ledger/)**

---

## The problem this is actually about

A neighbourhood fund, a school parents' group, a mosque committee: money comes
in over WhatsApp and goes out in cash, and somebody keeps it in a notebook.
The arithmetic is not the hard part. The hard part arrives three months later
when a donor asks where their money went and nobody can answer without the
notebook, the person who holds it, and an afternoon.

Software exists for this. It is priced for organisations with a finance team.

So the ledger lives in a spreadsheet a volunteer already knows how to open, and
the only thing added is the part a spreadsheet cannot do on its own: reading
messy human messages, refusing to trust its own reading, and publishing a page
that answers the question before it is asked.

## Reading money out of a sentence, safely

Real messages look like this:

```
abi 250 tl yolladım montlara yazın
Sending 40 EUR for the winter fund, please keep me anonymous
bugün 1.250,50 TL havale ettim, dekontu sonra atarım
```

A model reads those well. That is not the problem. The problem is that a wrong
number looks exactly like a right one, and this number ends up on a public page
next to a stranger's name.

**So the model is never trusted on its own.** It has to show its work:

| Input | Check | Fails when |
| --- | --- | --- |
| Text message | The model must return `amount_quote`, the exact characters it read the amount from, and that substring has to occur in the message | The model wrote the quote instead of reading it, or the quote's digits are not the amount returned |
| Receipt photo | The image is read twice with two differently framed prompts, and both readings must agree on amount and currency | The page is blurry, cropped, or has several numbers on it |

Anything that fails is still recorded, with `status: needs-review`. The money is
not lost. It just does not count until a person has looked at it, and the public
page says how many rows are waiting.

`verifyQuote()` is the whole idea, and it is about twenty lines:

```javascript
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
```

### What it does on real messages

`node test/live-gemini.js`, run against `gemini-3.6-flash` at temperature 0 with
structured output, on 6 September 2026:

```
  message : abi 250 tl yolladım montlara yazın
  read    : 250 TRY
  quote   : "250 tl"
  verdict : POSTED

  message : Sending 40 EUR for the winter fund, please keep me anonymous
  read    : 40 EUR (anonymous)
  quote   : "40 EUR"
  verdict : POSTED

  message : bugün 1.250,50 TL havale ettim, dekontu sonra atarım
  read    : 1250.5 TRY
  quote   : "1.250,50 TL"
  verdict : POSTED

  message : Ben Ayşe, çocuklara kırtasiye için 500 lira gönderdim
  read    : 500 TRY from Ayşe
  quote   : "500 lira"
  verdict : POSTED

  message : yarın bir miktar göndereceğim inşallah
  read    : 0 TRY
  quote   : ""
  verdict : NEEDS REVIEW - model quoted nothing

  message : I gave 100 dollars last week, that is about 3400 lira right?
  read    : 100 USD
  quote   : "100 dollars"
  verdict : POSTED

5/6 posted straight to the ledger, 1 held for a human.
```

Two of those are worth pausing on. "yarın bir miktar göndereceğim" is a promise,
not a donation, and it produced no quote, so it went to review instead of
becoming a zero-lira row. And the last message names two numbers, 100 dollars
and a 3400 lira conversion; the ledger got 100 USD, which is the money that
actually moved.

That run also took a `503 high demand` on the first call and recovered on the
retry. A shared endpoint answering "not now" is normal traffic, not a failure,
which is why both the script and the Apps Script side wrap the call in backoff.

## Nothing is edited after the fact

There is no update path in `Ledger.gs`. A mistake is fixed by appending a
correction row that names the row it corrects, and the totals net the two. Both
rows stay on the record, because a ledger whose history can change quietly is
the thing the donor was worried about.

Three more rules the code enforces rather than trusts:

- **A resent message is recorded once.** The idempotency key comes from the
  transport's own message id, so a receipt three volunteers forwarded is one row
  and the third volunteer is not told something went wrong.
- **A donor who did not ask to be named is `Anonymous` on the page,** even though
  the ledger still knows who they are. A name printed on a bank receipt is not
  consent.
- **One fund holding two currencies is never added into one number.** 590 TRY
  and 40 EUR is not 630 of anything. This one was a real bug, caught by building
  the demo out of the same code the tests run.

## Running it

```
node --test test/ledger.test.js test/extract.test.js   # 27 tests, no network, no API key
node test/build-demo.js                                # rebuilds the demo page from the same code
GEMINI_API_KEY=... node test/live-gemini.js            # the separate question of how the model behaves
```

The unit tests are the interesting part of the setup: Apps Script has no
modules, every file shares one global scope, so `test/harness.js` evaluates the
`.gs` files into a single `vm` context instead of requiring them separately.
The tests then exercise the same globals the deployed script does, and side
effects go through a `deps` object that is a sheet in production and an array in
the tests.

### Deploying it to a real sheet

1. Create a Google Sheet, then **Extensions → Apps Script**.
2. Copy the four files from `apps-script/` in.
3. Run `setupLedger()` once. It creates and protects the `Ledger` sheet.
4. **Project Settings → Script Properties**, add `GEMINI_API_KEY`
   (from [Google AI Studio](https://aistudio.google.com/)).
5. **Deploy → New deployment → Web app**, execute as yourself, access "anyone".
   That URL is the public page. `?format=json` gives the same data as JSON.

Wire `extractFromText()` to whatever brings the messages in. The demo history
uses WhatsApp message ids because that is what the ledger was built against, but
the only thing the code needs from a transport is a stable id per message.

## What this is not

- Not accounting software. It is a ledger and a page, and it will not file
  anything for you.
- Not a fraud control. It checks that a reading matches its source, which is a
  different question from whether the source is honest.
- Not a security boundary. Whoever can open the sheet can read the donor names
  the public page hides.

## Layout

```
apps-script/
  Ledger.gs     append-only ledger, corrections, idempotency, totals
  Extract.gs    Gemini calls, the quote check, locale-safe number parsing
  WebApp.gs     doGet, and the pure function that builds the public view
  Page.html     the public page
test/
  harness.js    loads the .gs files into one shared scope, like Apps Script
  *.test.js     27 tests, no network
  live-gemini.js  the real model, run by hand
  build-demo.js   rebuilds docs/ from the same code
docs/           what GitHub Pages serves
```

MIT.
