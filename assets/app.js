// Content audited against expense-manager commit 9a43723 on main. Every module, stage, and
// workflow step below maps to backend source files -- see README.md.
const modules = [
  {
    id: "runtime",
    short: "Runtime",
    name: "Server runtime & process roles",
    owner: "Platform",
    purpose:
      "server.js validates configuration before anything connects, loads scheduled jobs only on the role that owns them, requires MongoDB, treats Redis as optional, and mounts ten route groups through app.js.",
    detail:
      "config/env.js refuses to start without MONGO_CONN, JWT_SECRET and REFRESH_TOKEN_SECRET (32+ characters, and different), plus CORS_ALLOWED_ORIGINS and REDIS_URL in production. PROCESS_ROLE (web | worker | all, default all) decides whether the nine cron modules are loaded. Redis gets five seconds to connect, then the server starts without it while node-redis keeps retrying.",
    stages: [
      ["Bootstrap", "dotenv", "Opt-in DNS override", "Crash reporters"],
      ["Config gate", "assertValidEnv()", "Fail fast"],
      ["Role", "PROCESS_ROLE", "9 cron modules"],
      ["Infrastructure", "MongoDB required", "Redis 5s → degrade"],
      ["HTTP", "Request ID", "Metrics", "Helmet", "CORS"],
      ["Routes", "10 groups", "97 endpoints + / + /ping"]
    ]
  },
  {
    id: "security",
    short: "Auth + sessions",
    name: "Authentication, sessions & request protection",
    owner: "Access",
    purpose:
      "Handles signup with email OTP, login, short-lived access tokens, rotating refresh sessions, CSRF on cookie endpoints, logout, logout-all, password reset, and per-request JWT + session checks.",
    detail:
      "Access JWTs carry email, _id and sid and expire after JWT_EXPIRES_IN (default 15m). Refresh tokens are opaque random values stored only as HMAC hashes in RefreshSession (default 30 days) and sent as the httpOnly balensia_refresh cookie. Reusing a revoked or mismatched refresh token revokes every session the user has.",
    stages: [
      ["Limits", "authLimiter (IP)", "Identity limiters (email)"],
      ["Input", "Joi validation"],
      ["Identity", "bcrypt (cost 10)", "SHA-256 OTP hash"],
      ["Session", "RefreshSession", "15m JWT + sid"],
      ["Cookies", "balensia_refresh", "balensia_csrf"],
      ["Each request", "Bearer JWT", "sid still active", "req.userId"]
    ]
  },
  {
    id: "expenses",
    short: "Expenses",
    name: "Expense lifecycle & write reliability",
    owner: "Core finance",
    purpose:
      "Creates, edits and deletes expenses with server-side category normalization, client-id idempotency, optional ML descriptions, ML feedback capture, and durable post-write synchronization.",
    detail:
      "Each write reserves PendingSync intent first, commits the expense, clears the user's caches, then calls synchronizeAfterMutation(): confirm → recalculate affected budget months → regenerate the report, all fenced by a revision. If any step fails, the expense stays committed and GET /report, budgets and charts repair the pending work later on read.",
    stages: [
      ["Guard", "JWT", "Joi expense validation"],
      ["Idempotency", "{userId, id} unique", "Replay or 409"],
      ["Enrich", "ML description (5s)", "Feedback derivation"],
      ["Reserve", "PendingSync token"],
      ["Commit", "Expense document"],
      ["Sync", "Budget months", "Report", "Category alerts"]
    ]
  },
  {
    id: "reads",
    short: "Reads + search",
    name: "Expense reads, search & pagination",
    owner: "Query API",
    purpose:
      "Serves the last-week and by-category views from a short Redis cache, plus a filtered, cursor-paginated search over any date range of up to 366 days.",
    detail:
      "Search filters (name contains, category, amount range, recurring) are AND-combined and paged with an opaque (expenseDate, _id) keyset cursor. The default page is 50 and the maximum is 200, so the HTTP list endpoint has no unbounded path. Analytics still uses the unbounded range fetch on purpose, because truncated input would produce wrong totals.",
    stages: [
      ["Cached views", "lastWeek:<user>", "category:<user>:<period>"],
      ["Window", "42 days loaded once", "7 vs previous 7"],
      ["Search", "Joi filters", "≤ 366-day span"],
      ["Keyset", "expenseDate DESC", "_id DESC"],
      ["Page", "limit 50 (max 200)", "nextCursor"],
      ["Shape", "Recurring flag", "*Minor fields"]
    ]
  },
  {
    id: "budget-income",
    short: "Budget + income",
    name: "Budgets, category budgets & income",
    owner: "Finance",
    purpose:
      "Maintains one monthly total budget per user, optional per-category allocations with alerts, and income records with month or Indian-financial-year insights.",
    detail:
      "A total budget's spent value is always rebuilt from expense aggregation. Category budgets are stored in integer paise, recompute spend on every read, and must not push allocations above the total budget. Alerts fire at most once per level (above 90% and above 100%) and never show amounts.",
    stages: [
      ["Total budget", "'MMM YYYY' key", "Spent = Σ expenses"],
      ["Category budget", "'YYYY-MM' key", "amountMinor", "≤ 25 / month"],
      ["Alerts", "Critical > 90%", "Overspent > 100%"],
      ["Income", "Client-id idempotency", "Cursor pages"],
      ["Insights", "current_month", "financial_year (Apr–Mar)"],
      ["Cards", "Runway", "Savings rate", "Source dependency"]
    ]
  },
  {
    id: "recurring",
    short: "Recurring",
    name: "Recurring expense automation",
    owner: "Background finance",
    purpose:
      "Turns an expense into a monthly template that can be listed, paused, resumed, ended, skipped for one occurrence, edited, and projected forward, and logs each due occurrence automatically.",
    detail:
      "Each user mutation must send the template's scheduleVersion. The update matches {_id, userId, status, scheduleVersion} and increments the version, so a stale screen gets a 409 instead of overwriting newer state. The cron derives occurrence IDs as SHA-256(templateId:dueDate), and the unique {userId, id} index on expenses turns a duplicate run into a harmless replay.",
    stages: [
      ["Opt in", "PATCH /api/recurring", "Due 1st of next month (UTC)"],
      ["Lifecycle", "active / paused / ended", "scheduleVersion CAS"],
      ["Skip", "skippedDates", "APP_TIME_ZONE"],
      ["Project", "GET /recurring/upcoming", "≤ 366-day window"],
      ["Cron", "20:30 daily", "Redis lease"],
      ["Log", "Deterministic ID", "Sync", "Notify + push"]
    ]
  },
  {
    id: "charts",
    short: "Charts",
    name: "Chart aggregation engine",
    owner: "Analytics API",
    purpose:
      "Produces weekly, monthly, yearly, multi-year, logged-year, category-total, budget-vs-spent and pie datasets for the dashboard charts.",
    detail:
      "Only the two pie endpoints are cached (5 minutes, tracked in the user's key set). Every other chart reads MongoDB on each request. Budget comparison reads stored budget documents, which can run pending sync repair first.",
    stages: [
      ["Filters", "Year", "Month", "Years list", "Type"],
      ["Range", "Server-local calendar bounds"],
      ["Query", "User expenses", "Budget documents"],
      ["Aggregate", "Week / month / year", "Category totals"],
      ["Cache (pie only)", "pie:*", "pieComparison:*", "300s"],
      ["Response", "Chart-ready arrays"]
    ]
  },
  {
    id: "reports",
    short: "Reports",
    name: "Financial report & analytics engine",
    owner: "Analytics engine",
    purpose:
      "Builds one versioned financial report per user from deterministic analyzers: spending, budget, category, trend, habit, anomaly, health, two statistical forecasts, and four insight analyzers.",
    detail:
      "The report is regenerated after every financial write, fenced by a PendingSync revision, and cached in Redis through a compare-and-set that refuses older revisions. Reports below contract version 10 are rebuilt. The forecast is plain statistics (robust Theil–Sen trend, ROBUST_TREND_MEDIAN_V2), not an ML model.",
    stages: [
      ["Context", "5 parallel reads", "+ recurring templates"],
      ["Analyzers", "Spending", "Budget", "Category", "Trend", "Habit"],
      ["Signals", "Anomalies", "Insights"],
      ["Health", "6 weighted modules", "Low → Critical risk"],
      ["Forecast", "Robust trend", "Current month estimate"],
      ["Store", "FinancialReport (v10)", "report:<user> 1h"]
    ]
  },
  {
    id: "receipts",
    short: "Receipts",
    name: "Receipt OCR, inbox & duplicates",
    owner: "Document processing",
    purpose:
      "Accepts a JPEG or PNG receipt, verifies its real content, preprocesses and OCRs it in memory, persists the image and parsed draft, and lets the user review, link, unlink, delete and de-duplicate receipts.",
    detail:
      "Uploads never touch disk. Multer holds them in memory (5 MB, one file). Magic bytes, declared MIME and sharp's format must all agree, within 10,000 px per side, 20 MP and one page. Originals are stored in the MongoDB GridFS bucket 'receipts'. Unlinked receipts are swept after 90 days. Provides smart expense window search (+/- 7 days) and candidate duplicate triage.",
    stages: [
      ["Upload", "receiptLimiter 12/15m", "Memory, 5 MB"],
      ["Verify", "Magic bytes", "MIME = sniffed", "≤ 20 MP"],
      ["Preprocess", "Rotate", "Fit 1500px", "Grayscale", "Sharpen"],
      ["OCR", "tesseract.js eng", "30s × 2 attempts"],
      ["Parse", "Merchant", "Total", "Date", "Confidence"],
      ["Persist & triage", "Receipt doc", "GridFS image", "Duplicate triage", "Audit log"]
    ]
  },
  {
    id: "sia",
    short: "SIA + AI",
    name: "SIA assistant & AI features",
    owner: "Intelligence",
    purpose:
      "Answers financial questions from a server-built snapshot, keeps bounded conversation sessions, transcribes voice, generates an optional monthly AI summary, and parses free text into an expense suggestion.",
    detail:
      "SIA is ready only when SIA_ENABLED=true and the provider (openai, gemini or groq), model and that provider's API key are set. Each feature has its own per-user limiter, and an output-token cap, a context-size cap and a circuit breaker apply. SIA never writes financial data: parse-expense returns a suggestion that the user submits through the normal Add Expense path.",
    stages: [
      ["Gate", "Readiness", "Per-user opt-out"],
      ["Scope", "Prohibited-phrase filter", "Idempotency"],
      ["Grounding", "Report snapshot", "Income aggregates"],
      ["Provider", "askLlm()", "Circuit breaker"],
      ["Validate", "Format + ID checks", "Fallback messages"],
      ["Persist", "SiaSession", "SiaMessage", "SiaRequest 24h"]
    ]
  },
  {
    id: "notifications",
    short: "Notifications",
    name: "Device tokens, preferences & push delivery",
    owner: "Engagement",
    purpose:
      "Registers web or mobile FCM tokens, applies per-type and quiet-hours preferences, sends privacy-safe payloads, removes dead tokens, retries failures, and sweeps stale devices.",
    detail:
      "There are three notification types: recurring-expense, recurring-expense-ended and category-budget-alert. Generic previews contain no names or amounts, and payloads never carry a userId, amount or expense ID. A notification blocked by type or quiet hours is marked suppressed and never retried. Firebase is optional, so without FIREBASE_SERVICE_ACCOUNT push is disabled.",
    stages: [
      ["Register", "web / mobile", "Unique token"],
      ["Preferences", "Per type", "Quiet hours", "Preview"],
      ["Record", "Notification row"],
      ["Deliver", "Firebase Admin", "Platform payload"],
      ["Maintain", "Delete invalid tokens", "90-day sweep"],
      ["Retry", "Every 15 min", "3 attempts total"]
    ]
  },
  {
    id: "data-rights",
    short: "Data rights",
    name: "Export, CSV import & account deletion",
    owner: "Data portability",
    purpose:
      "Lets users export expenses, income or budgets as CSV or JSON, import transactions from CSV through a reviewed session, and delete their account after a 14-day grace period.",
    detail:
      "Exports under 5,000 rows persist an ExportRequest record (ready status) and download immediately or can be re-downloaded/deleted on demand. Larger ones (up to 200,000) are queued, generated by a worker cron, and served by a download token for 24 hours. Mandatory start and end date ranges prevent unbounded full-table dumps. DELETE /api/export/:id purges artifacts on demand. CSV imports (2 MB, 5,000 rows) are previewed, decided row by row, and committed exactly once using import:<session>:<row> idempotency keys.",
    stages: [
      ["Export", "Sync < 5k rows", "Queued ≥ 5k", "Mandatory dates", "DELETE :id on demand"],
      ["Generate", "Cron every 2 min", "Token 24h"],
      ["Import", "Headers", "Mapping", "Row decisions"],
      ["Commit", "Idempotent rows", "Same sync path"],
      ["Delete account", "Password re-auth", "14-day grace"],
      ["Purge", "Tier A now", "Tier B at 03:00"]
    ]
  },
  {
    id: "ml",
    short: "ML bridge",
    name: "ML prediction, merchant rules & retraining bridge",
    owner: "Intelligence integration",
    purpose:
      "Applies the user's saved merchant rule before any model call, proxies category prediction and description generation to the ML service, records feedback outcomes, and triggers retraining.",
    detail:
      "The backend never trains models. It calls the ML service's /predict-category, /generate-description and /retrain-model with X-ML-Operations-Token and the request ID, and records each call's outcome and latency as metrics. Feedback is labelled accepted, corrected, viewed or abstained, and only genuine corrections become pending training examples.",
    stages: [
      ["Rule first", "MerchantCategoryRule", "confidence 1"],
      ["Predict", "POST proxy", "5s timeout"],
      ["Abstention", "abstained", "abstentionReason"],
      ["Feedback", "Outcome label", "pending if corrected"],
      ["Threshold", "≥ 100 pending", "Daily 20:30"],
      ["Trigger", "/retrain-model", "existingRun ok"]
    ]
  },
  {
    id: "cache-data",
    short: "Data + cache",
    name: "Persistence, caching & job leases",
    owner: "Infrastructure",
    purpose:
      "Uses 23 Mongoose models plus GridFS for durable data, Redis for disposable read caches and cross-instance job leases, and PendingSync for crash-safe derived data.",
    detail:
      "Cache keys are tracked in a per-user set (cachekeys:<userId>), so one mutation clears every variant without a wildcard scan. Every cache call swallows Redis errors and falls through to MongoDB. Job leases use SET NX PX with an ownership-checked Lua renew and release. Each job is configured as fail-open or fail-closed for when Redis is unreachable.",
    stages: [
      ["Core models", "users", "expenses", "incomes", "budget", "mlFeedback"],
      ["Feature models", "18 in models/", "GridFS receipts"],
      ["Reliability", "PendingSync", "Revision fencing"],
      ["Redis cache", "5m views", "1h report (CAS)"],
      ["Invalidation", "cachekeys:<user> set"],
      ["Leases", "job-lease:<job>", "Fail open / closed"]
    ]
  },
  {
    id: "ops",
    short: "Ops + quality",
    name: "Observability, migrations, backups & CI",
    owner: "Delivery & operations",
    purpose:
      "Emits structured JSON logs with request IDs, aggregates metrics and alerts, runs versioned migrations with a lock and ledger, takes encrypted backups, and gates every change through CI.",
    detail:
      "CI runs frontend, backend unit (262 Jest files), backend integration on real mongo:7 + redis:7 including a migration dry-run and apply, Playwright e2e, a deployment smoke test, ML pytest, dependency audits and gitleaks. Safe error formatting sanitizes error codes and syscalls without leaking credentials. A final ci-required job fails unless every one of them succeeds.",
    stages: [
      ["Logs", "JSON lines", "X-Request-ID"],
      ["Metrics", "5-min snapshots", "Error / latency alerts"],
      ["Errors", "Redacted reporter", "No-op by default"],
      ["Migrations", "Ledger + lock", "Dry run", "Forward-fix"],
      ["Backups", "mongodump", "AES-256-CBC", "Restore drill"],
      ["CI", "9 jobs", "262 test suites", "ci-required"]
    ]
  }
];

