# BALENSIA Backend Architecture

An interactive, responsive architecture visualizer and comprehensive system map for the BALENSIA Node.js backend.

Audited against the active codebase at commit [`9a43723`](https://github.com/naresh-jothi/expense-manager/commit/9a43723) on branch `main`.

---

## 1. System Overview & Core Metrics

The BALENSIA backend is a resilient Express.js service providing transactional integrity, scheduled financial automation, document processing, and an intelligent bridge to the Python ML microservice.

| Dimension | Audited Metric | Implementation Details |
| :--- | :---: | :--- |
| **HTTP Endpoints** | **97** | Spread across 10 route files + root health probes in `app.js` |
| **Route Groups** | **10** | `api`, `auth`, `bill`, `chart`, `expense`, `health`, `income`, `ml`, `report`, `sia` |
| **Scheduled Jobs** | **9 Cron Modules** | Isolated by `PROCESS_ROLE` (web, worker, all); Redis key leases |
| **Data Persistence** | **23 Models + GridFS** | MongoDB durable store + GridFS `receipts` bucket; optional Redis cache |
| **Test Suites** | **262 Test Files** | 2,400+ tests in `backend/tests` covering units, real Mongo/Redis drills, migrations |
| **Design System** | **BALENISA UI** | Dark & light themes, 4px vertical accent lines, custom theme-adaptive scrollbars |

---

## 2. Five-Layer Request Architecture

1. **Bootstrap & Environment Gate (`server.js`, `config/env.js`)**:
   - `assertValidEnv()` validates required secrets (MongoDB URI, 32-char JWT & refresh secrets, CORS origins).
   - Role evaluation (`PROCESS_ROLE` = `web` | `worker` | `all`) loads scheduled jobs exclusively on worker instances.
2. **Security & Ingress Protection (`app.js`, `middleware/`)**:
   - Structured JSON logging with `X-Request-ID` propagation.
   - Dual rate-limiting: global IP limits (`authLimiter`) and email-scoped limits (`otpIssueLimiter`, `otpVerifyLimiter`).
   - Double-submit CSRF cookie protection (`balensia_csrf`) on cookie-authenticated routes.
3. **Domain Routing & Controllers (`routes/`, `controllers/`)**:
   - 97 strictly typed endpoints validating inputs via Joi schemas.
   - Per-request authorization extracting validated `userId` from short-lived access JWTs.
4. **Business Logic & Automation Engine (`services/`, `cron/`)**:
   - Idempotent transaction processing with `PendingSync` conflict recovery.
   - Deterministic report analyzer evaluating spending velocity, category shifts, and health scoring.
   - 9 background cron jobs managing recurring logs, export generation, retention purges, and push retries.
5. **Persistence & Cache Layer (`models/`, `utils/redisClient.js`)**:
   - 23 Mongoose models enforcing schema validation and compound indexing.
   - Disposable Redis cache (5-minute view caches, 1-hour reports) with automatic 5-second graceful degradation to direct database queries.

---

## 3. Scheduled Background Jobs (Cron Engine)

All jobs use fail-safe distributed Redis leases (`job-lease:<job>`) to ensure single-worker execution across clustered deployments:

| Job Name | Schedule | Role | Purpose & Execution Flow |
| :--- | :---: | :---: | :--- |
| **`accountDeletionJob`** | Daily at 03:00 | Worker | Permanently purges user data after the mandatory 14-day grace period |
| **`exportCleanup`** | Daily at 05:00 | Worker | Cleans up expired export files from `generated-exports/` and marks records expired |
| **`exportGeneration`** | Every 2 min | Worker | Processes queued asynchronous exports (≥ 5,000 rows) with 24-hour token validity |
| **`feedbackCollector`** | Daily at 20:30 | Worker | Aggregates user category corrections and triggers ML retraining at 100+ pending |
| **`importSessionRetention`**| Daily at 04:00 | Worker | Removes abandoned or expired CSV import preview sessions |
| **`receiptRetention`** | Daily at 06:00 | Worker | Cleans up orphaned or unlinked receipt images older than 90 days from GridFS |
| **`recurringJob`** | Daily at 20:30 | Worker | Automatically generates and logs recurring expenses due on the current date |
| **`retryPush`** | Every 15 min | Worker | Retries failed push notification payloads (up to 3 total attempts) |
| **`staleDeviceCleanup`** | Daily at 02:00 | Worker | Removes inactive or invalid Firebase Cloud Messaging (FCM) device tokens |

---

## 4. Key End-to-End Workflows Traced

- **Data Rights & Export Management (`/api/export`)**:
  - Small exports (< 5,000 rows) generate synchronously and persist an `ExportRequest` document with `status: 'ready'` in MongoDB, enabling re-download and on-demand deletion.
  - Large exports (≥ 5,000 up to 200,000 rows) queue asynchronously for background generation.
  - Mandatory `startDate` and `endDate` boundaries required for all exports, parsed resiliently by `backend/utils/dateParsing.js`.
  - On-demand artifact deletion (`DELETE /api/export/:id`) immediately purges both the database document and physical disk file.
- **Receipt OCR & Candidate Duplicate Triage (`/api/bill`, `/api/receipts`)**:
  - In-memory validation verifying MIME type, magic bytes, and image dimensions (≤ 20 MP).
  - Tesseract.js OCR engine running with two 30-second timeout attempts.
  - Smart expense matching searching an automated +/- 7-day window.
  - Duplicate candidate triage comparing exact content hashes and probable merchant/date/amount matches with audit tracking in `ReceiptAudit`.
- **SIA AI Financial Intelligence (`/api/sia`)**:
  - Grounded financial assistant queries backed by server-side spending snapshots.
  - Circuit-breaker protected LLM calls with prohibited-phrase filtering and bounded conversation memory.
  - Audio transcription endpoint supporting voice expense creation.

---

## 5. Architectural Boundaries & Guarantees

The architecture visualizer organizes all backend boundaries into four distinct, audited categories:

1. **Guaranteed Capabilities**:
   - Client-generated UUID idempotency on all write endpoints (replays return cached state or HTTP 409).
   - Strict data isolation: all database queries unconditionally scope by authenticated `req.userId`.
   - Redis degradation: server starts and functions reliably even if Redis is unreachable.
   - Two-tier account deletion lifecycle with 14-day grace period.
2. **Architectural Non-Goals**:
   - In-process ML training (delegated entirely to FastAPI ML service).
   - Plaintext secret storage (bcrypt cost 10 for passwords; SHA-256 digests for OTPs).
   - WebSocket connection churn (state managed via polling and FCM push).
3. **Active Limits & Maintenance**:
   - Single-worker cron leases require synchronized server clocks (NTP).
   - Maximum export request row ceiling of 200,000 rows.
   - Receipt OCR in-memory ceiling of 5 MB and 20 MP.
4. **Recently Resolved Improvements**:
   - **On-Demand Export Purging**: Added `DELETE /api/export/:id` for immediate file and record cleanup.
   - **Synchronous Export Persistence**: Synchronous exports now persist ready records in MongoDB.
   - **Resilient Multi-Format Date Parsing**: Centralized parsing across legacy and ISO date inputs.
   - **Safe Error Reporting**: Sanitized `errorCode` and `errorSyscall` logging without credential leaks.

---

## 6. View Locally & Deployment

No installation or build steps are required to view the visualizer:

1. Open `index.html` directly in any browser, or run a local Python server:
   ```bash
   python -m http.server 8080
   ```
2. Open `http://localhost:8080`.

### GitHub Pages Publishing
The static site is fully standalone with relative paths and includes `.github/workflows/pages.yml` for automated GitHub Pages publication.

---

## 7. Technical Standards

- Pure vanilla HTML5, CSS3, and JavaScript (ES2022).
- Zero external build dependencies, package downloads, or CDNs.
- Standardized BALENISA vertical accent line heading pattern (`4px` width, `24px` height).
- Clean, accessible, and responsive across all viewports.
