# HostSync — Rebuild Specification

**Target:** https://hostsync.base44.app/
**Method:** REA (Reverse Engineer Anything) attached over CDP to a **live signed-in Chrome 157 session**; all 10 authenticated screens driven and captured, 7 dialogs opened and read, network payloads recorded, plus static analysis of all 15 shipped route chunks.
**Date:** 2026-11-14

---

## 0. Evidence and confidence

| What | Detail |
|---|---|
| Provider | REA `rea-cdp-browser` v2, Chrome 157.0.8103.51 |
| Session | Authenticated as `kefaswayne` (portfolio **TEST**) — 5 properties, 20 bookings, 9 tasks, 6 threads, 6 reviews, 5 statements |
| Screens driven | 10 of 10 authenticated routes, rendered and captured |
| Dialogs read | 7 (new booking, property create, property edit, sync calendars, new task, record expense, generate statement, email a guest) |
| Entities | 10 (`Portfolio`, `Property`, `Booking`, `Task`, `Staff`, `GuestMessage`, `Review`, `Payout`, `LedgerEntry`, `PropertyAccount`) |
| API base | `https://hostsync.base44.app/api/apps/6ae9b6c64d96b7adb2f4ed7e/` |

**Confidence levels used below:**
- **[observed]** — read directly from the live signed-in UI or its network traffic.
- **[verified]** — observed *and* arithmetically confirmed against the demo data.
- **[inferred]** — reconstructed from shipped JavaScript only.

The previous draft was reconstructed from route chunks alone. That limitation is now closed: every screen was rendered with real data and every formula below was checked against it. Two things remain genuinely unobserved: **third-party send behaviour** (nothing external was triggered) and **statement approval actions** (no such control exists in the UI — see §7.4).

---

## 1. What the product is

A short-stay (Airbnb / Booking.com / Vrbo) **property operations platform** for small management companies. One workspace holds the property record, an overlap-safe multi-channel calendar, turnover and maintenance task boards, a guest inbox, review collection, and per-property owner money.

Its own words: *"A booked night is held automatically — a second guest is refused those dates."* Double-booking prevention is the primary invariant; everything else hangs off bookings.

---

## 2. Verified business rules (the part worth copying exactly)

These are the rules the app actually enforces. Each was confirmed against the demo data, not guessed.

### 2.1 Booking price [verified]

```
gross      = (nights × nightly_rate) + cleaning_fee
commission = gross × channel_commission_pct
net        = gross − commission            ← the "NET" column stores this
```

Checked against **20 of 20** rendered bookings, exact to the shilling.

### 2.2 Channel commission table [verified]

| Channel | Commission | Cross-checks |
|---|---|---|
| Direct | **0 %** | 7 bookings |
| Airbnb | **15 %** | 9 bookings |
| Booking.com | **15 %** | 4 bookings |
| Vrbo | **8 %** | 1 booking |
| WhatsApp | 0 % **[inferred]** | channel exists in filters and legend, no sample booking |

Worked example — Chris Ochieng, Nyali Beach House, 7 nights, Airbnb:
`7 × 26,000 + 5,000 = 187,000` → commission `−28,050` (15 %) → **net 158,950**. Matches both the ledger and the detail sheet.

### 2.3 Owner statement math [verified]

```
management_fee = gross_revenue × property_management_fee_pct
net_payout     = gross_revenue − operating_expenses − management_fee
```

All 5 statements reconcile exactly:

| Property | Gross | Expenses | Fee | Net | Fee % |
|---|---|---|---|---|---|
| Riverside Studio | 45,000 | 4,200 | 6,750 | 34,050 | 15 % |
| Kilimani Loft | 189,500 | 34,700 | 34,110 | 120,690 | 18 % |
| Westlands Penthouse | 244,000 | 40,100 | 43,920 | 159,980 | 18 % |
| Nyali Beach House | 386,000 | 62,400 | 77,200 | 246,400 | 20 % |
| Karen Cottage | 132,000 | 28,900 | 19,800 | 83,300 | 15 % |

**The fee is per-property, overriding the portfolio default.** Portfolio default is 18 % (set in Settings); Karen Cottage and Riverside Studio carry a 15 % override, Nyali Beach House 20 %. The same override is visible on the financials table (Karen `8,033 / 53,550 = 15 %`).

Roll-ups confirm: *Awaiting release* `277,330 = 34,050 + 159,980 + 83,300`; *Paid to owners* `367,090 = 120,690 + 246,400`.

### 2.4 Overlap handling [observed]

Two layers, and they behave differently:

1. **Manual booking form** — hard block before saving. Entering dates that collide replaces the submit button with a disabled **"Nights unavailable"** and shows:
   > *This stay overlaps an existing booking — test · 2026-11-16 → 2026-11-23. Those nights are already held, so a second guest cannot take them. Pick other dates — nothing was saved.*
2. **Imported/synced bookings** — allowed to coexist, but forced to **Pending**. The calendar cell flags *"Overlaps 1 other booking"* and the detail sheet exposes **"Confirm stay"**. Copy: *"Two guests cannot hold the same nights. Resolve each one before the stay is confirmed."*

So the invariant is enforced at *confirmation*, not at *insertion*, for anything arriving from a channel feed.

### 2.5 Auto-turnover [observed]

The booking form states: *"A turnover is scheduled for the check-in day."* Turnover tasks carry an arrival-derived window (check-in day, 10:00–14:00 or 11:00–15:00 variant) and a 5-item checklist.

---

## 3. Data model

Field names marked ★ are confirmed from API sort/filter parameters or live form values.

```
Portfolio
  name ★, location, default_management_fee_pct ★(18), guest_support_email ★,
  whatsapp_number ★, review_automation_enabled ★(true),
  review_request_days ★(1), currency (KES)

Property
  name ★, status (live | onboarding) ★, type (apartment | cottage | …) ★,
  neighbourhood ★, city ★, address ★, bedrooms ★, baths ★, guests ★,
  nightly_rate ★, cleaning_fee ★, owner ★, owner_email ★,
  management_fee_pct ★, photo_url ★,
  channels[] (airbnb | booking_com | vrbo | direct) ★

Booking
  reference ★ (HS-#### for direct, MRD-#### for imported) ★,
  property, guest_name, guest_email, guest_phone,
  channel (airbnb | booking_com | vrbo | direct | whatsapp) ★,
  check_in ★, check_out ★, nights, guests,
  gross_total, channel_commission, net_amount ★,
  payment_status (paid | unpaid | partial) ★,
  status (pending | confirmed | completed | cancelled) ★,
  notes, source (import | manual | direct_site), created_by

Task
  property, booking_id?, kind (turnover | maintenance | inspection) ★,
  title, priority (normal | …) ★, scheduled_date ★,
  window_start, window_end, checklist[] (5 items for turnover),
  assignee_staff_id, expected_cost ★, notes,
  status (unassigned | scheduled | on_site | complete | blocked) ★

Staff
  name ★, role (cleaner | maintenance | inspector | supervisor) ★,
  phone ★, rate ★, reliability_pct ★, active ★

GuestMessage
  property, booking_id?, guest_name, guest_email,
  channel (whatsapp | sms | airbnb | booking_com | email) ★,
  direction (in | out), body, delivery (recorded | sent) ★,
  sent_at ★, read ★

Review
  property, channel, guest_name, rating, body, review_date ★,
  reply_body, replied_at, request_status (not_requested | requested) ★

LedgerEntry
  property, entry_date ★, kind (credit | expense),
  category (booking_revenue | housekeeping | maintenance | consumables | utilities) ★,
  amount, description, paid_to, account_id

Payout (owner statement)
  property, period_start, period_end ★,
  gross_revenue, operating_expenses, management_fee, net_payout,
  status (draft | approved | paid) ★

PropertyAccount
  label ★ ("KCB ••3310"), property, balance,
  status (verified | pending) ★
```

Observed list queries (these leak the real field names):

```
GET  entities/Property/v2/list?limit=400&sort=name
GET  entities/Booking/v2/list?limit=400&sort=check_in
GET  entities/Task/v2/list?limit=400&sort=scheduled_date
GET  entities/LedgerEntry/v2/list?limit=400&sort=-entry_date
GET  entities/PropertyAccount/v2/list?limit=400&sort=label
GET  entities/Review/v2/list?limit=400&sort=-review_date
GET  entities/Payout/v2/list?limit=400&sort=-period_end
GET  entities/Portfolio/v2/list?limit=1&sort=created_date
GET  entities/User/me
POST analytics/track/batch
POST app-logs/<appId>/log-user-in-app/<route>
```

Note the load pattern: **the dashboard fires 8 parallel `limit=400` list calls** and filters client-side. That is fine at demo scale and is the first thing to fix in a rebuild (see §6).

