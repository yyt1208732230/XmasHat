# XmasHat

The AVR3 Xmas Hat Design Competition uses a static, build-free site and a separate Cloudflare Worker with a private D1 database.

## Publish

1. Open `wrangler.jsonc` and replace `database_name` and `database_id` with the values shown on your D1 database page. This file configures a Worker entry point, the `docs` static assets, the D1 binding, and GitHub Pages CORS origin. [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
2. In Cloudflare, open Worker `xmashat` and go to **Settings → Variables and Secrets**. Add a secret named `AUTH_SECRET` with a random private value. Keep it stable so accounts can log in after later deployments. The GitHub connected Worker uses the repository's `wrangler.jsonc` on its next build.
3. In **GitHub → Settings → Pages**, choose the `main` branch and `/docs` folder. The site calls the Worker URL set in `docs/config.js`. [GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Run the event

- Registrations, entries and votes close at midnight at the start of 2 December 2026 in Brisbane. Set the Worker variable `CLOSES_AT` to an ISO 8601 timestamp with an offset to choose a different announcement time. The gallery stays visible and the page announces the winner at the same time.
- Each username is unique, regardless of capitalisation. One account per person is a competition rule. A signup collects a self-chosen username, display name and password.
- Votes are private to each account. The gallery shows only totals, scores and the viewer’s own reactions. Equal scores display earlier entries first. Tied leaders with votes share the win.
- To close down after the event, disable GitHub Pages and remove the dedicated Worker and D1 database. GitHub history can retain the site source. Competition data lives in D1.
