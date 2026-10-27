# Lantern Desk

A hosted helpdesk, run as its own "service company" website. Client websites (like the
**Trick or Commit** store) send their customers' bug reports here. Lantern Desk keeps every
ticket, sends each one to **AutoFix** (Gemma triage → Claude fix → deploy), follows it
through the pipeline, and tells the customer what happened.

```
Client website ──POST /api/v1/tickets (X-Api-Key)──► Lantern Desk ──► AutoFix /api/tickets
   or hosted form /request/<client>                       ▲               │ Gemma: LOW / MODERATE / HIGH
                                                          │               ▼
Customer ◄── tracking page /t/<id>?token=… ◄──────────────┤   Claude fix → push → CI deploy
                                                          │
Agents ◄── workspace /app (dashboard, views, replies) ◄───┘   polls AutoFix + /api/autofix/bugs/<id>/update
```

## Pages
| Path | Who | What |
|---|---|---|
| `/` | everyone | Company landing page |
| `/request/<client-slug>` | customers | Hosted "report a problem" form, up to 3 screenshots |
| `/t/<id>?token=…` | the customer | Private tracking page: progress, replies, answer AutoFix's questions |
| `/login`, `/app` | agents | Workspace: overview numbers and charts, ticket views, ticket detail, clients |

## What the workspace does
- **Overview**: open, new, waiting on customer, AutoFix working, needs a developer, fixed by AutoFix (with rate);
  median first reply / solve / AutoFix times; 14-day created-vs-solved chart; AutoFix stage counts; recent activity.
- **Views**: All open, Assigned to me, Unassigned, New, Waiting on customer, AutoFix working,
  Needs a developer, Fixed by AutoFix, Solved, All. Search, priority/category/client filters, sorting, CSV export.
  Refreshes every 10 s.
- **Ticket**: the report and screenshots, conversation, public replies and internal notes, status / priority /
  category / assignee, and an AutoFix panel (stage, risk, Gemma's summary and reasoning, guardrail, task for the agent,
  questions, commit, deploy run, agent log). Buttons: **Fix it anyway**, **Re-triage**, **Sync now**.
- **Clients**: one API key per client website (stored only as a hash, rotate any time), AutoFix on/off per client.

## How AutoFix stages change the ticket
| AutoFix stage | Helpdesk ticket | Customer sees |
|---|---|---|
| `NEW` | new | Received |
| `NEEDS_INFO` | waiting on customer | Gemma's questions; their reply re-triages automatically |
| `HUMAN` | open, internal note "needs a developer" | In review |
| `QUEUED` / `IN_PROGRESS` | open | "Our automated fixer is working on it" |
| `PUSHED` / `DEPLOYING` | open | "A fix has been committed and is being deployed" |
| `LIVE` | solved | "The fix is now live" |
| `AGENT_FAILED` / `DEPLOY_FAILED` | open, internal note | In review |

Lantern Desk polls AutoFix every `AUTOFIX_SYNC_SECONDS` and also syncs immediately when AutoFix posts to
`/api/autofix/bugs/<id>/update`.

## Run it
Needs Node 22.13+ (uses the built-in `node:sqlite`).
```bash
npm install
cp .env.example .env      # set SESSION_SECRET; set AUTOFIX_URL + AUTOFIX_SECRET to connect AutoFix
npm run seed:demo         # optional: 19 realistic demo tickets
npm start                 # http://localhost:5050
```
Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. If `DEFAULT_CLIENT_KEY` is empty, the first start
prints the Trick or Commit API key once.

### Connect AutoFix
On the AutoFix side (`autofix/.env`):
```
AUTOFIX_SECRET=<same value as the helpdesk's AUTOFIX_SECRET>
VICTORYPATH_API_URL=http://localhost:5050    # where AutoFix posts progress (this helpdesk)
```
AutoFix's status sync already posts to `/api/autofix/bugs/<id>/update`; Lantern Desk answers on that path,
so no AutoFix code changes are needed.

### Connect a client website
From the site's **backend** (keep the key server-side):
```bash
curl -X POST http://localhost:5050/api/v1/tickets \
  -H "X-Api-Key: ld_..." -H "Content-Type: application/json" \
  -d '{"email":"asha@example.com","subject":"Pay button does nothing","description":"Tapping Pay on checkout does nothing.","category":"bug","priority":"high","pageUrl":"/checkout"}'
# → 201 {"id":"LD-1021","accessToken":"…","trackingUrl":"http://localhost:5050/t/LD-1021?token=…"}
```
Fields: `email`, `subject` (5–200), `description` (10–5000) required; `name`, `category`
(bug, typo, design, feature, payment, account, other), `priority` (low, normal, high, urgent), `pageUrl`, `steps`,
`expected`, `actual`, `environment`, `externalRef`, `attachments` (≤3 images, ≤3 MB each, base64) optional.
`GET /api/v1/tickets/<id>` with the same key returns the customer-visible status and replies.

## API summary
| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/tickets` | `X-Api-Key` |
| GET | `/api/v1/tickets/:id` | `X-Api-Key` (own tickets only) |
| GET / POST | `/api/forms/:slug`, `/api/forms/:slug/tickets` | public, rate-limited, honeypot |
| GET / POST | `/api/portal/tickets/:id[...]` | ticket access token |
| POST | `/api/autofix/bugs/:id/update` | `X-AutoFix-Secret` |
| POST | `/api/auth/login`, `/api/auth/logout` | — |
| * | `/api/agent/...` | agent session cookie (client admin routes need role `admin`) |

## Tests
```bash
npm test
```
Runs the API against a fake AutoFix: intake and validation, sign-in, the full NEEDS_INFO → customer reply →
re-triage → QUEUED → PUSHED → LIVE path, developer hand-off and "fix it anyway", replies vs internal notes,
portal tokens, hosted form, stats, CSV, and per-client keys.

## Layout
| Path | What |
|---|---|
| `src/app.js` | Express app: auth, AutoFix callback, routes, pages |
| `src/db.js` | SQLite schema (agents, clients, tickets, messages, attachments) and helpers |
| `src/autofix.js` | AutoFix bridge: forward, sync loop, stage → ticket rules, approve, re-triage |
| `src/routes/intake.js` | Client API and hosted form |
| `src/routes/portal.js` | Customer tracking page API |
| `src/routes/agent.js` | Workspace API: views, ticket actions, stats, CSV, clients |
| `public/` | Pages (plain HTML/CSS/JS, no build step) |
| `scripts/seed-demo.js` | Demo tickets |