---

## 4. Feature inventory

77 features. `F-xx` is the stable ID used by the tests in §5.

### 4.1 Public / marketing (F-01 – F-04)

| ID | Feature | Detail |
|---|---|---|
| F-01 | Landing page | Hero *"Add your property. We hold every night."*, 3-step booking-intake explainer, 8 feature cards, stats strip (*1 grid · 0 double bookings · 3 ways in*), Create account + Sign in CTAs |
| F-02 | Feature explainer sections | Property hub, calendar, turnovers, inbox, reviews, financials, owner statements, sync health |
| F-03 | Base44 badge overlay **[remove]** | Floating *"Edit with"* badge, bottom-right, with a "Close badge" control. Removal requires a paid Base44 plan — this is the specific thing the rebuild eliminates |
| F-04 | Toast notification region | App-level ARIA `region` (*"Notifications alt+T"*) used for save/error feedback |

### 4.2 Authentication & onboarding (F-05 – F-10)

| ID | Feature | Detail |
|---|---|---|
| F-05 | Register | Email + password sign-up |
| F-06 | OTP email verification | 6-digit code, resend; `User/me` returns `is_verified: true` |
| F-07 | Login | Email + password → session token in `localStorage` |
| F-08 | Forgot / reset password | Two-route recovery flow; `force_password_reset` flag exists on User |
| F-09 | Session guard + logout | `/_authed` redirects unauthenticated users; user chip exposes sign-out |
| F-10 | Onboarding wizard | Sets name + portfolio → `onboarding_complete: true` |

### 4.3 App shell (F-11 – F-13)

| ID | Feature | Detail |
|---|---|---|
| F-11 | Sidebar navigation | Overview · Calendar · Bookings · Properties · Operations · Inbox · Reviews · Financials · Payouts · Settings, with active-state highlight |
| F-12 | Identity + portfolio context | User chip (`kefaswayne` / *Signed in*) and portfolio pill (`TEST · 5 PROPERTIES`) in the header of every screen |
| F-13 | Mobile navigation drawer | *"Open navigation"* trigger replaces the sidebar below the breakpoint |

### 4.4 Dashboard (F-14 – F-20)

| ID | Feature | Detail |
|---|---|---|
| F-14 | KPI strip | Net revenue this month (`KES 55K`, posted credits), occupancy last 30 days (`33 %`), turnovers due next 48 h (`8`), guest rating (`4.50` / 6 reviews) |
| F-15 | Revenue & occupancy chart | Six-month bars (Jun–Nov) with a Revenue/Occupancy toggle |
| F-16 | Calendar-clear reassurance card | *"CALENDAR CLEAR — No overlapping nights"* plus *"Open calendar"* |
| F-17 | Payout run widget | `KES 277K` payable across 3 statements, linking to Payouts |
| F-18 | Turnovers in next 48 h | Property, window, assignee, status (`Scheduled` / `In Progress`) |
| F-19 | Portfolio health table | Per property: occupancy %, next arrival (*Tomorrow* / *In 2 days* / date / `—`), settling account + balance, status (`Live` / `Onboarding`) |
| F-20 | Empty state | Zero-property workspace shows the getting-started checklist instead of KPIs |

### 4.5 Properties (F-21 – F-27)

| ID | Feature | Detail |
|---|---|---|
| F-21 | Property cards | Photo, name, neighbourhood + city, beds / baths / sleeps, nightly rate, 30-day occupancy, channel badges, settling account, account balance, next arrival, owner, status |
| F-22 | Add property | Name, status, neighbourhood, city, type, address, bedrooms, baths, guests, nightly rate, cleaning fee, owner, owner email, management fee %, photo URL, channels (Airbnb / Booking.com / Vrbo / Direct) |
| F-23 | Edit property | Same form pre-filled; *"Save changes"*; confirmation via toast |
| F-24 | Property status | `Onboarding` ⇄ `Live`, shown on the card and used to flag incomplete setups |
| F-25 | Calendar linking | Per-property iCal feed: property selector, calendar link (`https://www.airbnb.com/calendar/ical/123456.ics?s=…`), source selector, *"The link is saved on the property, so you can refresh it any time."* |
| F-26 | Sync calendars | Refresh action per property / all; import validation errors: *"That page isn't an iCal (.ics) feed"*, *"That calendar is too large to import"*, *"That doesn't look like a web link"*, *"Could not read that calendar"* |
| F-27 | Property account | Bank account label (masked, e.g. `KCB ••3310`), running balance, `Verified` / `Pending` state |

### 4.6 Bookings (F-28 – F-36)

| ID | Feature | Detail |
|---|---|---|
| F-28 | Booking ledger | Guest + reference, property, stay dates, nights + guest count, channel, net, payment status, booking status |
| F-29 | Ledger KPIs | `IN HOUSE NOW` (stays), `ARRIVING` (confirmed), `NET BOOKED` (sum of net) |
| F-30 | Search | Guest, property or reference |
| F-31 | Filters | Status (Confirmed / Pending / Completed / Cancelled) and channel (Airbnb / Booking.com / Vrbo / Direct / WhatsApp) |
| F-32 | Booking detail sheet | Channel tag, guest, property + reference, check-in (`from 15:00`) / check-out (`by 11:00`), guests, nights, gross total, channel commission, net to owner, payment status, email, phone, status, and overlap warning when present |
| F-33 | Confirm pending booking | *"Confirm stay"* moves Pending → Confirmed, gated by the overlap check |
| F-34 | Cancel booking | *"Cancel"* moves a booking to Cancelled and releases the nights |
| F-35 | New booking + live pricing | Property, guest name, channel, check-in, check-out, guests, guest email, guest phone, notes. Live summary: `N nights · base KES X + cleaning KES Y`, total, `Channel commission`, `Net to owner`; notes that a turnover will be scheduled |
| F-36 | iCal import into bookings | Paste feed URL → stays and blocked nights land as bookings and hold their dates |

### 4.7 Calendar (F-37 – F-42)

| ID | Feature | Detail |
|---|---|---|
| F-37 | Unified grid | 21-day window, one row per property, day columns, booking bars spanning nights |
| F-38 | Date navigation | *Previous week* / *Today* / *Next week*; range label (`Sat 14 November – 04 Dec`) |
| F-39 | Legend | Channel colours (Airbnb, Booking.com, Vrbo, Direct, WhatsApp) plus `Conflict` and `Turnover scheduled` markers |
| F-40 | Sync health header | `5 properties · 12 confirmed stays · No double bookings` with `Live — checked 20:48` freshness stamp |
| F-41 | Overlap flagging | Conflicting booking bars are marked; the cell sheet lists *"Overlaps 1 other booking"* with the colliding guest and dates |
| F-42 | Cell → booking sheet | Clicking a booking bar opens the same detail sheet as the ledger |

### 4.8 Operations / turnovers (F-43 – F-49)

| ID | Feature | Detail |
|---|---|---|
| F-43 | Board summary counters | `UNASSIGNED`, `DUE TODAY`, `BLOCKED`, `NEEDS SOMEONE` |
| F-44 | Task board columns | `UNASSIGNED`, `SCHEDULED`, `ON SITE`, `COMPLETE` with per-column counts |
| F-45 | Task card anatomy | Kind tag (`TURNOVER` / `MAINTENANCE` / `INSPECTION`), property, title, date, time window, checklist progress (`0/5 checks`), assignee, status action |
| F-46 | Auto-created turnovers | Confirmed arrival spawns a turnover for the check-in day with a 5-item checklist |
| F-47 | New task | Property, type, priority, what needs doing, date, window, assign to, expected cost, notes |
| F-48 | Start / Done / Reopen | Lifecycle transitions: Unassigned → Scheduled → On Site → Complete, and back |
| F-49 | Checklist progress | Per-task checks with `n/m` progress reflected on the card |

### 4.9 Guest inbox (F-50 – F-55)

| ID | Feature | Detail |
|---|---|---|
| F-50 | Thread list | Guest, date, channel, property, unread badge, last message snippet; header counts (`6 threads`, `3 unread`) |
| F-51 | Conversation pane | Messages oldest→newest labelled `You` / `Sofia` with per-message *"via WhatsApp"* attribution |
| F-52 | Reply channel selector | WhatsApp · SMS · Airbnb · Booking.com · Email |
| F-53 | Recorded-only delivery | Non-email channels are filed but not sent: badge **"Recorded only"** and *"Recorded against this guest and property - only email is delivered today."* |
| F-54 | Email a guest | New outbound thread: property, guest name, guest email, message → *"Send email"* |
| F-55 | Email-address guard | Email delivery requires a guest address (form demands it; thread copy states email is the only delivering channel) |

### 4.10 Reviews (F-56 – F-61)

