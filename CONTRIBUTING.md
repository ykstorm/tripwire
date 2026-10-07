# Contributing to Tripwire

Thank you for your interest in contributing!

## Development setup

```bash
git clone https://github.com/ykstorm/tripwire.git
cd tripwire
npm install
```

## Workflow

1. Create a feature branch from `main`
2. Make your changes and add tests for new behavior
3. Run the full suite before opening a PR:

```bash
npm run typecheck  # TypeScript check
npm run lint       # ESLint
npm test           # Vitest unit tests
npm run build      # Confirm the build succeeds
```

4. Open a PR against `main` with a clear description

## What makes a good PR

- Small, focused changes
- Tests included for new behavior
- A change that breaks the public API needs a major version bump and a changelog entry under Changed (breaking)
- Related documentation updated

## Publishing to npm

Releases are published from CI when a `v*` tag is pushed. The publish job signs in to npm with a short-lived OIDC token from GitHub Actions (npm Trusted Publishing), so the repo holds no npm token.

One-time setup, done by a package owner on npmjs.com:

1. Open the package page for `@ykstormsorg/tripwire` and go to Settings.
2. Under Trusted Publisher, choose GitHub Actions.
3. Set the repository to `ykstorm/tripwire` and the workflow file to `publish.yml`. Use the file name only, with the extension, spelled exactly as in `.github/workflows`. Leave the environment blank.
4. Save.

The publish job has `id-token: write` permission, runs on Node 22 and installs npm 11.5.1 or newer, which npm requires for trusted publishing. npm matches the workflow file name exactly, so if the file is renamed, update the setting on npmjs.com or the publish fails.

After the first successful publish this way, delete the `NPM_TOKEN` secret from the repository (Settings, Secrets and variables, Actions) and revoke the token on npmjs.com.

## Reporting issues

Please include:
- Node.js version
- Minimal reproduction (code snippet or failing test)
- What you expected vs. what happened