const workflows = [
  {
    id: "signup",
    category: "Authentication",
    name: "Signup and OTP verification",
    purpose: "Creates a verified account without storing the OTP or password in plaintext.",
    steps: [
      ["Limit and validate", "authLimiter (60/15 min per IP), Joi (name 4–50, password 8–72 bytes), then otpIssueLimiter (5/15 min per email)."],
      ["Resolve the account", "A verified email returns 409; an existing unverified record is overwritten in place."],
      ["Protect secrets", "The password is bcrypt-hashed (cost 10); a crypto.randomInt six-digit OTP is stored as a SHA-256 hash."],
      ["Set expiries", "The OTP expires in 5 minutes; an unverified account is auto-deleted 10 minutes after its latest OTP (TTL index)."],
      ["Send the code", "Brevo emails the OTP; if sending fails the OTP fields are cleared and signup returns 503."],
      ["Verify", "otpVerifyLimiter (8/15 min) runs, then the hash is compared timing-safely after the expiry check."],
      ["Activate", "A guarded update sets isVerified and clears OTP fields; no session is issued until login."]
    ]
  },
  {
    id: "login",
    category: "Authentication",
    name: "Login and protected request",
    purpose: "Turns valid credentials into a short-lived access token plus a rotating refresh session.",
    steps: [
      ["Limit and validate", "authLimiter, Joi, then loginLimiter (10/15 min per normalized email)."],
      ["Compare credentials", "bcrypt compares the password, against a dummy hash when the email is unknown."],
      ["Answer uniformly", "Unknown email, wrong password and unverified account all return the same 401 INVALID_CREDENTIALS."],
      ["Open a session", "A RefreshSession stores HMAC hashes of a new refresh token and CSRF token."],
      ["Issue tokens", "The body returns a JWT {email, _id, sid} that expires in 15m by default; balensia_refresh (httpOnly) and balensia_csrf cookies are set."],
      ["Verify each request", "Auth middleware checks the Bearer JWT, then confirms its sid is still an active, unrevoked session."],
      ["Scope the query", "Controllers include req.userId in every read and write of account data."]
    ]
  },
  {
    id: "refresh",
    category: "Authentication",
    name: "Refresh rotation and logout",
    purpose: "Rotates the refresh session on every use and detects reuse of an old token.",
    steps: [
      ["Check CSRF", "sessionCsrf requires the balensia_csrf cookie to equal the X-CSRF-Token header, else 403."],
      ["Find the session", "The refresh cookie is HMAC-hashed and looked up in RefreshSession."],
      ["Detect reuse", "A revoked, expired or CSRF-mismatched session revokes every session the user has and returns 401."],
      ["Rotate", "A replacement session is created and the old one is revoked under a guard; a lost race revokes only its own replacement."],
      ["Reissue", "Both cookies rotate and a new JWT with the new sid is returned, so the previous JWT stops working at once."],
      ["Log out", "/logout revokes the current session; /logout-all (Bearer token) revokes all sessions and clears the cookies."]
    ]
  },
  {
    id: "password-reset",
    category: "Authentication",
    name: "Password reset",
    purpose: "Uses an emailed OTP to grant a ten-minute reset authorization, then revokes every session.",
    steps: [
      ["Request a reset", "Unknown or unverified emails, and requests within the 120-second cooldown, all get the same generic 202."],
      ["Send the OTP", "A hashed OTP with a 5-minute expiry is stored and emailed; isPasswordReset is set."],
      ["Exchange the OTP", "verify-otp consumes the OTP atomically and returns a 43-character reset token valid for 10 minutes."],
      ["Submit the password", "passwordResetLimiter runs; a guarded update matching the token hash writes the new bcrypt hash."],
      ["Reject stale tokens", "A missing, wrong or expired authorization returns 403 INVALID_RESET_AUTHORIZATION."],
      ["Revoke sessions", "Every refresh session is revoked; the user must log in again."]
    ]
  },
  {
    id: "account-deletion",
    category: "Authentication",
    name: "Account deletion lifecycle",
    purpose: "Deletes an account only after password re-authentication and a 14-day grace period.",
    steps: [
      ["Re-authenticate", "POST /auth/request-deletion needs a Bearer token and the current password (bcrypt re-check)."],
      ["Schedule the purge", "deletionRequestedAt and deletionScheduledPurgeAt (now + 14 days) are set; a second request returns 409."],
      ["Run Tier A now", "All sessions are revoked, device tokens deleted and Redis caches cleared (best effort)."],
      ["Grace period", "The recurring cron skips the user; after logging in again they can cancel or check status."],
      ["Daily purge", "accountDeletionJob runs at 03:00 under a fail-closed Redis lease and picks users past their purge date."],
      ["Run Tier B", "Expenses, income, budgets, category budgets, rules, recurring templates, receipts + GridFS images, ML feedback, notifications, PendingSync, report and SIA history are deleted."],
      ["Remove the user", "The user document is deleted last; a failed step stops and retries the next day."]
    ]
  },
  {
    id: "expense-add",
    category: "Expenses",
    name: "Add expense",
    purpose: "Commits a transaction exactly once and keeps budget and report state in step with it.",
    steps: [
      ["Guard the route", "verifyToken and Joi expenseValidation run; the category is normalized or rejected with 400."],
      ["Check idempotency", "A client-supplied id is looked up under {userId, id}: same payload → 201 replay, different payload → 409."],
      ["Fill the description", "When none is given, the ML service's /generate-description is called with a 5s timeout; failure leaves it empty."],
      ["Record ML feedback", "The predicted and saved categories are compared on the server; a genuine correction is stored as pending."],
      ["Reserve sync work", "PendingSync records owned tokens for the budget month and the report before the write."],
      ["Commit", "The expense is saved; a concurrent duplicate (E11000) becomes a replay or 409."],
      ["Clear caches", "Every key in cachekeys:<userId> is deleted."],
      ["Synchronize", "Confirm → recalculate the month's spent → regenerate the report → evaluate category alerts."],
      ["Return 201", "The response includes derivedData; if sync is pending, the expense still counts as saved."]
    ]
  },
  {
    id: "expense-edit",
    category: "Expenses",
    name: "Edit or delete expense",
    purpose: "Changes only an owned expense and repairs every affected budget month.",
    steps: [
      ["Validate the ID", "Malformed ObjectIds return 400 before any lookup."],
      ["Enforce ownership", "The record is fetched with both _id and userId; otherwise 404."],
      ["Restrict fields", "Edits accept only name, category, amount, date and description, with category and amount re-validated."],
      ["Reserve user-wide", "A month-agnostic PendingSync reservation plus a report reservation is written first."],
      ["Write", "findOneAndUpdate or findOneAndDelete runs, again scoped to the user."],
      ["Pick the months", "Budget work runs when amount or date changed; a cross-month move recalculates both months."],
      ["Synchronize", "Caches are cleared, then budget months, report and category alerts are synced."]
    ]
  },
  {
    id: "expense-read",
    category: "Expenses",
    name: "Cached last-week read",
    purpose: "Returns this week, last week and six weekly buckets from one query and a five-minute cache.",
    steps: [
      ["Check Redis", "lastWeek:<userId> is returned immediately on a hit."],
      ["Load the user", "On a miss, the account is confirmed in MongoDB."],
      ["Fetch once", "All expenses from the last 42 days are loaded in one query."],
      ["Split windows", "The last 7 days and the 7 before are filtered out and sorted newest first."],
      ["Bucket weeks", "The 42-day range is grouped into weekly buckets."],
      ["Cache for 5 minutes", "The response is stored and its key added to cachekeys:<userId>."]
    ]
  },
  {
    id: "expense-search",
    category: "Expenses",
    name: "Search with cursor pagination",
    purpose: "Finds expenses by date range and filters without ever returning an unbounded list.",
    steps: [
      ["Validate", "startDate and endDate are required, at most 366 days apart; minAmount must not exceed maxAmount."],
      ["Build the filter", "userId + date range, then optional nameContains (escaped regex), category, amount range and isRecurring."],
      ["Resolve the page", "limit defaults to 50 (1–200); the cursor decodes to {date, _id}."],
      ["Keyset query", "Sorted by expenseDate and _id descending, fetching limit + 1 to detect more pages."],
      ["Annotate", "Recurring state and *Minor money fields are added to each row."],
      ["Return", "data, hasMore and nextCursor; search results are not cached."]
    ]
  },
  {
    id: "budget",
    category: "Finance",
    name: "Set or update monthly budget",
    purpose: "Stores a monthly limit while always deriving spent from real expenses.",
    steps: [
      ["Validate", "The budget must be a finite, non-negative number."],
      ["Resolve the month", "The current server-local month becomes a key such as 'Oct 2026'."],
      ["Reserve", "A PendingSync reservation is written before the write."],
      ["Upsert", "Only the budget field of the unique {userId, month} document is set."],
      ["Clear caches", "Every tracked expense/pie key for the user is removed."],
      ["Synchronize", "spent is recalculated from expenses and the report is regenerated (revision-fenced)."],
      ["Evaluate alerts", "Category budget alerts are checked for the current month."]
    ]
  },
  {
    id: "category-budget",
    category: "Finance",
    name: "Category budget and alerts",
    purpose: "Adds optional per-category limits that never exceed the total budget.",
    steps: [
      ["Validate", "The month must be the current one or up to 11 ahead; category ≤ 50 chars and not 'Uncategorized'; amount > 0, ≤ 1e9, 2 decimals."],
      ["Store in paise", "The amount is saved as integer amountMinor."],
      ["Enforce limits", "At most 25 categories per month, and increases cannot push the sum above the total budget."],
      ["Upsert and re-check", "An atomic upsert, then a re-sum; going over the total rolls back with 409."],
      ["Compute spend on read", "Category spend is aggregated from expenses each time, never stored."],
      ["Alert after writes", "Later expense writes claim alert level 1 (> 90%) or 2 (> 100%) atomically before sending a category-budget-alert."]
    ]
  },
  {
    id: "income",
    category: "Finance",
    name: "Income insights",
    purpose: "Combines income and spending for the current month or the Indian financial year.",
    steps: [
      ["Select the period", "current_month or financial_year (1 April – 1 April) becomes half-open server-local bounds."],
      ["Load both sides", "Income and expense records are fetched concurrently for the user."],
      ["Build the header", "Total income, total expenses, balance, record count and top source."],
      ["Estimate runway", "Remaining balance ÷ average daily spend over the days tracked so far; zero when spending exceeds income."],
      ["Band the savings rate", "Deficit, Excellent ≥ 50%, Good ≥ 30%, Moderate ≥ 10%, otherwise Needs Attention."],
      ["Measure dependency", "Income is grouped by source: Single Income Source, High (≥ 80%), Moderate (≥ 50%) or Diversified."]
    ]
  },
  {
    id: "recurring-lifecycle",
    category: "Recurring",
    name: "Manage a recurring template",
    purpose: "Changes a template safely even when two screens or the cron touch it at once.",
    steps: [
      ["Mark recurring", "PATCH /api/recurring creates the template once ($setOnInsert), due on the 1st of next month at 00:00 UTC."],
      ["Send the version", "Pause, resume, end, skip and edit all require the current scheduleVersion."],
      ["Check state", "Ended templates return 409; pause needs active, resume needs paused, skip needs active."],
      ["Compare-and-set", "One update matches {_id, userId, status, scheduleVersion} and increments the version; a mismatch returns 409 with the current record."],
      ["Skip one occurrence", "A YYYY-MM-DD date is added to skippedDates; skipping the current due date advances nextDueDate."],
      ["Edit", "Name, category, amount, next due date and end date change the template only, never past expenses."],
      ["Project", "GET /recurring/upcoming lists active occurrences in a window (default −1 to +92 days, max 366), honoring skips and end dates."]
    ]
  },
  {
    id: "recurring",
    category: "Recurring",
    name: "Recurring auto-log cron",
    purpose: "Logs each due occurrence exactly once and propagates it like a manual expense.",
    steps: [
      ["Acquire the lease", "At 20:30 server time, recurringJob takes a 10-minute Redis lease (fail-open if Redis is down)."],
      ["Select due templates", "Active templates with nextDueDate ≤ now are selected, skipping users pending deletion."],
      ["Handle end and skip", "Past endDate → ended + notification; a skipped date → advance and remove the skip, with no expense."],
      ["Derive the ID", "occurrenceId = SHA-256(templateId:dueDate), reserved in PendingSync."],
      ["Insert the expense", "The expense is created; a duplicate key is treated as a replay (sync only, no notification)."],
      ["Advance the schedule", "nextDueDate moves one month forward, matching the original value."],
      ["Propagate", "Caches are cleared, then budget, report and alerts are synced."],
      ["Notify", "A recurring-expense notification is stored and pushed; failures are marked failed for retry."]
    ]
  },
  {
    id: "report",
    category: "Analytics",
    name: "Get or generate the financial report",
    purpose: "Serves a fresh enough report quickly and repairs missed sync work first.",
    steps: [
      ["Repair if pending", "repairIfPending runs; if the report may still be stale it is refreshed, or 503 recoveryPending is returned."],
      ["Check Redis", "report:<userId> is used when its revision is fresh and its version is ≥ 10."],
      ["Check MongoDB", "A fresh, current FinancialReport is served and re-cached."],
      ["Generate", "Five parallel reads plus recurring templates feed the analyzers."],
      ["Score health", "Six weighted modules (budget 25, habit 20, spending/trend/category 15, stability 10), with null modules dropped and weights renormalized."],
      ["Forecast", "A robust Theil–Sen trend over up to 12 completed months, plus a current-month estimate."],
      ["Persist and cache", "A conditional write to FinancialReport, then a revision compare-and-set into Redis (1 hour)."]
    ]
  },
  {
    id: "charts",
    category: "Analytics",
    name: "Chart aggregation",
    purpose: "Turns user expenses and budgets into visualization-ready arrays.",
    steps: [
      ["Verify the JWT", "All nine /chart routes are protected."],
      ["Resolve the range", "Month, year, multi-year or all-time bounds in server-local time."],
      ["Query MongoDB", "Expense queries always include the user; budget comparison reads stored budget documents."],
      ["Aggregate", "Monday-start weeks, month totals, month × year grids, year totals, category totals."],
      ["Cache pies only", "pie:<user>:<year|month>:<type> and pieComparison:<user>:<MMM YYYY> for 300 seconds."],
      ["Return arrays", "Controllers emit arrays shaped for line, bar and pie charts."]
    ]
  },
  {
    id: "bill",
    category: "Receipts",
    name: "Receipt upload to draft",
    purpose: "Turns one verified image into a stored receipt and an editable draft, without creating an expense.",
    steps: [
      ["Limit the upload", "verifyToken → receiptLimiter (12/15 min) → Multer in memory (one JPEG/PNG, 5 MB) with 413/415 mapping."],
      ["Verify content", "Magic bytes, declared MIME and sharp's format must agree, within 10,000 px per side, 20 MP and one page."],
      ["Preprocess", "Rotate by EXIF, fit inside 1500 px, grayscale, normalize, sharpen, PNG."],
      ["Recognize text", "A fresh tesseract.js 'eng' worker per attempt: 30s timeout, 2 attempts, timeouts not retried."],
      ["Parse fields", "Merchant (first two words), total (grand/total patterns), date, confidences and review reasons."],
      ["Persist", "The original goes to GridFS; the Receipt document stores fields, content hash and duplicate signature."],
      ["Respond", "200 {parsedReceipt, receiptId}, 504 on timeout, 422 on OCR failure; each outcome is audit-logged."]
    ]
  },
  {
    id: "receipt-inbox",
    category: "Receipts",
    name: "Receipt inbox and duplicates",
    purpose: "Reviews stored receipts and flags likely duplicates without exposing other users' data.",
    steps: [
      ["List", "Newest first, filterable by review status and linked state; another user's receipt returns 404."],
      ["Stream the image", "GET /receipts/:id/image streams from GridFS."],
      ["Link or unlink", "Links only to the user's own expense; unlink clears the link."],
      ["Mark reviewed", "Optional name, amount and date corrections are merged and reviewedAt is set."],
      ["Find duplicates", "On demand: exact = same content hash; probable = same merchant, date and amount in cents."],
      ["Record a decision", "confirmed_new or linked_existing, audit-logged."],
      ["Retention", "At 06:00, unlinked receipts older than 90 days lose their image and then their document."]
    ]
  },
  {
    id: "sia-ask",
    category: "SIA & AI",
    name: "Ask SIA a question",
    purpose: "Answers from the user's own computed figures, within a fixed scope.",
    steps: [
      ["Check readiness", "SIA_ENABLED, a supported provider, a model and its API key are required; otherwise 503."],
      ["Check opt-out", "A user who turned SIA off gets 403 (a lookup error fails open)."],
      ["Validate", "Question ≤ 500 chars; optional clientMessageId (idempotency) and sessionId (must be owned)."],
      ["Apply the scope gate", "Regex rules return 422 for data changes, exports, investment/tax/legal advice, off-topic and injection attempts."],
      ["Build the snapshot", "Report sections plus Mongo income aggregates, with names, descriptions, dates and IDs stripped and sizes capped."],
      ["Call the provider", "askLlm sends the system prompt, up to 6 earlier messages and the snapshot, with one retry on 429/5xx and a circuit breaker."],
      ["Validate the answer", "Empty, oversized, ObjectId-shaped or internal-field answers are rejected with 503."],
      ["Persist", "The session and messages are saved, the idempotency record completed, and {answer, grounding, sessionId} returned."]
    ]
  },
  {
    id: "parse-expense",
    category: "SIA & AI",
    name: "Natural-language expense entry",
    purpose: "Turns a sentence into an Add Expense suggestion that the user reviews and submits.",
    steps: [
      ["Gate", "Same readiness and opt-out checks as /ask, plus expenseParseLimiter (20/15 min)."],
      ["Validate", "text is required and at most 200 characters."],
      ["Call the LLM once", "A strict schema (outcome, amount, name, category, date, description) with today's date in APP_TIME_ZONE."],
      ["Reject the unusable", "Unsupported, malformed or ≤ 0 amounts → 200 {success:false, COULD_NOT_PARSE}."],
      ["Resolve the category", "The user's merchant rule, then the LLM's normalized guess, otherwise empty."],
      ["Flag review", "Missing date, category or name sets needsReview, with per-field confidence."],
      ["Return a suggestion", "Nothing is written; the frontend pre-fills Add Expense."]
    ]
  },
  {
    id: "monthly-summary",
    category: "SIA & AI",
    name: "Optional monthly AI summary",
    purpose: "Narrates only verified report facts, with a deterministic template as the fallback.",
    steps: [
      ["Check opt-in and cap", "Not opted in → 403; at or above the monthly cap (default 5) → 429; otherwise the count is incremented."],
      ["Load facts", "The report is read and a whitelist of eligible report facts is extracted."],
      ["Build the template", "A deterministic summary is built from those facts first."],
      ["Try the LLM", "When SIA and a provider are configured, the model gets only {factId, label, unit, value} items and must cite fact IDs."],
      ["Validate numbers", "Every currency amount and percentage must equal a cited fact; advice, fraud or certainty wording is rejected."],
      ["Return", "source 'llm' with cited facts, or source 'template' with a reason code; nothing is stored."]
    ]
  },
  {
    id: "voice",
    category: "SIA & AI",
    name: "Voice transcription",
    purpose: "Converts a short recording to text for the SIA input box.",
    steps: [
      ["Gate", "siaVoiceLimiter (15/15 min) and voice readiness: SIA_VOICE_ENABLED, provider groq, GROQ_API_KEY."],
      ["Accept audio", "Multer in memory, one file up to 5 MiB; oversize → 413."],
      ["Check hints", "languageHint must be letters and hyphens (≤ 10); a duration hint over 45s → 422."],
      ["Sniff the container", "First bytes must be WebM, Ogg, WAV or MP4; otherwise 415."],
      ["Transcribe", "Groq whisper-large-v3-turbo, 30s timeout, aborted if the client disconnects."],
      ["Return", "{transcript, detectedLanguage, durationMs}; nothing is stored."]
    ]
  },
  {
    id: "push-retry",
    category: "Notifications",
    name: "Push delivery and retry",
    purpose: "Delivers notifications respecting preferences, and retries real failures.",
    steps: [
      ["Gate by preference", "A disabled type or active quiet hours marks the notification suppressed (final)."],
      ["Load devices", "All of the user's web and mobile tokens; none, or no Firebase → failure."],
      ["Build payloads", "Mobile: notification + Android + data {route, tag}; web: data only. Generic previews hide names and amounts."],
      ["Send", "Firebase Admin sends per device; invalid or unregistered tokens are deleted."],
      ["Schedule a retry", "A failed send sets retryCount 1 and a retry 5 minutes out."],
      ["Retry every 15 min", "retryPush (fail-closed lease) claims failed rows with retryCount < 3 and resends."],
      ["Sweep stale devices", "At 04:00, tokens not updated for 90 days are deleted."]
    ]
  },
  {
    id: "export",
    category: "Data rights",
    name: "Financial data export",
    purpose: "Exports a user's own data immediately or through a queued job.",
    steps: [
      ["Validate", "Domain expenses, income, budgets or all (all must be JSON); format CSV or JSON."],
      ["Count rows", "More than 200,000 rows is rejected."],
      ["Small export", "Under 5,000 rows, the file is generated and returned in the same response."],
      ["Queue", "Otherwise an ExportRequest is created with a random download token (status queued)."],
      ["Generate", "Every 2 minutes, exportGeneration (fail-closed lease) writes the file to backend/generated-exports and marks it ready for 24 hours."],
      ["Download", "GET /api/export/download/:token checks owner, ready state and expiry; every failure is a uniform 404."],
      ["Clean up", "At 05:00, expired files are deleted and requests marked expired."]
    ]
  },
  {
    id: "import",
    category: "Data rights",
    name: "CSV transaction import",
    purpose: "Brings external transactions in through a reviewed, idempotent session.",
    steps: [
      ["Preview headers", "One CSV up to 2 MB is parsed for its header row."],
      ["Create a session", "A column mapping to date, amount, merchant and category builds an ImportSession (≤ 5,000 rows)."],
      ["Suggest", "Each complete row gets a possible duplicate expense and a merchant-rule category suggestion."],
      ["Decide rows", "The user marks each row pending, accept or skip."],
      ["Commit once", "The session moves previewing → committing; accepted rows insert with id import:<session>:<row>."],
      ["Synchronize", "Caches are cleared and budget/report sync runs, as for a manual expense."],
      ["Expire", "At 07:00, previewing or committing sessions older than 24 hours are marked expired."]
    ]
  },
  {
    id: "predict",
    category: "ML lifecycle",
    name: "Category prediction",
    purpose: "Suggests a category, preferring the user's own rules over the model.",
    steps: [
      ["Require a name", "expenseName missing → 400."],
      ["Apply merchant rule", "A saved rule returns {confidence: 1, source: 'rule', abstained: false} without calling ML."],
      ["Proxy to ML", "POST /predict-category with a 5s timeout, operations token and request ID."],
      ["Pass abstention through", "The model response is returned as-is plus source: 'model'."],
      ["Map failures", "No response → 503; ML 4xx is forwarded; ML 5xx → 500."],
      ["Learn from the save", "Add Expense later records accepted / corrected / viewed / abstained feedback."]
    ]
  },
  {
    id: "retraining",
    category: "ML lifecycle",
    name: "Feedback-driven retraining trigger",
    purpose: "Starts a retraining run only after enough genuine corrections accumulate.",
    steps: [
      ["Acquire the lease", "At 20:30, feedbackCollector takes a 5-minute fail-closed lease."],
      ["Count pending", "mlFeedback documents with status 'pending' are counted."],
      ["Require 100", "Below 100 the job exits without contacting ML."],
      ["Trigger", "POST /retrain-model with the operations token and a fresh request ID."],
      ["Accept an existing run", "An existingRun response is logged; no duplicate is queued."],
      ["Retry tomorrow on outage", "A 503 leaves feedback pending for the next run."]
    ]
  },
  {
    id: "startup",
    category: "Platform",
    name: "Startup and health probes",
    purpose: "Fails fast on bad configuration and gives the platform truthful probes.",
    steps: [
      ["Validate config", "assertValidEnv lists every missing or invalid variable and exits before connecting."],
      ["Load jobs by role", "Cron modules load only when PROCESS_ROLE is worker or all."],
      ["Connect MongoDB", "Required: failure exits the process."],
      ["Connect Redis", "Waits up to 5s, then serves degraded while reconnecting in the background."],
      ["Listen", "server_started is logged with port, role, schedulesJobs and Redis mode."],
      ["Answer probes", "/health/live (process only), /health/ready (Mongo → 200/503), /health/deps (always 200, status in body)."]
    ]
  }
];

