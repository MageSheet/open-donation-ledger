---
title: The ledger asks the model to show its work before it counts the money
published: false
tags: devchallenge, weekendchallenge, ai, googlecloud
---

*This is a submission for [Weekend Challenge: Generosity Edition](https://dev.to/challenges/weekend-2026-09-03)*

## What I Built

A donation ledger for a group too small to buy software. It is a Google Sheet,
some Apps Script, and one public page a donor can open.

The group I had in mind is the kind that exists on every street: a neighbourhood
fund, a school parents' group, a committee that collects for winter coats.
Money arrives over WhatsApp and leaves in cash, and somebody keeps it in a
notebook. The arithmetic is not the hard part. The hard part arrives three
months later when a donor asks where their money went, and answering needs the
notebook, the person holding it, and an afternoon.

Software for this exists and is priced for organisations with a finance team.
So the ledger stays in a spreadsheet a volunteer already knows how to open, and
the only thing added is what a spreadsheet cannot do alone: read messy human
messages, **refuse to trust its own reading**, and publish the page that answers
the question before it is asked.

## Demo

**[The public page →](https://magesheet.github.io/open-donation-ledger/)**

That page is the deployed page, byte for byte, with one line changed: where the
Apps Script version writes `<?= data ?>`, the demo fetches the same JSON from a
file so you can read it without a Google account. The JSON is produced by
running the sample month through the same `recordEntry()` and `publicView()` the
real script uses, so if the ledger rules change, the demo changes with them or
the build fails.

The sample month deliberately includes the things that go wrong: a receipt two
volunteers forwarded, a donation typed with one zero too many and later
corrected, and a reading the checks refused to trust.

## Code

{% embed https://github.com/MageSheet/open-donation-ledger %}

## How I Built It

### The part I actually care about

Real messages look like this:

```
abi 250 tl yolladım montlara yazın
Sending 40 EUR for the winter fund, please keep me anonymous
bugün 1.250,50 TL havale ettim, dekontu sonra atarım
```

Gemini reads those well. That was never the problem. The problem is that **a
wrong number looks exactly like a right one**, and this number ends up on a
public page next to a stranger's name. "Mostly accurate" is a fine standard for
a summary and a terrible one for a ledger.

So the model is not trusted on its own. It has to show its work.

For a text message, the schema requires an `amount_quote`: the exact characters
the model read the amount from, copied out of the message. Then the code checks
that this substring actually occurs in the message, and that its digits are the
amount that was returned. A model that quotes something it invented fails the
first check. A model that silently converted a currency or moved a decimal point
fails the second.

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

A receipt photograph has no source text to check a quote against, so it gets a
different check: the image is read twice with two differently framed prompts,
and the readings have to agree on both amount and currency. One prompt asks for
the transferred amount. The other asks the model to read every number on the
receipt and then say which one is the transfer. A blurry or cropped page tends
to produce two different answers, and two different answers means a person
looks at it.

Nothing that fails a check is discarded. It is recorded with
`status: needs-review`, so the money is not lost, it just does not count until
someone has checked it. The public page says how many rows are waiting rather
than quietly leaving them out.

### What it actually did

Run against `gemini-3.6-flash`, temperature 0, structured output, on six
messages:

```
  message : abi 250 tl yolladım montlara yazın
  read    : 250 TRY
  quote   : "250 tl"
  verdict : POSTED

  message : bugün 1.250,50 TL havale ettim, dekontu sonra atarım
  read    : 1250.5 TRY
  quote   : "1.250,50 TL"
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

Two of those are the interesting ones. "yarın bir miktar göndereceğim" is a
promise, not a donation; it produced no quote and went to review instead of
becoming a zero-lira row. And the last message names two numbers, 100 dollars
and a 3400 lira conversion the sender did in their head. The ledger got 100 USD,
which is the money that actually moved.

That run also took a `503 high demand` on its first call and recovered on the
retry, which is why both the local script and the Apps Script side wrap the call
in backoff. A shared endpoint answering "not now" is normal traffic, not a
failure to extract.

### Nothing is edited after the fact

There is no update path in `Ledger.gs`. A mistake is fixed by appending a
correction row that names the row it corrects, and the totals net the two. Both
rows stay on the record, because a ledger whose history can change quietly is
exactly what the donor was worried about.

Three more rules the code enforces rather than trusts:

- **A resent message is recorded once.** The idempotency key comes from the
  transport's own message id, so a receipt three volunteers forwarded is one row,
  and the third volunteer is not told something went wrong.
- **A donor who did not ask to be named is Anonymous on the page,** even though
  the ledger still knows who they are. A name printed on a bank receipt is not
  consent to publish it.
- **One fund holding two currencies is never added into one number.** 590 TRY
  and 40 EUR is not 630 of anything.

That last rule is there because it was a bug. The demo page is built out of the
same functions the tests exercise, and building it printed a fund total of 630
where 590 TRY and 40 EUR had been summed. It would have looked completely
plausible on the page.

### Testing Apps Script without Apps Script

Apps Script has no modules: every file shares one global scope, which is why
`Extract.gs` can call a function defined in `Ledger.gs`. Requiring the files
separately in node would hide that, so the test harness evaluates them into a
single `vm` context instead, and the tests exercise the same globals the
deployed script does.

Side effects go through a `deps` object that is a sheet in production and an
array in the tests, so all 27 tests run with no network, no spreadsheet and no
API key. The live model check is a separate script you run by hand, because
whether the model behaves is a different question from whether the ledger rules
hold.

### What it is not

Not accounting software. Not a fraud control either: it checks that a reading
matches its source, which is a different question from whether the source is
honest. And not a security boundary, since anyone who can open the sheet can
read the donor names the public page hides.

## Prize Categories

**Best use of Google AI.** Gemini does the reading, with structured output and a
response schema so the model returns the shape instead of a paragraph containing
the shape. The part I would defend is not the extraction, it is the design
around it: requiring a verbatim quote and verifying it against the source turns
"the model is usually right" into something a treasurer can act on, and the
two-pass agreement check does the same job for images, where no quote is
possible.

---

Every line of it runs in a spreadsheet a volunteer already has, which was the
point. The generous thing was never the software.
