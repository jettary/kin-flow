# NEVER READ `.env.*` files
With only one exception: `.env.example` is always read, and is never committed.

# Before creating a pull request

Run the complete test suite before creating any PR: `npm run check` and
`npm run test:production`. Do not filter tests by file, test name, or the new
feature; feature-specific checks alone are not sufficient. Fix any failures
before opening the PR. If an environment limitation prevents a full run, report
the limitation explicitly and do not claim that all checks passed.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