const stagePalette = [
  ["var(--cyan-soft)", "var(--cyan)"],
  ["var(--violet-soft)", "var(--violet)"],
  ["var(--orange-soft)", "var(--orange)"],
  ["var(--rose-soft)", "var(--rose)"],
  ["var(--green-soft)", "var(--green)"],
  ["var(--cyan-soft)", "var(--cyan)"]
];

const moduleList = document.getElementById("module-list");
const moduleTitle = document.getElementById("module-title");
const modulePurpose = document.getElementById("module-purpose");
const moduleDetail = document.getElementById("module-detail");
const moduleOwner = document.getElementById("module-owner");
const moduleFlow = document.getElementById("module-flow");
const workflowSelect = document.getElementById("workflow-select");
const workflowCategory = document.getElementById("workflow-category");
const workflowTitle = document.getElementById("workflow-title");
const workflowPurpose = document.getElementById("workflow-purpose");
const workflowSteps = document.getElementById("workflow-steps");
const stepCount = document.getElementById("step-count");
const themeToggle = document.getElementById("theme-toggle");

let selectedModule = modules[0].id;
let selectedWorkflow = workflows[0].id;

function renderModuleTabs() {
  moduleList.replaceChildren();

  modules.forEach((module, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "module-tab";
    button.id = `module-tab-${module.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "module-panel");
    button.setAttribute("aria-selected", String(module.id === selectedModule));

    const number = document.createElement("span");
    number.className = "tab-index";
    number.textContent = String(index + 1).padStart(2, "0");

    const copy = document.createElement("span");
    copy.className = "tab-copy";
    const label = document.createElement("strong");
    label.textContent = module.short;
    const owner = document.createElement("small");
    owner.textContent = module.owner;
    copy.append(label, owner);
    button.append(number, copy);

    button.addEventListener("click", () => {
      selectedModule = module.id;
      renderModuleTabs();
      renderModule();
    });

    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
      event.preventDefault();
      const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
      const currentIndex = modules.findIndex((item) => item.id === selectedModule);
      const nextIndex = (currentIndex + direction + modules.length) % modules.length;
      selectedModule = modules[nextIndex].id;
      renderModuleTabs();
      renderModule();
      document.getElementById(`module-tab-${selectedModule}`)?.focus();
    });

    moduleList.appendChild(button);
  });
}

function renderModule() {
  const module = modules.find((item) => item.id === selectedModule) ?? modules[0];
  moduleTitle.textContent = module.name;
  modulePurpose.textContent = module.purpose;
  moduleDetail.textContent = module.detail;
  moduleOwner.textContent = module.owner;
  document.getElementById("module-panel").setAttribute("aria-labelledby", `module-tab-${module.id}`);
  moduleFlow.replaceChildren();

  module.stages.forEach((stage, index) => {
    const stageElement = document.createElement("div");
    stageElement.className = "flow-stage";
    stageElement.style.setProperty("--stage-bg", stagePalette[index % stagePalette.length][0]);
    stageElement.style.setProperty("--stage-color", stagePalette[index % stagePalette.length][1]);

    const stageLabel = document.createElement("span");
    stageLabel.textContent = stage[0];
    stageElement.appendChild(stageLabel);

    stage.slice(1).forEach((node) => {
      const nodeElement = document.createElement("div");
      nodeElement.className = "stage-node";
      nodeElement.textContent = node;
      stageElement.appendChild(nodeElement);
    });

    moduleFlow.appendChild(stageElement);

    if (index < module.stages.length - 1) {
      const arrow = document.createElement("span");
      arrow.className = "stage-arrow";
      arrow.setAttribute("aria-hidden", "true");
      moduleFlow.appendChild(arrow);
    }
  });
}

function buildWorkflowControls() {
  workflowSelect.replaceChildren();
  workflowCategory.replaceChildren();

  let currentCategory = null;
  let currentGroup = null;

  workflows.forEach((workflow) => {
    if (workflow.category !== currentCategory) {
      currentCategory = workflow.category;
      currentGroup = document.createElement("optgroup");
      currentGroup.label = workflow.category;
      workflowSelect.appendChild(currentGroup);

      const groupLabel = document.createElement("span");
      groupLabel.className = "workflow-group-label";
      groupLabel.textContent = workflow.category;
      workflowCategory.appendChild(groupLabel);
    }

    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = workflow.name;
    currentGroup.appendChild(option);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "workflow-chip";
    chip.dataset.workflow = workflow.id;
    chip.setAttribute("aria-pressed", String(workflow.id === selectedWorkflow));
    chip.textContent = workflow.name;
    chip.addEventListener("click", () => {
      selectedWorkflow = workflow.id;
      workflowSelect.value = selectedWorkflow;
      renderWorkflowChips();
      renderWorkflow();
    });
    workflowCategory.appendChild(chip);
  });
}

function renderWorkflowChips() {
  document.querySelectorAll(".workflow-chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.workflow === selectedWorkflow));
  });
}

function renderWorkflow() {
  const workflow = workflows.find((item) => item.id === selectedWorkflow) ?? workflows[0];
  workflowTitle.textContent = workflow.name;
  workflowPurpose.textContent = workflow.purpose;
  stepCount.textContent = workflow.steps.length;
  workflowSteps.replaceChildren();

  workflow.steps.forEach(([title, detail]) => {
    const item = document.createElement("li");
    item.className = "workflow-step";

    const copy = document.createElement("div");
    copy.className = "step-copy";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    copy.append(heading, paragraph);
    item.appendChild(copy);
    workflowSteps.appendChild(item);
  });
}

workflowSelect.addEventListener("change", (event) => {
  selectedWorkflow = event.target.value;
  renderWorkflowChips();
  renderWorkflow();
});

const storedTheme = localStorage.getItem("balensia-architecture-theme");
if (storedTheme === "light") {
  document.body.dataset.theme = "light";
}

themeToggle.addEventListener("click", () => {
  const nextTheme = document.body.dataset.theme === "light" ? "dark" : "light";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem("balensia-architecture-theme", nextTheme);
  themeToggle.setAttribute("aria-label", `Switch to ${nextTheme === "light" ? "dark" : "light"} theme`);
});

renderModuleTabs();
renderModule();
buildWorkflowControls();
renderWorkflow();

// Smooth scrolling: clicking header navigation or in-page anchors scrolls smoothly
// directly to the section heading, leaving a clean, comfortable 20px gap below the sticky header.
function initSmoothScroll() {
  const header = document.querySelector(".site-header");

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const targetId = anchor.getAttribute("href");
      if (!targetId || targetId === "#") return;

      if (targetId === "#top") {
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
        history.pushState(null, "", "#top");
        return;
      }

      const targetElement = document.querySelector(targetId);
      if (!targetElement) return;

      event.preventDefault();

      const headerHeight = header ? header.offsetHeight : 76;
      const heading = targetElement.querySelector(".section-heading") || targetElement;
      const headingTop = heading.getBoundingClientRect().top + window.scrollY;
      const scrollTarget = headingTop - headerHeight - 20;

      window.scrollTo({
        top: Math.max(0, scrollTarget),
        behavior: "smooth"
      });

      history.pushState(null, "", targetId);
    });
  });
}

// Active navigation highlight based on current scroll position
function initActiveNavSpy() {
  const navLinks = document.querySelectorAll(".desktop-nav a");
  const sections = Array.from(navLinks)
    .map((link) => {
      const id = link.getAttribute("href");
      return id && id.startsWith("#") ? document.querySelector(id) : null;
    })
    .filter(Boolean);

  if (!sections.length) return;

  const onScroll = () => {
    const header = document.querySelector(".site-header");
    const headerHeight = header ? header.offsetHeight : 76;
    const scrollY = window.scrollY + headerHeight + 50;

    let currentSection = null;
    sections.forEach((section) => {
      const heading = section.querySelector(".section-heading") || section;
      const top = heading.getBoundingClientRect().top + window.scrollY;
      if (scrollY >= top) {
        currentSection = section;
      }
    });

    navLinks.forEach((link) => {
      const targetId = link.getAttribute("href");
      const isCurrent = currentSection && targetId === `#${currentSection.id}`;
      link.classList.toggle("active", Boolean(isCurrent));
    });
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

initSmoothScroll();
initActiveNavSpy();
