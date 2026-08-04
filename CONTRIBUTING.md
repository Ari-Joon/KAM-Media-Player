# Contributing

Thank you for improving KAM Media Player. Small, focused pull requests with a
clear reason and a regression test are easiest to review.

## Development

```powershell
cd "C:\Projects\Discord Media Player\activity"
npm ci
npm test
npm run build
```

For Python analyser work:

```powershell
cd "C:\Projects\Discord Media Player"
python -m pip install -r visualcore\requirements.txt
```

## Expectations

- Explain why a non-obvious fix exists in comments; do not narrate syntax.
- Keep provider-specific behaviour behind the provider interface.
- Add or update tests for behavioural changes.
- For animation tests, stub the canvas and advance `performance.now()` manually;
  an uncontrolled clock makes delta time too small for meaningful motion.
- Do not add copyrighted media, credentials, cache data, or generated builds.
- Do not describe extraction-based provider access as licensed or sanctioned.
- Run the full `npm test` command before submitting.

By contributing, you agree that your contribution is licensed under the AGPL-3.0
licence in this repository and that you have the right to submit it.