| ID | Feature | Detail |
|---|---|---|
| F-56 | Reputation KPIs | Average rating (`4.50`, 6 reviews), response rate (`50 %`, 3 replied), awaiting reply (`3`), requests due (`4`) |
| F-57 | Review feed | Newest first: guest, channel, property + date, body, and existing owner reply where present |
| F-58 | Write a reply | Inline textarea + *"Post reply"*, disabled until text is entered |
| F-59 | Review requests due | Stays checked out ≥ N days ago and not yet asked, each with a *"Request"* action |
| F-60 | Already-requested list | Guests already asked; empty state *"No requests logged yet."* |
| F-61 | Auto-request schedule | *"Auto-request 1d after checkout"* — global switch plus *"Days after checkout"* |

### 4.11 Financials (F-62 – F-67)

| ID | Feature | Detail |
|---|---|---|
| F-62 | Financial KPIs | Revenue this month (`KES 55K`, posted credits), expenses (`KES 2K`), net income (`KES 53K`, before owner payouts), outstanding (`KES 568K`, unpaid bookings) |
| F-63 | Revenue vs expenses chart | Six months, posted transactions only |
| F-64 | Bank accounts | One card per property account: label, property, balance, `Verified` / `Pending` |
| F-65 | Property performance table | All-time revenue, expenses, net, management fee, settling account, per property |
| F-66 | Transaction feed | Signed amount, description, date, property, account, category (`BOOKING REVENUE`, `HOUSEKEEPING`, `MAINTENANCE`, `CONSUMABLES`, `UTILITIES`), filter All / Revenue / Expenses |
| F-67 | Record expense | Property, date, category, amount, description, paid to, account preview. Copy: *"Charges the property's own account so owner statements stay accurate, and debits that account balance"* |

### 4.12 Payouts (F-68 – F-72)

| ID | Feature | Detail |
|---|---|---|
| F-68 | Statement list + KPIs | `AWAITING RELEASE` (draft + approved), `PAID TO OWNERS` (settled), statement count across properties |
| F-69 | Statement table | Property, owner, period, gross, expenses, fee, net payout, status |
| F-70 | Per-property fee override | Fee column derives from the property's own `management_fee_pct`, falling back to the portfolio default |
| F-71 | Generate statement | Property + month picker with a live preview: gross revenue, operating expenses, `Management fee (15%)`, owner payout |
| F-72 | Statement statuses | `Draft` → `Approved` → `Paid` |

### 4.13 Settings (F-73 – F-77)

| ID | Feature | Detail |
|---|---|---|
| F-73 | Portfolio details | Portfolio name, location, default management fee %, guest support email, WhatsApp number |
| F-74 | Review automation | Switch (on by default) plus *"Days after checkout"*; *"Log a request after every completed stay."* |
| F-75 | Channel indicators | Read-only status, never a toggle: Airbnb / Booking.com / Vrbo turn on when a calendar feed with that source exists, Direct when a manual stay exists, WhatsApp when a business number is saved. A click cannot fake a connection |
| F-76 | Team roster | Name, role, phone, rate, reliability % (`88 % Reliability`), with `Pause` / `Activate` |
| F-77 | Add team member | Name, role (Cleaner / Maintenance / Inspector / Supervisor), phone, rate |

---

## 5. Automated test cases — one per feature

Legend: **U** unit · **I** integration (API + DB) · **E** end-to-end (Playwright) · **P** property-based. Every case is deterministic: seeded DB, frozen clock, mocked third-party HTTP.

| ID | Feature | Automated test | Layer |
|---|---|---|---|
| T-01 | Landing page | `GET /` renders hero heading, 8 feature cards and both CTAs; visual diff below threshold | E |
| T-02 | Feature sections | Each of the 8 explainer cards renders title + body from the content fixture | E |
| T-03 | Badge removed | Assert no `Edit with` / badge script node exists in the rebuilt bundle and no `badge.js` request is made | E |
| T-04 | Toasts | Trigger a save; assert an ARIA live region announces the message, then auto-dismisses | E |
| T-05 | Register | `POST /auth/register` with a fresh email → 201, user row `is_verified=false`, OTP dispatched once | I |
| T-06 | OTP | Correct code → verified + session; wrong code → 400 and no session; resend issues a new code and invalidates the old one | I |
| T-07 | Login | Correct credentials → session cookie set; wrong password → 401, no cookie, no token in storage | I |
| T-08 | Password reset | Request → token emailed; consume → password changes and `force_password_reset` clears; old password then 401 | I |
| T-09 | Session guard | Unauthenticated `GET /dashboard` → redirect `/login`; after logout the old cookie → 401 | E |
| T-10 | Onboarding | Submit wizard → portfolio persisted with name + currency; `onboarding_complete` true; redirect to dashboard | I |
| T-11 | Sidebar nav | Each of the 10 nav items routes to its screen and receives the active class | E |
| T-12 | Identity header | Header shows signed-in name, `Signed in`, and `<portfolio> · <n> PROPERTIES` matching seeded counts | E |
| T-13 | Mobile drawer | At 390 px the sidebar hides, `Open navigation` opens the drawer, and links still navigate | E |
| T-14 | Dashboard KPIs | Seed a month of ledger + 5 properties → all four KPI values equal independently computed expectations | I |
| T-15 | Revenue chart | Six seeded months → six buckets in order; the toggle switches series without refetching | I+E |
| T-16 | Calendar-clear card | Zero overlaps → `CALENDAR CLEAR`; one overlapping seeded pair → the card changes state | I |
| T-17 | Payout widget | Draft + approved statements only → widget total equals their sum (paid excluded) | I |
| T-18 | 48 h turnovers | Tasks at +24 h, +47 h, +49 h → only the first two are listed | I |
| T-19 | Portfolio health | Seed 3 properties with known occupancy and balances → each row's occupancy %, next arrival, account and balance match | I |
| T-20 | Empty state | New account, no properties → checklist renders, KPI cards show zero states, no crash | E |
| T-21 | Property cards | Seed 3 properties → each card shows rate, beds/baths/sleeps, occupancy, channel badges, account, balance, next arrival, owner, status | I |
| T-22 | Add property | Valid 16-field payload → 201 and card appears; invalid management fee (150) → 422 with a field error | I |
| T-23 | Edit property | Patch nightly rate → 200, card and any derived pricing update, audit row written | I |
| T-24 | Property status | Toggle `Onboarding` → `Live` → persisted and reflected on card and health table | I |
| T-25 | Calendar linking | Save a feed URL → stored on the property with source; non-URL string → 422 | I |
| T-26 | Sync calendars | Mock feed with 2 events → 2 bookings created, `last_synced_at` set; 404 feed → error surfaced, existing bookings untouched | I |
| T-27 | Property account | Account with balance + `verified` flag renders masked label; unverified renders `Pending` | I |
| T-28 | Booking ledger | Seed 5 bookings across 3 channels → rows show reference, nights, guests, channel, net, payment, status exactly | I |
| T-29 | Ledger KPIs | Seed 1 in-house, 4 arrivals, known nets → the three counters match computed values | I |
| T-30 | Search | Query `Kilimani` → matches property name, guest name and reference; unrelated rows excluded | I |
| T-31 | Filters | `channel=airbnb` → only Airbnb; `status=pending` → only Pending; combined filters AND together | I |
| T-32 | Detail sheet | Open a booking → sheet shows gross, commission, net, payment, email, phone; `gross − commission = net` holds for every seeded row | I+E |
| T-33 | Confirm booking | Pending booking with no overlap → Confirmed; pending booking that overlaps → refusal with the overlap message and status unchanged | I |
| T-34 | Cancel booking | Cancel → status `cancelled` and the nights become bookable again (a new booking on those dates succeeds) | I |
| T-35 | New booking pricing | For each channel, `nights × rate + cleaning` and `net = gross × (1 − pct)` match the UI summary and the stored row | I+P |
| T-36 | iCal import | Valid ICS → bookings created and nights held; non-ICS URL → 422 *"not an iCal feed"*; oversized → 413 | I |
| T-37 | Calendar grid | 5 properties, 21 days → grid has 5 rows × 21 columns and each booking bar spans exactly its nights | I |
| T-38 | Date navigation | `Next week` advances the range by exactly 7 days and refetches; `Today` returns to the current window | E |
| T-39 | Legend | All five channels plus `Conflict` and `Turnover scheduled` are rendered and colour-keyed to the bars | E |
| T-40 | Sync health header | Counts match seeded properties/stays; a stale sync sets the freshness stamp to a non-`Live` state | I |
| T-41 | Overlap flagging | Two bookings sharing one night → both bars marked, and the sheet reports `Overlaps 1 other booking` with the other guest + dates | I+E |
| T-42 | Cell opens sheet | Click a booking bar → the sheet's reference equals that booking's reference | E |
| T-43 | Board counters | Seed tasks in each state → the four counters equal their group counts | I |
| T-44 | Board columns | Tasks in unassigned/scheduled/on_site/complete appear in exactly one column each | I |
| T-45 | Task card | Card renders kind, property, title, date, window, `n/m checks`, assignee and the correct action button | E |
| T-46 | Auto turnover | Insert a booking → exactly one turnover task exists for the check-in day with 5 checklist items; deleting the booking removes or orphans it explicitly | I |
| T-47 | New task | Valid payload → 201 and card appears; missing title → 422 | I |
| T-48 | Task lifecycle | Start → On Site; Done → Complete with timestamp; Reopen → Scheduled | I |
| T-49 | Checklist | Tick 3 of 5 → card shows `3/5 checks`; all 5 → card ready to complete | I |
| T-50 | Thread list | 6 seeded threads → each shows guest, channel, property, unread badge and snippet; counts match | I |
| T-51 | Conversation order | Open a thread → messages ordered oldest→newest with correct author labels and channel attribution | E |
| T-52 | Reply channel select | Selecting each of the 5 channels persists the chosen channel on the outbound message | I |
| T-53 | Recorded-only | Reply via WhatsApp/SMS → stored with `delivery=recorded`, email provider **not** called, badge shows `Recorded only` | I |
| T-54 | Email a guest | Valid guest email → provider adapter called exactly once, message stored `delivery=sent`; malformed email → 422 | I |
| T-55 | Email guard | Email delivery attempted without a guest address → 422 and nothing sent | I |
| T-56 | Reputation KPIs | 6 reviews, 3 replied, 4 eligible → average 4.50, response rate 50 %, awaiting 3, due 4 | I |
| T-57 | Review feed | Newest-first ordering; reviews with replies render the reply body; unanswered ones render `Write a reply` | I |
| T-58 | Write a reply | Post reply → stored beside the review, `replied_at` set, response rate increases; button disabled while empty | I+E |
| T-59 | Requests due | Checkout 2 days ago with N=1 → appears; checkout today → does not | I |
| T-60 | Already requested | After requesting, the stay moves from `due` to `already requested`; list renders the empty state when none | I |
| T-61 | Auto-request schedule | Switch off → no requests generated by the cron; switch on with N=3 → request logged 3 days after checkout | I |
| T-62 | Financial KPIs | Seed posted credits/expenses/unpaid → revenue, expenses, net income and outstanding all match | I |
| T-63 | Rev/expense chart | Six months of mixed entries → six buckets, expenses negative, posted-only filter respected | I |
| T-64 | Bank accounts | 5 accounts with mixed verification → labels masked, balances correct, `Verified`/`Pending` correct | I |
| T-65 | Property performance | All-time sums per property → revenue, expenses, net and fee match; fee respects the per-property override | I |
| T-66 | Transaction feed | 20 entries → signed amounts, categories and account attribution correct; each filter yields the right subset | I |
| T-67 | Record expense | Post an expense → ledger row created, property account balance decreases by exactly the amount, statement inputs update | I |
| T-68 | Payout KPIs | Draft + approved sum to `AWAITING RELEASE`; paid sums to `PAID TO OWNERS`; count matches | I |
| T-69 | Statement math | For every statement, `gross − expenses − fee = net` and `fee = gross × pct`; assert on all five seeded rows | I+B |
| T-70 | Fee override | Property at 15 % in a portfolio at 18 % → statement uses 15 %; unset property inherits 18 % | I |
| T-71 | Generate statement | Property + month → preview shows gross/expenses/`Management fee (x%)`/payout, and the created draft stores the same numbers | I+E |
| T-72 | Statement status | `draft → approved → paid` transitions enforced; illegal transition (paid → draft) rejected 409 | I |
| T-73 | Portfolio details | Patch all five fields → persisted and re-read; management fee 150 → 422 | I |
| T-74 | Review automation | Toggle off and set days=3 → both persisted; scheduler honours it | I |
| T-75 | Channel states | Indicators derived from real setup (calendar feeds, manual stays, WhatsApp number); a POST with `connected: true` and no setup stays off; WhatsApp still requires a business number | I |
| T-76 | Team roster | Roster renders name, role, phone, rate, reliability; Pause → `active=false` and the member disappears from assignment pickers | I |
| T-77 | Add team member | Valid member → 201 and appears; invalid role → 422; duplicate phone → 409 | I |

