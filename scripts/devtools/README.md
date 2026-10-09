# Local Development Tools

These Playwright scripts support manual UI checks and screenshot capture against a locally running `teamspace-cordis` instance. They are developer tools, not CI tests. Run them from the project root after installing dependencies and starting the relevant service.

## Scripts

- `admin-login-check.mjs` opens the admin page on the debug server, submits a login, reports the table row count, and saves a screenshot under `/tmp`.
- `composer-screenshot.mjs` opens the teamspace page, checks for the composer, and saves composer and full-page screenshots under `/tmp`.

## Parameterization TODO

- Read the target base URL and page path from command-line options or environment variables instead of fixed localhost URLs.
- Read test credentials from local environment variables; never commit credentials.
- Make the SQLite database path, username, and token selection explicit. Avoid putting tokens in URLs or printing them.
- Allow screenshot output paths and viewport/color scheme to be configured.
- Fail clearly on navigation, login, or missing database/token errors instead of silently continuing.
