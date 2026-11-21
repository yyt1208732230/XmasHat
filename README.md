# XmasHat

The AVR3 Xmas Hat Design Competition uses a static, build-free site and a separate Cloudflare Worker with a private D1 database.

## Publish

1. Create a dedicated D1 database. Run the schema supplied separately to the organiser in the D1 console. Keep the database ID, credentials and schema out of the repository.
2. Create a local Wrangler configuration outside the repository. Set `name` to the Worker name, `main` to the absolute path of `worker/index.mjs`, and `compatibility_date` to the deployment date. In `d1_databases`, bind the dedicated database as `DB`. Under `vars`, set `SITE_ORIGIN` to your GitHub Pages origin, for example `https://your-account.github.io` without the repository path. [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
3. Set a random, private `AUTH_SECRET` with `npx wrangler secret put AUTH_SECRET --config <config-path>`. Keep it stable so existing accounts can still log in. Deploy with `npx wrangler deploy --config <config-path>`.
4. Set the Worker’s public HTTPS URL in `docs/config.js`. Push the site to GitHub and choose the branch and `/docs` in **Settings → Pages**. [GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Run the event

- Registrations, entries and votes close at midnight at the start of 2 December 2026 in Brisbane. Set the Worker variable `CLOSES_AT` to an ISO 8601 timestamp with an offset to choose a different announcement time. The gallery stays visible and the page announces the winner at the same time.
- Each username is unique, regardless of capitalisation. One account per person is a competition rule. A signup collects a self-chosen username, display name and password.
- Votes are private to each account. The gallery shows only totals, scores and the viewer’s own reactions. Equal scores display earlier entries first. Tied leaders with votes share the win.
- To close down after the event, disable GitHub Pages and remove the dedicated Worker and D1 database. GitHub history can retain the site source. Competition data lives in D1.
