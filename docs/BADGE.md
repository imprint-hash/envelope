# CI badge

Paste this under the title in README.md:

```markdown
[![test](https://github.com/imprint-hash/envelope/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/imprint-hash/envelope/actions/workflows/test.yml)
```

- Change `?branch=main` if the default branch is different (or drop it to show the latest run on any branch).
- The workflow is `.github/workflows/test.yml`: `forge build`, offline `forge test`, the Mezo testnet fork tests
  (soft-fail, the public RPC can be flaky) and `node --test test/node/*.test.mjs`.
- Live numbers page for the README: `https://envelope.vercel.app/stats`.
