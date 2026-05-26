# Replay verification consistency check

1. Upload `2see_test_document.pdf` and export JSON after a full run.
2. Save claims to `tests/fixtures/claims-snapshot.json`.
3. Run verification 3 times with the same claims JSON and diff verdict columns.
4. With search fixtures: `SEARCH_FIXTURES_DIR=tests/fixtures/search npm test`

Target: identical verdicts across runs and match `tests/fixtures/2see_test_document.expected.json`.