---

## 6. Three-part build plan

### 6.0 The quality bar — what "works at its best" means here

Every feature below must clear this bar. It is not aspirational; each line is a testable gate.

| Dimension | Bar | Why the original fails it |
|---|---|---|
| Money | Integer minor units, computed server-side, snapshot stored on the row | Client computes and displays prices; floats implied; a rate change silently rewrites history |
| Dates | Server-validated, timezone-aware, `check_out > check_in` enforced | "0 nights" bookings save at cleaning-fee price (§7.4 #1) |
| Auth | httpOnly + SameSite session cookie, rotation, revocation | Token in `localStorage`, readable by any XSS |
| Overlap | Database exclusion constraint, not a form check | Form-only; imported collisions rely on discipline |
| A11y | Every input labelled, dialogs focus-trapped and Esc-closable, AA contrast | Live probe showed inputs with **no accessible label** |
| Performance | p95 API < 300 ms, cursor pagination, no `limit=400` client filtering | Dashboard issues 8 full-table list calls and filters in the browser |
| Honesty | Never imply a capability the system cannot perform | Correctly says "Recorded only" for SMS/WhatsApp — keep this |
| External calls | Every outbound call has an explicit failure state surfaced in UI | Sync has states; sends do not |
| Data safety | Soft delete, append-only money, audit log, backups | Hard deletes, mutable statements |
| Tests | One automated test per feature, running in CI | None shipped |

---

### 6.1 Stage 1 — "One calendar that holds"

**Goal:** a booking can never double-book, and the money on it is arithmetically correct. Ship auth, portfolio, properties, bookings, calendar.
**Features:** F-01 – F-13, F-21 – F-42, plus F-14, F-16, F-19, F-20 from the dashboard.
**Tests that must pass:** T-01 – T-13, T-21 – T-42, T-14, T-16, T-19, T-20.

**Stack.** React 18 + Vite + TypeScript, TanStack Router/Query, Tailwind, Radix primitives. API: Fastify (or Next route handlers). **Postgres 16.** Auth: own implementation, argon2id, httpOnly sessions. Storage: S3-compatible with presigned uploads.

**Schema skeleton.**

```sql
create extension if not exists btree_gist;

create table property (
  id            uuid primary key,
  name          text not null,
  status        text not null default 'onboarding',   -- onboarding | live | archived
  type          text,
  neighbourhood text, city text, address text,
  bedrooms int, baths int, guests int,
  nightly_rate_cents bigint not null check (nightly_rate_cents > 0),
  cleaning_fee_cents bigint not null default 0 check (cleaning_fee_cents >= 0),
  management_fee_bps int check (management_fee_bps between 0 and 10000),  -- null = inherit
  owner_name text, owner_email text, photo_key text,
  currency char(3) not null default 'KES',
  timezone text not null default 'Africa/Nairobi',
  checkin_time time not null default '15:00',
  checkout_time time not null default '11:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table booking (
  id uuid primary key,
  property_id uuid not null references property(id),
  reference text not null unique,
  guest_name text not null,
  guest_email text, guest_phone text,
  channel text not null,                    -- airbnb | booking_com | vrbo | direct | whatsapp
  stay daterange not null,
  guests int not null check (guests >= 1),
  gross_cents bigint not null,
  commission_bps int not null,
  net_cents bigint not null,
  rate_version int not null,                -- which pricing rule produced the snapshot
  payment_status text not null,             -- paid | unpaid | partial
  status text not null default 'pending',   -- pending | confirmed | completed | cancelled
  source text not null,                     -- import | manual | direct_site
  version int not null default 1,           -- optimistic locking
  created_at timestamptz not null default now(),
  constraint stay_positive check (upper(stay) > lower(stay))
);

-- The invariant. Only confirmed/completed nights are exclusive.
alter table booking add constraint no_double_booking
  exclude using gist (
    property_id with =,
    stay with &&
  ) where (status in ('confirmed','completed'));
```

**Upgrades over the original — Stage 1.**

| Area | Original | Upgrade | Why |
|---|---|---|---|
| Auth | Base44, token in `localStorage` | Own auth: argon2id, httpOnly+SameSite cookie, rotation, revocation list, per-IP+per-account rate limits | `localStorage` tokens are exfiltratable by any injected script |
| OTP | 6-digit code, resend | Single-use signed token + 10-min TTL + attempt cap; code hashed at rest | 6 digits is brute-forceable without a cap |
| Overlap | Form check only; imported collisions land as pending | DB exclusion constraint (partial) + confirm-time re-check inside a transaction with `SELECT … FOR UPDATE` | Two concurrent confirms must not both win |
| Dates | No ordering validation | `check_out > check_in`, 1–90 nights, no past dates, capacity check against `property.guests` | Fixes §7.4 #1 and #6 |
| Pricing | Computed in React, displayed, then stored | Server computes from a versioned rule module; row stores `gross_cents`, `commission_bps`, `net_cents`, `rate_version` | A rate edit must not rewrite historical bookings |
| Commission | Implied in UI strings | Single versioned table: direct 0 · airbnb 1500bps · booking_com 1500bps · vrbo 800bps · whatsapp 0 | One place to change, unit-tested (T-35) |
| ICS fetch | Server fetches a user-supplied URL | **SSRF hardening**: HTTPS only, private/link-local IP blocking, redirect cap, size cap, content sniff, `BEGIN:VCALENDAR` check | The original is a server-side request forwarder |
| ICS sync | Refresh button, coarse states | Idempotent upsert by `(feed_id, uid)`, `STATUS:CANCELLED` handling, conditional GET via ETag, exponential backoff, per-feed health (`ok`/`stale`/`failed`, `last_success_at`, consecutive failures) | Missed cancellations are silent double-bookings |
| Conflict UX | "Pick other dates — nothing was saved" dead end | Conflict drawer: compare both stays side by side, then *keep / move / cancel* | Turns a blocker into a decision |
| Lists | 8 × `limit=400`, filter in browser | Per-screen aggregate endpoints + cursor pagination, indexed (`trigram` on name/reference) | p95 and correctness |
| Properties | Raw photo URL paste | Presigned S3 upload, HTTPS-only external URLs, currency + timezone + check-in/out + min/max nights | Photo URLs rot; times drive turnover windows |
| Deletion | Hard delete | Soft delete + archive; refuse deletion while future bookings exist | Protects statement history |
| A11y | Inputs with no label | Explicit `<label for>`, focus trap, Esc to close, live-region errors, AA contrast | Measured defect |
| Badge | Base44 "Edit with" overlay | Removed entirely | The reason for the rebuild (T-03) |

**Exit criteria:** T-01–T-13, T-21–T-42 green; `EXCLUDE` constraint proven by a test that attempts two concurrent confirms and asserts exactly one succeeds; ICS worker survives a cancelled event, a malformed feed, and a stale feed; badge and Base44 SDK absent from the bundle.

---

### 6.2 Stage 2 — "The work behind every stay"

**Goal:** the operational layer that makes the calendar worth having — turnovers, staff, guests, reviews.
**Features:** F-43 – F-61.
**Tests:** T-43 – T-61.

**Upgrades over the original — Stage 2.**

| Area | Original | Upgrade | Why |
|---|---|---|---|
| Turnover creation | Implied by copy, created somewhere client-side | Created in the **same transaction** as the booking; `unique (booking_id, kind)` makes it idempotent | A failed client callback currently loses the turnover silently |
| Turnover window | Fixed 10:00–14:00 / 11:00–15:00 | Derived from `property.checkout_time` + buffer + `checkin_time`, clamped per property | Different properties have different turnarounds |
| Task states | 4 columns + a `BLOCKED` counter with no way to reach it | `blocked` becomes a real state with a mandatory reason string | Dead state today |
| Overdue definition | Dashboard counts 8, board counts 2 — two different definitions | One server-side computed `due_state`, consumed everywhere | Fixes §7.4 #4 |
| Checklist | Fixed 5 items, `n/m checks` display | Per-property, per-kind **templates**, versioned; each tick stores who + when | Enables audit and per-property SOPs |
| Assignment | Free pick from a list | Conflict-aware: refuse assigning one cleaner to two overlapping windows; show workload; honour `active` | Double-booking cleaners is the same class of bug as double-booking guests |
| Staff | Hardcoded `88 % Reliability` | Reliability derived from completion history; `rate` used for task cost | Numbers you can defend |
| Task cost | `expected_cost` only | Actual cost posts to the ledger on completion | Closes the loop into Stage 3 |
| Inbox delivery | Binary `recorded` / `sent` | Adapter interface with three implementations: ESP (email), WhatsApp Business Cloud API (template messages), SMS provider. If unconfigured → recorded-only, and the UI says exactly that | Keeps the honest behaviour, adds real channels where credentials exist |
| Message status | none | Provider message id + webhook status (`queued`/`sent`/`delivered`/`failed`/`read`), retried with idempotency key | Prevents double-send and silent failure |
| Threads | One thread per guest+property | Dedupe on normalised email/phone, merge action, server-side unread counts | Client-side counting drifts |
| Reviews | Manual only | Channel sync where an API exists, reply published back to the channel with its own status | Reply where the guest will actually see it |
| Auto-request | Switch + days, global | Per-guest dedupe, quiet hours, template + personalisation, unsubscribe, scheduler with idempotent runs | Spamming a guest twice is a real cost |

**Exit criteria:** T-43–T-61 green; T-46 and T-53 are the critical pair — a booking always produces exactly one turnover inside the transaction, and a non-email channel never calls a send adapter.

---

### 6.3 Stage 3 — "Money that reconciles itself"

**Goal:** close the month, pay owners, then harden. Plus the parts of the dashboard that need a ledger.
**Features:** F-62 – F-77, plus F-15, F-17, F-18.
**Tests:** T-62 – T-77, T-15, T-17, T-18.

**Upgrades over the original — Stage 3.**

| Area | Original | Upgrade | Why |
|---|---|---|---|
| Ledger | Mutable rows | **Append-only**: DB trigger blocks `UPDATE`/`DELETE`; corrections are reversing entries | Auditability |
| Money type | Implied floats | Integer minor units everywhere; `numeric` never used for cents | Float drift on reconciliation |
| Entry model | Single-sided | Double-entry-lite: every entry has a debit and credit account | Statements and account balances derive from one invariant |
| Statement calc | Recomputed on render | Derived **and snapshotted**: draft recalculates live, approval freezes a snapshot of inputs + lines, paid is immutable | Answers the open question the app could not |
| Fee model | Per-property %, current value | Effective-dated override history; statement stores the bps applied | Backdating a fee change must not rewrite settled months |
| Statement detail | **"View" button that does nothing** (§7.4 #2) | Real detail view: line items → drill-down to the ledger entry that produced each line | The single most visible broken feature |
| Approval | No control exposed | `draft → approved → paid` with actor + timestamp recorded, illegal transitions rejected 409 | Governance |
| Expense | Posts and debits, unclear atomicity | Posts ledger entry and debits the property account in one transaction; balance is derived, not stored | Stored balances drift |
| Reconciliation | none | Nightly job: booking net vs ledger credits vs statement gross; alert on drift | Catches the bugs you cannot see |
| Currency | Hardcoded `KES`, `55K` abbreviation | Currency per portfolio and property, FX snapshot on the entry, locale-aware formatting | Enables a second market |
| Permissions | None in-app (Base44 roles only) | Server-enforced roles: `owner`, `manager`, `cleaner`, `viewer`; row scoping; route guards; audit log | Cleaners must not see owner money |
| Settings | Free-text, no validation | Validated, typed, with effective dates and explicit "requires provider credentials" states | Honest configuration |
| Hardening | none | Idempotency keys on all POSTs, rate limits, PITR backups, structured logs, sync-failure + drift alerting, CI gates (Vitest, integration, Playwright, constraint tests) | Production readiness |

**Exit criteria:** T-62–T-77 green; every statement satisfies `gross − expenses − fee = net` and `fee = gross × bps`; a paid statement rejects modification with 409; the ledger rejects `UPDATE`/`DELETE`; reconciliation job reports zero drift on the seed set.

---

### 6.4 Sequencing, risk and demo-ability

**Hard ordering rules.**
1. The `EXCLUDE` constraint ships before any booking UI is wired. Everything else is decoration until nights are physically exclusive.
2. The ledger becomes the only write path for money before Stage 3 starts. No screen may compute a balance independently.
3. Never begin Stage 2 while Stage 1's overlap tests are red.

**Risk register.**

| Risk | Mitigation |
|---|---|
| ICS feeds change shape per channel | Fixture-based parser tests, one fixture per channel, plus a live smoke feed per channel |
| SSRF on feed URLs | Egress allowlist + private-IP blocking from day one, tested with `127.0.0.1` and `169.254.169.254` fixtures |
| Imported overlaps are legitimate | Partial constraint on `confirmed`/`completed` only; pending rows allowed to collide and are surfaced, never silently confirmed |
| Timezone bugs around midnight check-ins | Store dates + property timezone; test property in two timezones with a 23:30 arrival |
| Demo data hides scale problems | Seed 500 properties / 20k bookings in CI; assert p95 budgets |
| Scope creep from "improvements" | Every upgrade above is tied to a defect ID or a quality-bar row; anything else waits |

**Each stage ends deployable and demoable on its own.** Stage 1 demos a calendar that refuses a second guest. Stage 2 demos an arrival that produces a scheduled turnover and a guest thread. Stage 3 demos a month closed, a statement approved, and an owner paid — with the numbers reconciling on screen.

**Suggested build order within Stage 1:** schema + constraint → auth → properties → booking pricing engine → bookings → calendar → ICS worker → dashboard essentials → a11y pass → perf pass.

---

## 7. Appendix

### 7.1 Route table (observed)

| Route | Auth | Screen |
|---|---|---|
| `/` | public | Marketing landing |
| `/login` · `/register` · `/forgot-password` · `/reset-password` | public | Auth flows |
| `/onboarding` | public* | Workspace setup |
| `/dashboard` | authed | Portfolio overview |
| `/properties` | authed | Property hub |
| `/bookings` | authed | Booking ledger |
| `/calendar` | authed | Unified calendar |
| `/operations` | authed | Turnovers & maintenance |
| `/inbox` | authed | Guest conversations |
| `/reviews` | authed | Reviews & requests |
| `/financials` | authed | Ledger & accounts |
| `/payouts` | authed | Owner statements |
| `/settings` | authed | Workspace settings |

\* outside the `/_authed` parent in the router, but only reachable post-registration.

### 7.2 Third-party surface to eliminate

- `base44Client-CLj3h8Nl.js` (160 KB) — managed data/auth/functions SDK
- `/static/js/badge.js` — the *"Edit with"* badge injector and its "Close badge" control
- `/api/apps/<appId>/entities/*` — managed entity API
- `/api/apps/<appId>/analytics/track/batch` and `/api/app-logs/<appId>/log-user-in-app/<route>` — platform telemetry, ~2 calls per page view
- Base44 hosting/CDN

Page weight today: `index-CxN1QNPD.js` 349 KB + 15 route chunks + 160 KB SDK, with **no** server rendering of authenticated views.

### 7.3 The six open questions — now answered

| # | Question | Answer |
|---|---|---|
| 1 | Field-level validation rules | No native `required` attributes anywhere; validation is JS-side. Only **two** rules are actually enforced: overlap (hard block, §2.4) and `guests min=1` on the input. Management fee accepts any number. See §7.4 for the date gap. |
| 2 | Can manual entry edit channel/commission? | Channel is selectable on the new-booking form and drives commission **automatically**; commission itself is not editable, it is derived from the channel. |
| 3 | Does the inbox really send SMS/WhatsApp? | **No.** Only email. Proven three ways: the *"Recorded only"* badge, the copy *"only email is delivered today"*, and Settings showing WhatsApp Business and SMS **Not connected**. |
| 4 | Real permission model | Base44 platform roles only — `role`/`_app_role: admin`, `collaborator_role: editor`, plus `disabled`, `force_password_reset`, `is_service`. **No in-app role gating**: every authenticated user loads every entity. Single-tenant per app instance. |
| 5 | Are statements recalculated or frozen? | Undeterminable from the UI — **the detail view does not open**. Statuses `Draft`/`Approved`/`Paid` exist but no approve or settle control is exposed. Treat approval as unimplemented (§7.4) and design it deliberately in Stage 3. |
| 6 | Multi-currency | **Single currency per portfolio.** No currency field on the property form; every amount is `KES`, with `55K`-style abbreviation in KPIs and full amounts in tables. |

### 7.4 Defects found in the live app

Worth fixing rather than reproducing:

1. **Check-out can precede check-in.** Setting check-out equal to, or earlier than, check-in produces *"0 nights"*, prices the stay at the cleaning fee alone (`KES 3,000`), and leaves **"Add booking"** enabled. Nothing stops it.
2. **Statement "View" is dead.** Clicking it changes nothing — no panel, no navigation, no request. Statement detail, approval and settlement are unreachable from the UI.
3. **Marketing and data disagree.** The landing page promises *"0 double bookings"*, while the demo portfolio contains a live overlap (`Brian Kimani` vs `test`, both holding 16 Nov at Karen Cottage). The overlap is *flagged and left pending*, which is defensible — but the headline overstates it.
4. **Dashboard turnover count is inconsistent** with the Operations board (`8 due` vs `2 unassigned / 0 due today`) because the two use different definitions with no shared label.
5. **Client-side everything.** 8 × `limit=400` list calls on dashboard load, all filtering in the browser; no pagination, no aggregates.
6. **`guests` accepts 0** despite `min=1` on the input, because the bound is not re-checked at submit.

### 7.5 How this was verified

Every number in §2 was recomputed from independently observed values and compared to the rendered output — 20/20 bookings for the pricing formula, 5/5 statements for the payout formula, and 5/5 properties for the fee-override percentages. Where a value could not be confirmed it is labelled **[inferred]**.

---

## 8. Build progress

The self-check is the gate: `node scripts/selfcheck.mjs` runs `tsc --noEmit`, applies migrations, then runs every test file. A feature is only listed as done when that command exits 0.

### 8.1 Environment

| Piece | State |
|---|---|
| Node.js | 26.13.1 |
| PostgreSQL | 16.16 portable (EDB binaries), port **5433**, database `hostsync`, `btree_gist` 1.7. Start it with `pg_ctl -D %LOCALAPPDATA%\pg16\data -o "-p 5433" -w start`: the data directory's `postgresql.conf` keeps the default 5432, so the port is passed on the command line |
| Runtime deps | `pg`, `fastify`, `@fastify/cookie`, `@node-rs/argon2` |
| Dev deps | `typescript`, `@types/node`, `@types/pg` |
| Runner | Node's built-in type stripping + `node:test` (no build step), run with `--test-force-exit` so a browser file that has finished every test cannot hold the gate open on a lingering Chrome pipe |
| Test concurrency | **1 file at a time** — the machine has 3.4 GB RAM; parallel Fastify/argon2 processes caused `VirtualAlloc` failures |
| UI bundle | React 19 + `@radix-ui/react-dialog` bundled by **esbuild** (291 kB minified) → `public/`, served by Fastify. esbuild instead of Vite/rollup: the rollup graph is the memory-hungry part on this box |
| Browser tests | `playwright-core` driving the **installed Chrome** (`channel: 'chrome'`) — no second browser download |

### 8.2 Stage 1 — done and green

| Feature | Test | What is proven |
|---|---|---|
| F-01 schema | T-01 | Every table, check constraint and FK in migration `001`–`005` |
| F-02 invariant | T-33 | `EXCLUDE USING gist (property_id WITH =, stay WITH &&) WHERE status IN ('confirmed','completed')` — verified by raw SQL that bypasses the service |
| F-03 race | T-41 | Two concurrent confirms: exactly one wins, one gets 409; the database holds the line |
| F-05 register | T-05 | 201, `is_verified = false`, exactly one OTP, argon2id hash, no session cookie |
| F-06 OTP | T-06 | Wrong code sets no cookie; resend invalidates the old code; codes are single-use and hashed at rest |
| F-07 login | T-07 | httpOnly + SameSite=Lax cookie; wrong password 401/422 with no cookie; unverified account refused 403 |
| F-08 reset | T-08 | Token by mail, single use, `force_password_reset` cleared, all existing sessions revoked |
| F-09 guard/logout | T-09 | Anonymous `/dashboard` → 302 `/login`; after logout the old cookie is dead server-side |
| F-10 onboarding | T-10 | Portfolio persisted with name + currency + owner, idempotent on repeat |
| F-21 property cards | T-21 | Rate, beds/baths/sleeps, 30-day occupancy, channel badges, account + balance, next arrival, owner, status |
| F-22 add property | T-22 | Full payload 201; `150 %` fee → 422 with a field error; percent→bps conversion |
| F-23 edit | T-23 | Patch persists on the card and in every future quote |
| F-24 status | T-24 | `onboarding → live`, archive hides from the active list and stays in the archive view |
| F-25 calendar link | T-25 | https URL stored with source; junk and `http://` refused 422 |
| F-26 sync | T-26 | Two events → two pending `MRD-` bookings, `last_synced_at` set, ETag stored, re-sync creates nothing |
| F-27 account | T-27 | Verified reads `KCB 3310`; unverified reads `KCB 3310 · pending`; negative balance allowed |
| F-28 ledger | T-28 | Reference, property, dates, nights, guests, channel, net, payment, status |
| F-29 counters | T-29 | `in house now`, `arriving`, `net booked` equal values derived from the seeded rows |
| F-30 search | T-30 | Matches property name, guest and reference; unrelated rows excluded |
| F-31 filters | T-31 | Status and channel AND together; unknown status is 422 |
| F-32 detail | T-32 | `gross − commission = net` for every row; check-in/out times; overlap list |
| F-33 confirm | T-33 | Clean pending confirms; overlapping pending is refused 409 and stays pending |
| F-34 cancel | T-34 | Cancelled releases the nights; a replacement books them |
| F-35 pricing | T-35 | All five channels: quote = stored row = `nights × rate + cleaning` with the channel's bps |
| F-36 iCal import | T-36 | Cancelled event releases nights; 404 and non-ICS leave existing bookings untouched; oversized refused |
| F-37 grid | T-37 | Five rows × 21 columns; a bar spans exactly its nights; start clipping never goes negative |
| F-39 legend | T-37 | Five channels + `Conflict` + `Turnover scheduled` |
| F-40 sync health | T-40 | Counts match; a failed sync never reads as `Live` |
| F-41 overlap flag | T-41 | Both bars flagged; sheet says `Overlaps 1 other booking` and names the other guest with dates |
| F-14 KPIs | T-14 | Revenue this month, 30-day occupancy, turnovers inside 48 h, rating + review count |
| F-16 calendar clear | T-16 | `CALENDAR CLEAR` with no overlap; flips to `OVERLAP FOUND` on an imported collision |
| F-19 health table | T-19 | Occupancy %, next arrival (`Tomorrow`), account, balance, status, rate |

### 8.2b Stage 1 — UI, done and green (real Chrome, real server, real Postgres)

| Feature | Test | What is proven |
|---|---|---|
| F-01 landing | T-01 | Hero `Add your property. We hold every night.`, eight cards, both CTAs pointing at `/register` and `/login`, the stats strip |
| F-02 explainers | T-02 | All eight cards render **title and body from `web/content.ts`** — the test imports the same fixture the page renders |
| F-03 badge removed | T-03 | No `Edit with`, no `badge.js` tag, no request to any Base44 host; the page loads exactly one script, `/assets/app.js` |
| F-04 toasts | T-04 | One `region[aria-label="Notifications alt+T"]` with a `role="status"` child; a save announces and then clears itself |
| F-11 sidebar | T-11 | All ten destinations route, each marks itself `aria-current="page"`, exactly one is active at a time |
| F-12 identity | T-12 | `Test Owner`, `Signed in`, `TEST · 5 PROPERTIES` — and the pill follows the real count after a sixth property |
| F-13 mobile drawer | T-13 | At 390 px the sidebar is hidden, `Open navigation` opens the drawer with all ten links, and a link navigates |
| F-20 empty state | T-20 | New account: checklist renders, **no** KPI cards, no health table, no page errors |
| F-38 date nav | T-38 | `Next week` moves `from` by exactly 7 days and issues a fresh `/api/calendar` request; `Today` returns to today |
| F-42 bar → sheet | T-42 | Clicking a bar opens the sheet whose reference equals that booking's reference; Esc closes it |
| F-09 guard (browser) | T-09 | Anonymous `/dashboard` lands on the sign-in form, the form really signs in, sign-out closes the door again |

The dashboard screen renders F-14 / F-16 / F-19 from their proven endpoints (F-15, F-17 and F-18 joined it in Stage 3, below), and the calendar screen renders F-37 / F-39 / F-40 / F-41 (their assertions remain the I-level tests, which is where the arithmetic lives).

### 8.2c Stage 2 — the operations board, green so far

| Feature | Test | What is proven |
|---|---|---|
| F-46 auto turnover | T-46 | A confirmed arrival schedules **exactly one** turnover on the check-in day, in the property's 11:00→15:00 window, with the five-item checklist; a pending stay schedules nothing until it is confirmed; confirming twice still yields one; cancelling orphans the task explicitly (`cancelled`, never deleted) |
| F-43 counters | T-43 | `UNASSIGNED`, `DUE TODAY`, `BLOCKED` (two open tasks on one property with overlapping windows), `NEEDS SOMEONE` (work held by a paused member) — all derived from the rows |
| F-44 columns | T-44 | `UNASSIGNED · SCHEDULED · ON SITE · COMPLETE`; every task appears in exactly one column and each count matches its cards |
| F-47 new task | T-47 | Full payload → 201 and the card appears; a blank title → 422 |
| F-48 lifecycle | T-48 | `scheduled → on site → complete → scheduled`, and only those moves |
| F-49 checklist | T-49 | Ticking 3 of 5 shows `3/5`; completing with items open is refused 409 |
| F-76 roster | T-76 | Name, role, phone, rate, reliability; pausing sets `active = false` and removes the member from the assignment pickers while keeping the record |
| F-77 add member | T-77 | Valid member → 201; a bad role → 422; a duplicate phone → 409 |
| F-50 thread list | T-50 | Guest, channel, property, unread badge and snippet for every thread; the counts match the rows |
| F-51 conversation | T-51 | Messages read oldest → newest with the author on each; answering clears the unread badge, a new message raises it again |
| F-52 reply channel | T-52 | The chosen channel is stored on the outbound message |
| F-53 recorded only | T-53 | A WhatsApp or SMS reply is stored as `recorded` and the **mail transport is never called** |
| F-54 email a guest | T-54 | One message through the transport, stored as `sent`; a malformed address is refused before anything goes out |
| F-55 email guard | T-55 | A guest with no address cannot be emailed: 422, nothing sent, nothing stored |
| F-56 reputation KPIs | T-56 | Average 4.50 over 6 reviews, 50 % response rate, 3 awaiting reply — computed from the rows |
| F-57 review feed | T-57 | Newest first, with the owner reply shown where one exists |
| F-58 write a reply | T-58 | The reply is stored, `replied_at` is set, the response rate moves; an empty reply is refused |
| F-59 requests due | T-59 | A stay that finished two days ago is due; one that finished today is not |
| F-60 already requested | T-60 | Asking logs one request; asking again does not create a second |
| F-61 auto-request schedule | T-61 | The switch and the delay are stored and read back; a delay outside 0–30 is refused |

### 8.2d Stage 3 — the money layer, green

| Feature | Test | What is proven |
|---|---|---|
| F-62 financial KPIs | T-62 | Revenue is posted booking credits inside the month; an expense is subtracted; an unpaid stay is **outstanding**, never revenue |
| F-63 monthly series | T-63 | Six buckets, oldest first; only posted money is counted, so a draft credit cannot inflate the chart |
| F-64 settling accounts | T-64 | The paid stay lands in the property account, and the housekeeping expense comes out of the same balance |
| F-65 performance / F-70 fee override | T-65 / T-70 | The property row keeps its own 15 % (1 500 bps), `fee = revenue x bps`, and `net = revenue − expenses − fee` |
| F-66 transaction feed | T-66 | Credits are positive and debits negative, `BOOKING REVENUE` is the credit label, each filter returns only its kind, and an unknown filter is 422 |
| F-67 record an expense | T-67 | The expense is stored as negative money, debits the property account by exactly the amount, and a non-positive amount is refused 422 |
| F-68 / F-69 statements | T-68 / T-69 | The list carries property, owner, period, gross, expenses, fee and net; the KPIs split awaiting release from paid to owners |
| F-71 generate a statement | T-71 | The preview and the stored draft hold identical gross, expenses, fee and net; the draft starts in `draft` |
| F-72 statement statuses | T-72 | `draft → approved → paid`, and nothing else: approving twice or paying a draft is refused |

The Stage 3 exit-criteria upgrades (spec §6.3) are proven by three extra files:

| Upgrade | Test | What is proven |
|---|---|---|
| Append-only ledger | `26-ledger-invariants.test.ts` | A DB trigger refuses `UPDATE`/`DELETE`; amount signs carry direction; a payment flip appends a linked reversing entry that nets to zero instead of rewriting the credit; a booking reversal is revenue going away, never an expense; account balances derive from the ledger |
| Statement freeze | `27-statement-immutability.test.ts` | `gross − expenses − fee = net` and `fee = gross × bps` are DB check constraints; approval and payment record the acting user; regenerating a paid period is a 409 and leaves the snapshot untouched; a paid row cannot be edited even with raw SQL |
| Reconciliation | `28-reconciliation.test.ts` | The nightly job (`npm run reconcile`) reports zero drift on a clean seed set, then names the exact booking, statement and account rows after drift is injected, and returns to zero when they are repaired |
| Statement detail | `29-statement-detail.test.ts` | The "View" button opens a real dialog: lines sum to the statement net, each line drills down to the ledger entry behind it, and approval freezes the lines so a later expense cannot change them |
| Fee history | `30-fee-history.test.ts` | An effective-dated fee override is stored and listed; a backdated change leaves a settled statement's snapshot intact, a new statement uses the rate in force at its period start, and invalid/duplicate overrides are refused |

The screens behind these endpoints are `web/financials.tsx` (F-62–F-67), `web/payouts.tsx` (F-68–F-72) and `web/settings.tsx` (F-73–F-75). They render the server's numbers; the arithmetic above is asserted at the I level.

The dashboard's Stage 3 half:

| Feature | Test | What is proven |
|---|---|---|
| F-15 revenue & occupancy chart | T-15 | Six buckets, oldest first; each bucket's revenue and nights are independently recomputed; occupancy is nights / (days in that month × properties); in the browser the toggle swaps series and `/api/dashboard` is requested **once** |
| F-17 payout widget | T-17 | Draft + approved statements sum to the payable total; a paid statement is excluded from both the amount and the count |
| F-18 turnovers in 48 h | T-18 | Tasks at +24 h and +47 h are listed with property, window, assignee and status; +49 h is not, and the KPI counts the same list |

The properties and bookings screens (F-21–F-35) have their own browser test in `test/24-ui-properties-bookings.test.ts`. The calendar and the ledger open the same `web/bookingSheet.tsx`, so a stay cannot look different depending on where it was opened.

### 8.3 Still to build

| Item | Why it is not done |
|---|---|
| F-45 task card screen | **Done** — the board renders with the four counters, four columns and the full card anatomy; the action moves the card |
| F-47 new task on screen / assignee | **Done** — a `+ New task` dialog creates turnover cleaning work with property, type, priority, date, window, assignee, cost and notes; every card has an assignee picker, so an unassigned job can be handed to a named member and moved back |
| F-50 – F-55 guest inbox | **Done** at the API level and on screen; the thread list, the conversation and the reply composer are live |
| F-56 – F-61 reviews | **Done** at the API level and on screen; the feed, the reply composer and the request lists are live |
| F-62 – F-75 money | **Done** — T-62…T-75 green: KPIs, series, accounts, performance, transaction feed, expenses, statements (draft → approved → paid), portfolio settings, review automation and channel states |
| F-14 – F-20 dashboard | **Done** — T-14, T-15, T-16, T-17, T-18, T-19 and T-20 are green: KPIs, the six-month chart with its client-side toggle, the calendar-clear card, the payout widget, the 48-hour turnover list, the health table and the empty state |
| F-21 – F-36 screens | **Done** — the properties cards and the booking ledger are live; T-24 proves the card, the form, the status, the account, the calendar link, the counters, the search, the filters, the shared booking sheet, confirm, cancel and live pricing in a real browser |
| Ledger writes (Stage 3) | **Done** — money is snapshotted per booking; a paid stay credits the settling account, an expense debits it, and a statement snapshots gross, expenses, fee and net |
| Append-only ledger | **Done** — migration 011/012 sign every entry, block `UPDATE`/`DELETE` in the database, and link a correcting entry to the one it reverses; a single escape hatch exists for account erasure |
| Statement freeze | **Done** — migration 013 checks both statement equations, stores the approving/paying actor, and seals paid rows; regeneration of a frozen period is a 409 |
| Reconciliation | **Done** — `src/reconcile.ts` + `GET /api/financials/reconciliation` + `npm run reconcile` compare bookings, ledger entries, statements and account balances, reporting zero drift on the seed set |
| Onboarding screen | **Done** — F-10 now has a real screen: a verified user without a workspace is redirected from every app page to `/onboarding`, creates the portfolio there, and the dashboard then shows an honest empty checklist; data is in Postgres so it survives re-login |
| Email a guest on screen | **Done** — F-54's "new outbound thread" is now a real "Email a guest" button: property, guest, address, channel and first message create the thread, email is delivered, and WhatsApp/SMS stay honestly recorded-only |
| Local photo upload | **Done** — the property form accepts a photo from the device, resizes it in the browser and stores the compressed image in Postgres; the card renders it. A URL still works. Free hosts have no disk, so nothing is written to the filesystem |
| Statement detail | **Done** — migration 014 freezes line items at approval, `GET /api/statements/:id` exposes them with their ledger entries, and the payouts screen's "View" button opens the drill-down dialog |
| Fee history | **Done** — migration 015 stores effective-dated fee overrides; new statements use the bps in force at their period start, and a backdated change cannot rewrite a settled statement |
| pg DATE handling | **Fixed** — `pg` returns `DATE` as local midnight; date-only fields are now formatted from local components so a statement's period and a fee's effective date cannot shift a day in UTC+3 |
| Phone layout | **Done** — below 900 px the shell becomes one full-width column with a clean brand bar, stacked cards and the original dark slide-in drawer; T-13 asserts the content fills a 390 px viewport with no horizontal overflow |
| Field-worker login | **Done** — migration 016 adds `app_user.account_role`, links a `team_member` to a login, and stores task photos and attributed events. A cleaner gets `/my-jobs` with only assigned work, start/checklist/photo/done, and an installable phone screen; the manager sees the same proof and audit trail on the board |
| Team & access | **Done** — `/team` (sidebar link under the ten destinations) shows the roster, whether each person has a phone login, and lets a manager add a person, issue an email + password, reset it (which ends old sessions) and pause somebody. Cleaners never self-register: the company owns the account |
| Channel indicators | **Done** — the settings boxes are read-only: Airbnb/Booking.com/Vrbo turn on from real calendar feeds, Direct from a manual stay, WhatsApp from a saved business number; a click alone cannot fake a connection |
| Automatic calendar sync | **Done** — the server syncs every workspace at startup (so each wake of a free host refreshes) and every 30 minutes while awake; `npm run sync:calendars` does one pass manually. T-26-style imports stay idempotent across workspaces |

### 8.4 Known deliberate divergences from the original

- Past-dated manual bookings are refused; imports may be historical.
- Capacity is enforced against `property.guests`; the original only checked `guests ≥ 1`.
- A pending import never blocks a confirmed booking; it is surfaced instead, and fails at confirm.
- Passwords are local argon2id hashes; there is no Base44 auth, no `localStorage` token, no badge.
- **Tailwind is replaced by a hand-written stylesheet** (`web/styles.css`, design tokens + AA contrast). Tailwind's CLI is another build step and another process on a 3.4 GB machine; the visual contract is asserted through behaviour and roles, not class names.
- **Vite is replaced by esbuild** for the same reason. No dev server runs beside the API: `npm run build:web && npm start`.
- **TanStack Router/Query are not used**: every navigation is a real document load, which is what lets the server enforce F-09's guard before any markup is sent.
- **Postgres runs on 5433 from a portable 16.16 build**, started with `-o "-p 5433"`; the deployment keeps its own data directory outside the repository.
- **Theme is ported from the original app**: cream `#faf8f5`, ink `#201c18`, gold `#ab7d44`, 228 px dark sidebar, Instrument Serif display type, Inter body, IBM Plex Mono labels, pill buttons. The Google Fonts stylesheet is the only external asset the browser loads.
- **Brand logo** is the owner-supplied `hostsync.jpeg` compass mark, bundled as `/assets/logo.jpeg`, used in the sidebar, landing page, auth screens and as the favicon.

### 8.5 The final gate

`node scripts/selfcheck.mjs` (typecheck → web bundle → migrations → **every** test file, one at a time) ends with:

```
ℹ tests 174
ℹ pass 174
ℹ fail 0
SELF-CHECK PASSED
```

All 77 features (F-01 – F-77) and all 77 contract tests (T-01 – T-77) are covered; the extra 97 assertions are the defect-level tests the original could not ship (constraint races, pricing reproduction, SSRF gates, idempotent sync, honest failure states) plus the Stage 3 exit criteria (append-only ledger, frozen statements, zero-drift reconciliation, real statement detail, effective-dated fees), the HTTPS mail transport used in deployment, and the field-worker access flow.

Reproduce it with:

```powershell
pg_ctl -D %LOCALAPPDATA%\pg16\data -o "-p 5433" -w start
node scripts/selfcheck.mjs
npm run reconcile
```

### 8.6 Free-tier deployment and load check

`DEPLOY.md` is the runbook. The free stack is Render (web service, `render.yaml`), Neon (Postgres), Resend (HTTPS mail, because free hosts block SMTP), GitHub Actions (the gate as a required check) and a CNAME subdomain on the owner's existing domain. `RUN_MIGRATIONS=true` makes the app apply migrations at startup, which free hosts cannot do with a pre-deploy command.

`npm run stress` boots the real server, hammers five endpoints with signed-in traffic, reports per-endpoint p50/p95/p99 and races eight identical bookings to prove the overlap constraint still yields exactly one winner. `BASE_URL=https://… npm run verify:deploy` smoke-checks a live deployment (shell, bundle, stylesheet, auth guard, no Base44 strings).

