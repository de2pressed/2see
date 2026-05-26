# Search fixtures (VCR mode)

Set `SEARCH_FIXTURES_DIR` to this directory to replay recorded search results instead of calling live APIs.

Each file is named `{sha256-query-prefix}.json` and contains an array of `{ title, url, snippet }` objects.

Record fixtures from a successful verification run, then run:

```bash
SEARCH_FIXTURES_DIR=tests/fixtures/search npm test
```
