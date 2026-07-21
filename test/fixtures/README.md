# Test fixtures

## `wh-reservations.json` (not present yet — add it here)

To unlock the fixture-gated Wheelhouse parser tests, save a **redacted** real
response of curl #2 from the main README (section *For developers →
"Exploring the Wheelhouse API with curl"*) into this directory as:

```
test/fixtures/wh-reservations.json
```

Redaction rules (the fixture may end up in a public repo):

- Only paste a response captured from the real Wheelhouse API — never a
  hand-written or guessed shape.
- Keep **every field name and value format** exactly as the API returned them.
- Remove or replace all personal and booking data: guest names, emails, phone
  numbers, free-text notes, external confirmation codes, and anything else
  identifying — but keep the value *format* recognizable (e.g. replace a name
  with another string, not with `null`).

Once the file exists, the tests in `test/wheelhouse.test.ts` that are gated
with `describe.skipIf` activate automatically on the next `npm test` — no test
code changes needed. Until then they are reported as skipped, which is
expected.
