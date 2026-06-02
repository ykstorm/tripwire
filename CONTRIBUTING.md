# Contributing to Tripwire

Thank you for your interest in contributing!

## Development setup

```bash
git clone https://github.com/ykstorm/tripwire.git
cd tripwire
npm install
```

## Workflow

1. **Create a feature branch** from `main`
2. **Make your changes** — add tests for new behavior
3. **Run the full suite** before opening a PR:

```bash
npm run typecheck  # TypeScript check
npm run lint       # ESLint
npm test           # Vitest unit tests
npm run build      # Confirm the build succeeds
```

4. **Open a PR** against `main` with a clear description

## What makes a good PR

- Small, focused changes
- Tests included for new behavior
- No breaking changes to the public API
- Related documentation updated

## Reporting issues

Please include:
- Node.js version
- Minimal reproduction (code snippet or failing test)
- What you expected vs. what happened