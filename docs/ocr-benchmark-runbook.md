# OCR benchmark runbook

The OCR scorer measures row recall, false-positive precision, canonical beer names, pint prices, tap/package availability, ABV, brewery, and explicit non-beer rejection.

## Scorer check

```bash
npm run ocr:benchmark
```

The bundled `test/fixtures/ocr-benchmark-scorer.json` is only a deterministic check that the scorer catches known failure modes. Its 100% result is not model-accuracy evidence.

## Build the labelled corpus

1. Use at least 30 menus that were not used to write prompts or patches.
2. Include mobile photos, multi-column PDFs, low contrast, wrapped names, pot/schooner/pint tables, tins/cans/bottles, rows without prices, food, wine, spirits, cocktails, headings, and venue copy.
3. Store source files outside Git if venue permission or copyright is unclear.
4. Create a manifest with `mode: "labelled_corpus"`, source paths, expected beer rows, and forbidden non-beer names. Paths are relative to the manifest.
5. Have a person label each expected name, pint price, availability, ABV, and brewery from the visible source. Do not use OCR output as the label.

Run the real model:

```bash
npm run ocr:benchmark:live -- --manifest /secure/path/labelled-corpus.json --write-results /secure/path/latest-results.json
```

Store the labelled manifest, command output, model configuration, permission record, and independent review in the private `ocr_labelled_corpus` gate manifest described in `docs/external-launch-signoffs.md`. Put only that manifest's opaque gate reference and SHA-256 in `docs/release-evidence.json`. Launch thresholds are 90% overall, 95% row recall, 98% row precision, 95% canonical names/prices/availability, and 100% rejection of explicitly labelled non-beer candidates.

Any failed case remains in admin review. Never lower thresholds to make a release pass; fix extraction or keep the affected layout manual-review only.
