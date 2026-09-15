# PrintChecks — Implementation Roadmap

> **Document status:** AUTHORITATIVE — Phase 0 output.
> **Companion document:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) — read it first. Section and
> conflict references below (`C1`, `H9`, `§7.5`, …) resolve to that document.
> **Implementation environment:** Arena AI. Bolt.new is no longer used for this project.

## How to read this roadmap

Each phase lists **Objective · Scope · Deliverables · Exit criteria · Conflicts resolved ·
Depends on**. A phase is *done* only when every exit criterion is objectively verifiable — a
command that passes, a test that asserts a number, a document that exists. "Looks finished" is not
an exit criterion.

**Two hard gates:**

- **GATE 0 →** Phase 1 must not begin until this document and `ARCHITECTURE.md` exist, are
  reviewed, and the open questions in §Phase 0 are answered. **This gate is currently PARTIALLY
  MET**: the documents exist; the questions are unanswered.
- **GATE 5 →** No production cheque printing may be enabled for a (bank, template, printer)
  combination until that combination has passed the physical calibration and MICR validation
  protocol in Phases 5–7.

**Sequencing rationale.** Phases are ordered so each leaves the repository green and no phase
depends on a later one. Domain and numbering precede templates; templates precede the layout
engine; the layout engine precedes MICR integration; MICR precedes calibration — because
calibration measures a real MICR-bearing print. The UI is rebuilt *after* the engine exists (Phase
8), so no effort is spent patching the god components that Phase 8 replaces.

---

## Phase 0 — Foundation & Architecture  ← **CURRENT PHASE**

**Objective.** Establish the authoritative architecture, make the repository honest about its own
state, and remove the noise that would corrupt every later decision.

### Scope

**0.1 Architecture documentation** *(this phase's primary deliverable)*
- `docs/ARCHITECTURE.md` — 15 sections + conflict register + verification record.
- `docs/IMPLEMENTATION_ROADMAP.md` — this document.
- Supersede the legacy Bolt.new-era architecture description.

**0.2 Repository inspection** *(complete — see `ARCHITECTURE.md` Appendix B)*
- Full source inventory; executed build, type-check, lint and all four test suites; binary TTF
  analysis of `micrenc.ttf`.
- 22 Critical, 27 High, 25 Medium/Low conflicts registered with `path:line` evidence.

**0.3 Make CI honest** *(safe, non-behavioural)*
- Add `"test": "pnpm -r run test"` to root `package.json`.
- Add a `Test` step to `.github/workflows/verify.yml`.
- Encode the core→vue build order so a **cold checkout** passes `install → type-check → lint →
  test` in any order. Options: `pretype-check`/`pretest` hooks, tsconfig project references, or a
  development `exports` condition resolving to `src`.

**0.4 Delete verified dead weight** *(deletion only — no behaviour change)*

| Item | Path | Verified reason |
|---|---|---|
| Dead store (365 lines) | `printchecks/src/stores/check.ts` | referenced only by its own test |
| Component backup (~1,500 lines) | `printchecks/src/components/CheckPrinter.vue.backup` | dead copy |
| Orphaned font data (631 lines) | `printchecks/expanded_fonts.js` | imported nowhere; eslint-ignored |
| CI artifact (573 KB, UTF-16LE) | `lint_results.json` | leaks `C:\Users\joshu\...` |
| Empty stylesheet (0 bytes) | `printchecks/src/assets/main.css` | imported at `main.ts:1`, empty |
| Unused assets | `assets/check_bg.jpg` (58 KB), `assets/pmc.png` (4.7 KB) | no source references |
| Unused deps | `print-js`, `printjs`, root `globals` | zero imports |
| Conflicting lockfiles | `printchecks/`, `docs/`, `packages/core/`, `packages/web-components/` `package-lock.json` | repo is pnpm |
| Agent-local config | `.claude/settings.local.json` | not project config |

**0.5 Correct false documentation**
- `docs/reference/changelog.md:19-20` — MICR "unification" and XSS-removal claims are inaccurate
  (`⑆`/`⑈` are absent from the shipped font; `v-html` remains at `CheckPrinter.vue:461`).
- `README.md` — "No Network Requests / 100% Local" is contradicted by `index.html:9,14-16,22`;
  "8.5\" x 11\" paper" contradicts the pre-printed-stock product definition (§1.2).
- Retire or rewrite the remaining legacy `docs/` pages that describe blank-paper cheque generation.

### Deliverables
`docs/ARCHITECTURE.md` · `docs/IMPLEMENTATION_ROADMAP.md` · green cold-checkout CI including tests
· dead code removed · documentation corrected · **answered** decision register (below).

### Exit criteria
- [ ] Both documents exist, are internally consistent, and cross-reference each other.
- [ ] `pnpm install --frozen-lockfile && pnpm type-check && pnpm lint && pnpm test` passes **from a
      clean checkout with no prior build step**.
- [ ] CI runs tests and fails when a test fails.
- [ ] Baseline preserved: **1,324 tests / 41 files still pass**; lint still 0 errors, 0 warnings.
- [ ] Every item in §0.4 is deleted and nothing references it.
- [ ] `git grep -n "print-js\|printjs\|expanded_fonts\|lint_results" -- ':!pnpm-lock.yaml'` returns
      nothing.
- [ ] Every decision below has a recorded answer.

### Decision register — MUST be answered before Phase 1

| # | Decision | Why it gates Phase 1 |
|---|---|---|
| D1 | **Target countries and banks, in order** | Determines MICR standard (E-13B vs CMC-7), coding scheme (ABA/IBAN/sort-code), stock dimensions, amount-to-words locales |
| D2 | **Exact physical stock specification per target bank** — sheet width/height in mm, cheque body origin and size, number of cheques per sheet | Without this, `BankChequeTemplate.paper` cannot be populated and Phase 4 is guesswork |
| D3 | **Is true MICR encoding contractually required, or is optical adequacy acceptable?** | Determines whether `micrenc.ttf` (height:pitch 0.93 vs spec 0.667 — C12) is an asset or must be replaced |
| D4 | **`micrenc.ttf` redistribution licence** | Blocks bundling it in published packages; `publishConfig.access` is already `public` |
| D5 | **Arabic/RTL: Phase 1 requirement or deferred?** | Retrofitting i18n+RTL after templates exist is materially more expensive (H22) |
| D6 | **Single-user or multi-user?** | Determines whether `User`/`Role`/RBAC are early or Phase 10 |
| D7 | **Local-first or server-first?** | Determines whether IndexedDB or Http adapter is built first (Phase 9) |
| D8 | **Browser-only printing, or is a PDF/driver output path required?** | Determines the PrinterAdapter set in Phase 5 |
| D9 | **Does real user data exist that must be migrated?** | Determines whether the §13.4 migrator is built or dropped |
| D10 | **Is `@printchecks/web-components` retained?** | Retaining it triples the rendering surface; it currently cannot render MICR at all (C11) |
| D11 | **Is the `@printchecks/*` npm scope owned by this project?** | A rename is cheap now, expensive after Phase 3 |
| D12 | **Which browsers/printers must be supported?** | CSS paged-media behaviour varies materially (Safari `@page`, Firefox `100vh` in print) |
| D13 | **Money representation confirmed:** integer minor units + ISO currency? | P9 / C21 — affects every model, formatter and report |
| D14 | **Is receipt/invoice functionality retained, dropped, or deferred?** | It is ~2,000 lines across `Receipt`, `ReceiptService`, `receipt-form`, `LineItemManager`, `ReceiptView` and is not part of the stated product definition |

**Conflicts resolved by Phase 0:** documentation drift (M16), CI blindness (H9), cold-checkout
failure (H10), dead-code inventory (M1–M9, M22).
**Depends on:** nothing.

---

## Phase 0 — Implementation Record

Phase 0 was executed. This section records what was actually built, so the plan above and the
code cannot drift apart silently.

### Delivered

New package **`packages/cheque-core`** (`@printchecks/cheque-core`, private, zero runtime
dependencies). It contains four layers:

| Layer | Path | Contents |
|---|---|---|
| domain | `src/domain/` | `Bank`, `BankAccount`, `ChequeBook`, `Cheque`; `ChequeNumber`, `Money`, `CurrencyRegistry`; `ChequeBookSequence`; `ChequeStatus` transition table; 14 typed domain errors |
| ports | `src/ports/` | `BankRepository`, `BankAccountRepository`, `ChequeBookRepository`, `ChequeRepository`, `UnitOfWork`, `UnitOfWorkFactory`, `TransactionCapabilities`, `Clock`, `IdGenerator` |
| application | `src/application/` | `IssueChequeUseCase`, `ChequeCore` composition root, `TRANSACTIONALITY` |
| infrastructure | `src/infrastructure/` | `ChequePersistence`, `RecordStore`, `InMemoryRecordStore`, `LocalStorageRecordStore`, `CryptoIdGenerator` |

**284 tests** added; the existing **1,324** are unchanged and still pass (1,596 total).

### Deviations from the plan above

| # | Plan said | Built instead | Why |
|---|---|---|---|
| **D15** | Two packages: `packages/domain` + `packages/application` | One package `packages/cheque-core` with four internal layer directories, each also a subpath export (`./domain`, `./ports`, `./application`, `./infrastructure`) | The layers are always versioned and released together at this stage; two packages would add publishing churn without adding safety. **The boundary is machine-enforced instead** — see below — so it does not depend on the package graph. It can be split into two packages later without changing any consumer import, because the subpath exports stay stable. |
| **D16** | Phase 1 scope: `MicrLine`, `PhysicalLength`, `ChequeParty`, `ChequePrintJob`, `AuditEvent`, `TemplateRepository`, `PrinterProfileRepository`, domain events | **Deferred to their own phases** (3, 4, 5, 8) | The instruction was to implement the *minimum foundation* for this phase and not to invent MICR placement or physical dimensions. `PhysicalLength`/`MicrLine` belong with the template engine (Phase 3), where real bank stock specifications become available; building them now would mean guessing values that are explicitly UNKNOWN. |
| **D17** | UUIDv7 `IdGenerator` | UUIDv4 via `CryptoIdGenerator` | v4 is what `crypto.randomUUID()` provides natively in every target runtime. v7's time-ordering benefit is real for database index locality but needs a dependency or hand-rolled clock sequencing; the port makes swapping it in later a one-line change. **There is no `Math.random` fallback** — the generator throws if no secure source exists. |
| **D18** | — (not planned) | `src/__tests__/architecture-layers.test.ts` | Consequence of D15. Since the layer boundary is no longer a package boundary, it is enforced by tests that statically scan every source file for illegal cross-layer imports, DOM/Vue/browser-storage references, and numeric coercion of a cheque number. **Verified to fail** by injecting a deliberate violation. |

### Exit criteria status

| Criterion | Status |
|---|---|
| Domain compiles with `lib: ["ES2022"]`, **no DOM**; tests run with `environment: 'node'` | **MET** — `packages/cheque-core/tsconfig.json`, `vitest.config.ts` |
| Zero `from 'vue'` / `from 'pinia'` / `window.` / `document.` / `localStorage` hits in domain | **MET** — asserted by test, not by a manual grep that can rot |
| `Money` arithmetic has no float drift across add/subtract/round/sum | **MET** — `BigInt` internally; `0.1 + 0.2 === 0.30` and `1000 × 0.07 === 70.00` asserted |
| `Money` construction from a float is impossible | **MET** — no `fromNumber`; `fromDecimalString` rejects non-strings, `fromMinorUnits` rejects non-integers |
| `PhysicalLength` branded type | **DEFERRED (D16)** |
| Every legal/illegal status transition asserted | **MET** — `lifecycle.test.ts`, table-driven in both directions |
| Root `pnpm test` works | **MET** — the script was missing entirely; added as `pnpm run build:core && pnpm -r run test`, which also fixes the undeclared build-order failure (H10) |

### Still open after Phase 0

- `printchecks/` still runs entirely on its own legacy models; nothing consumes
  `@printchecks/cheque-core` yet. Wiring the Vue app to it is Phase 2.
- `CheckPrinter.vue` untouched, as instructed. The double-printing defect (C1–C4) is still live.
- No migration path from the legacy `printchecks:checks` blob to per-record storage. The new
  namespace (`printchecks:cheque:v1:`) deliberately does not collide with it, so both can
  coexist during migration — but the migrator itself is not written.
- `amount-to-words` still has five divergent copies. Consolidation is scheduled with the
  printing/template work, where its output is actually consumed.

---

## Phase 1 — Core Domain

**Objective.** Create a pure, framework-agnostic Domain Core with value objects, invariants, ports
and domain events. Prove the layering is real by running it in bare Node with no DOM.

### Scope
- New package `packages/domain` — **zero** Vue, Pinia, `window`, `document`, `localStorage` imports.
- Value objects: `Money` (integer minor units + ISO 4217), `ChequeNumber` (scoped-unique VO),
  `MicrLine`, `PhysicalLength` (mm, type-branded so px cannot be passed by accident), `Uuid`.
- Entity skeletons with invariants: `Bank`, `BankAccount`, `ChequeBook`, `Cheque`, `ChequeParty`,
  `ChequeStatusHistory`, `ChequePrintJob`, `AuditEvent`.
- Cheque state machine (`draft → issued → printed → released → … → cancelled/void/returned`) as an
  explicit, tested transition table — **not** field assignment.
- Ports: `ChequeRepository`, `BankRepository`, `ChequeBookRepository`, `TemplateRepository`,
  `PrinterProfileRepository`, `CalibrationRepository`, `AuditSink`, `IdGenerator`, `Clock`.
- Domain events emitted on every state transition.
- UUIDv7 `IdGenerator` (replacing `Date.now().toString(36) + Math.random()...substr(2)`).
- New package `packages/application` — use-case shells with transaction and audit orchestration.

### Deliverables
`packages/domain` · `packages/application` · in-memory repository implementations for tests ·
state-machine table · domain event catalogue.

### Exit criteria
- [ ] `packages/domain` compiles with `lib: ["ES2022"]` only — **no `DOM`** — and its tests run
      with `environment: 'node'`.
- [ ] `grep -rn "from 'vue'\|from 'pinia'\|window\.\|document\.\|localStorage" packages/domain/src`
      returns **zero** hits (excluding tests that deliberately assert this).
- [ ] `Money` arithmetic is property-tested: no float drift across add/subtract/round/allocate/sum.
- [ ] `Money` construction from a float is rejected or explicitly rounded with a recorded policy —
      `amount: string | number` is impossible to express.
- [ ] `PhysicalLength` is a branded type; assigning a raw `number` of pixels is a compile error.
- [ ] Cheque state machine: every legal transition asserted; every illegal transition throws a
      typed domain error. 100% of the transition table covered.
- [ ] `ChequeStatusHistory` is append-only at the type level (no update/delete method exists).
- [ ] Domain coverage ≥95% statements, **100% of invariants**.
- [ ] All 1,324 legacy tests still pass (the new packages are additive).

**Conflicts resolved:** C15 (partially — entities now exist), C21, H4, H5, H6, H25 (error taxonomy
begins). **Depends on:** Phase 0, D13.

---

## Phase 2 — Banks / Accounts / Cheque Books

**Objective.** Establish the `Bank → BankAccount → ChequeBook` hierarchy and the scoped
cheque-number generator. This is the prerequisite for correct outgoing cheques.

### Scope
- `Bank` as a first-class entity, replacing the denormalised `bankName` string.
- `BankAccount` split from `Bank`; merge the two incompatible current shapes into the union
  (`swiftCode`, `iban`, `branchCode`, `bankLogo` from core; `startingCheckNumber`, `signature`,
  `templateId` from the app).
- `ChequeBook` with `firstNumber`, `lastNumber`, `nextNumber`, `numberPadding`, `status`.
- **`AllocateChequeNumber(chequeBookId)`** use case — atomic with cheque creation.
- Book lifecycle: activate, exhaust, retire, report lost/destroyed.
- **Spoiled-stock recording** — consumes a number with status `void`, reason `spoiled` (§5.4).
- Never-reuse-after-cancel invariant.
- Bank-code-scheme abstraction: ABA routing (reuse the correct mod-10 checksum at
  `utils/validation.ts:31-45`), IBAN check digits (**new**), sort code, BSB, IFSC.
- Repository adapters: in-memory + IndexedDB (per-record, indexed — S1/S2).

### Deliverables
Three aggregate roots with repositories · `AllocateChequeNumber` use case · book lifecycle ·
spoiled-stock flow · IBAN validation · IndexedDB adapter (first real one).

### Exit criteria
- [ ] **Scoped uniqueness proven:** cheques numbered `4567, 4568, 4569, 4570` in Book A **and**
      `4567, 4568, 4569, 4570` in Book B coexist with no violation (the exact case in §5.1).
- [ ] **Global uniqueness is not enforced** — an explicit negative test asserts that two books may
      hold the same number.
- [ ] Allocation is atomic: a concurrent-allocation test produces no duplicate and no gap.
- [ ] After cancelling `4568`, the next allocation is `4569` — and a dedicated test asserts `4568`
      is **never** re-issued, including after book reload.
- [ ] Spoiled stock consumes a number and is queryable.
- [ ] Book exhaustion at `lastNumber` transitions the book to `exhausted` and blocks allocation
      with a typed error.
- [ ] `Cheque.id` is a UUIDv7 and is never derived from or equal to `chequeNumber`; no code path
      uses `chequeNumber` as a key, route param or storage key (asserted by test and review).
- [ ] IBAN check-digit validation passes the official ISO 13616 test vectors.
- [ ] IndexedDB adapter stores **one record per key**, with indexes on `bankAccountId`,
      `chequeBookId`, `status`, `chequeDate`, `direction`.
- [ ] Property tests: monotonic cursor, no reuse, padding correctness.

**Conflicts resolved:** C13, C14, H1, H2, H3, H18 (Bank split out), H26 (partially).
**Depends on:** Phase 1, D1, D2.

---

## Phase 3 — Incoming & Outgoing Cheques

**Objective.** Implement both cheque directions as distinct flows with a shared entity, plus
lifecycle, due dates, deposits, collections and returns.

### Scope
- **Outgoing:** issue from a `ChequeBook`; number allocated automatically (§5.3); amount, payee,
  date, memo, signature mode; `ChequeParty` resolution or ad-hoc snapshot.
- **Incoming:** record exactly as received — `issuingBankName`, `issuingBankCode`, `drawerName`,
  `drawerAccountRef`, `chequeNumber` captured verbatim. **No allocation, no book, no generator
  involvement.**
- `ChequeParty` / `Beneficiary` replacing `Vendor`, with a `partyType` discriminator unifying
  payees and drawers (reconciling the 25-field core `Vendor` with the 4-field app `Vendor`).
- `ChequeStatusHistory` written on every transition; `status` derived, never assigned.
- Due dates, post-dated cheques, and a collection schedule.
- `Deposit`, `Collection`, `ChequeReturn` aggregates with reason codes.
- Cancellation, void, stop-payment — each consuming the number and emitting audit.
- Application use cases: `IssueOutgoingCheque`, `RecordIncomingCheque`, `CancelCheque`,
  `StopPaymentCheque`, `DepositCheque`, `SubmitForCollection`, `MarkCleared`, `MarkReturned`.
- Data migrator from the legacy localStorage namespace (if D9 says data exists).

### Deliverables
Both directions end-to-end in the domain and application layers · party registry · status history ·
deposit/collection/return flows · migration tooling · legacy `@printchecks/core` harvest complete.

### Exit criteria
- [ ] An incoming cheque's number is stored **verbatim** and a test asserts it does not advance any
      `ChequeBook.nextNumber` and is not returned by any outgoing generator.
- [ ] Duplicate incoming numbers raise a **warning**, not a hard failure (§5.5).
- [ ] `Cheque.status` is always equal to the last `ChequeStatusHistory.toStatus` — asserted by
      invariant test on every transition.
- [ ] No code path assigns `status` directly; `grep` for `\.status =` in domain/application returns
      only the history-derived projection.
- [ ] Every audited action in §12.3 emits an `AuditEvent` in the same unit of work; a test fails if
      an action succeeds without its audit record.
- [ ] Amounts round-trip exactly through persist → load → compare for a fuzz corpus including
      `0.01`, `0.10`, `1.005`, `999999999.99`.
- [ ] `amountInWords` is derived once, in the domain, per locale — and the **five** duplicate
      implementations are deleted.
- [ ] Legacy localStorage data migrates losslessly: cheque count, total minor units, statuses and
      void/cancel flags all reconcile; every record gains a UUID and retains `legacyId`.
- [ ] Post-dated cheques cannot be printed before their date without an explicit override that is
      audited.

**Conflicts resolved:** C16 (unification complete), C22 (partially — history now exists), H13,
`incoming/outgoing/deposit/collection/return` gaps from §3 of the product brief.
**Depends on:** Phase 2, D9, D14.

---

## Phase 4 — Template Engine

**Objective.** Replace cosmetic styling with a physical, millimetre-based bank cheque template
model. **The single most important phase for the product definition.**

### Scope
- New package `packages/templates`.
- `BankChequeTemplate` schema per §7.2: `paper{widthMm, heightMm, orientation, bodyOriginMm,
  bodyWidthMm, bodyHeightMm}`, `origin`, `unit: 'mm'`, `fields[]`, `micrProfileId`, `micrField`,
  **`preprinted{…}`**, `version`.
- `TemplateField` schema: mm geometry, **point-based** typography, alignment, overflow policy,
  `maxChars`, `format` directive, `zIndex`, `isPrinted`, `rotationDeg`.
- **Rule T3 enforcement:** the engine must be *incapable* of emitting any glyph or vector that
  `preprinted` declares present. This directly resolves **C1**.
- Template versioning: immutable once published; change creates a new version.
- Template registry and `TemplateRepository`.
- Authoring format (JSON/YAML) plus validation against a schema.
- **First real bank templates** — at least two target banks from D1/D2, populated from measured
  physical stock, not from the screen.
- Delete `CustomizationSettings` as the template model; carry its `fonts`/`colors`/`logo` forward
  only as an optional styling overlay, never as geometry.

### Deliverables
`packages/templates` · template JSON schema + validator · registry · ≥2 measured real bank
templates · `preprinted` suppression contract · template authoring guide.

### Exit criteria
- [ ] No template field can express pixels: a schema test rejects `px`, and `TemplateField.x` is a
      `PhysicalLength` (mm-branded) so a px number is a **compile error**.
- [ ] Typography uses `fontSizePt`; a test rejects px font sizes.
- [ ] **The double-print defect is structurally impossible:** given a template with
      `preprinted.hasDateCaption = true`, no output contains "Date:"; likewise for payee caption,
      memo caption, "Dollars", "Authorized Signature", rules and the amount box. One test per flag.
- [ ] No opaque background may be emitted over the stock — a test asserts no run carries a
      background fill (this is the `background-color: white` defect at `CheckPrinter.vue:402-411`).
- [ ] Two versions of the same template coexist; a job records `templateId` **and** `version`.
- [ ] Each real bank template is accompanied by a **measurement record** (who measured, when, with
      what instrument, on what stock) — not eyeballed from a screenshot.
- [ ] Templates are printer-independent: no offset or scale field exists in the schema (P5, T7).
- [ ] Schema validation rejects malformed templates with actionable errors.
- [ ] `stores/customization.ts` (1,393 lines) and `CustomizationPanel.vue` (2,294 lines) no longer
      own geometry.

**Conflicts resolved:** C1, C2 (design assumption), C8, H19, H20, H21, M23.
**Depends on:** Phase 1, **D1, D2** (blocking — templates cannot be authored without measured
stock specs).

---

## Phase 5 — Precision Printing Engine

**Objective.** Build printing as a first-class subsystem: a pure layout engine in millimetres, an
isolated print document, and swappable output adapters. **Replaces the Vue-component print path
entirely — it is not refactored.**

### Scope
- New package `packages/printing`.
- **Layout Engine** per §8.2: pure `(cheque, template, micrLine) → PrintLayout`. No DOM, no Vue.
  Resolves `format` directives (dates, amounts, amount-in-words per locale, padded numbers),
  applies `overflow` policy (`shrink`/`wrap`/`clip`/`error`), detects collision and out-of-bounds,
  suppresses pre-printed fields, emits a deterministic ordered run list and a stable `layoutHash`.
- **`ChequePrintJob`** aggregate and runner: `created → queued → authorised → rendering → sent →
  completed | failed`, with `attempt`, `isReprint`, `layoutHash`, recorded template version,
  printer profile and calibration.
- **PrinterAdapter port** with two implementations:
  - `BrowserCssPagedMediaAdapter` — builds an **isolated** print document (hidden iframe or a
    dedicated print route; **never the live screen DOM**), sets `@page { size: <W>mm <H>mm;
    margin: 0 }` from the template, positions runs absolutely in mm/pt.
  - `PdfOutputAdapter` — renders the identical `PrintLayout` to PDF, giving a measurable artefact
    for calibration and archival.
- **mm → px preview conversion at an explicit declared DPI**, one-way, display-only. Preview
  geometry never feeds back into print geometry (T5, P3).
- Explicit prohibition, enforced in code review and lint: no `transform: scale()` as a positioning
  mechanism; no `100vh`/`100cqw` in print geometry; no px coordinates in the print path.
- Delete `printCheck()` (`CheckPrinter.vue:1443-1595`) and the injected-`<style>` mechanism once
  the UI is re-pointed (Phase 8).

### Deliverables
`packages/printing` · Layout Engine · `PrintLayout` model · print job runner · two printer
adapters · DPI-declared preview converter · golden-file geometry tests.

### Exit criteria
- [ ] **Layout Engine is pure:** runs in bare Node, `environment: 'node'`, no DOM. A test asserts
      `packages/printing` imports neither `vue` nor `document`.
- [ ] **Golden-file geometry tests** assert exact mm coordinates —
      `expect(run.xMm).toBeCloseTo(42.5, 3)` — for every field of every template. "Renders without
      error" is not an acceptable assertion (TT2).
- [ ] `@page size` is emitted in mm from the template, and a test asserts the value equals
      `template.paper.widthMm × heightMm`.
- [ ] **Zero px in the print path:** a lint rule or test fails the build on `px` in any print
      geometry or `@page` rule.
- [ ] **Zero `transform: scale()` and zero `100vh`/`100cqw`** in print geometry (C4, C5 resolved) —
      asserted by test.
- [ ] Print output is an **isolated document**; a test asserts the live screen DOM is not mutated
      and no `<style>` element is appended to `document.head` (C7 resolved).
- [ ] Both adapters consume the **identical** `PrintLayout`; a test asserts the PDF and the CSS
      paged-media outputs place the same field at the same mm coordinate within tolerance.
- [ ] `layoutHash` is stable across runs for identical input, and changes when any geometry changes.
- [ ] A print job records template version, printer profile, calibration and hash — and a past job
      can be re-rendered byte-identically from those.
- [ ] Overflow, collision and out-of-bounds each produce a typed `LayoutWarning`; `overflow:
      'error'` blocks the job.
- [ ] **GATE 5 established:** production printing is blocked unless a calibration exists for the
      (printer, template) pair — with a warning-only mode for development.

**Conflicts resolved:** C3, C4, C5, C6, C7, and the print-path portion of H8.
**Depends on:** Phase 4 (blocking), D8, D12.

---

## Phase 6 — MICR

**Objective.** Implement MICR as an independent, profile-driven engine — never as a font applied to
a string — and repair the glyph defects that make the current output unprintable.

### Scope
- **`MICRProfile`** per §9.2: standard (E-13B / CMC-7), font binding including `unitsPerEm`,
  `advanceEm`, **`symbolMap`** and **`supportedCodepoints`**, physical `geometry` (charHeightMm,
  charPitchMm, fontSizePt, bandHeightMm, baselineOffsetMm, minClearanceMm), field layout,
  `maxTotalChars`, `requiresMicrToner`, `validationLevel`.
- **`MicrEngine`** per §9.3: `build()`, `validate()`, `geometryFor()`. `MicrLine` is a value object
  carrying encoded text, resolved geometry, per-field spans and validation state — produced **only**
  by the engine.
- Delete all **four** inline MICR assemblies and both delimiter conventions; every renderer
  consumes `MicrLine` from the engine.
- **Bind `micrenc.ttf` through `symbolMap`** (`transit: 'a'`, `onUs: 'b'`, `amount: 'c'`, `dash:
  'd'`) — the mapping established by binary font analysis in §9.5 — instead of hardcoding `⑆`/`⑈`
  or `a`/`c` in components.
- **Ship the font in `packages/printing`** with a proper `@font-face`, so published packages can
  render MICR at all (C11).
- **Font-coverage build test (TT3):** parse the bound font's `cmap` and assert every codepoint in
  `symbolMap`, and every character the engine can emit, resolves to a **non-zero glyph id**. This
  test would have caught C10.
- Replace `validateMICRLineLength()` — which ignores its own routing parameter and hardcodes
  43/9/US (`utils/validation.ts:273-283`) — with profile-driven validation.
- Geometry resolution in **physical units**: derive `fontSizePt` from `charPitchMm` and the font's
  `advanceEm`, then validate the resulting `charHeightMm` against the profile. Never px, never
  affected by a container scale.
- Support E-13B and CMC-7 profile shapes; non-US field layouts.
- **Physical validation protocol** per §9.4: print a MICR test band on real stock with real toner,
  measure pitch and height physically, verify with a MICR reader where available, record
  `validationLevel` / `readerVerifiedAt` / `notes`.

### Deliverables
`MICRProfile` schema · `MicrEngine` · `MicrLine` value object · font coverage test · bundled font +
`@font-face` in the printing package · physical validation protocol and recorded results ·
E-13B and CMC-7 profile templates.

### Exit criteria
- [ ] **Font-coverage test passes:** every emitted codepoint resolves to a non-zero glyph id in the
      bound font. A deliberate regression test asserts that `⑆` (U+2446) and `⑈` (U+2448) are
      **rejected** for `micrenc.ttf` (they map to gid 0), preventing C10 from recurring.
- [ ] **Zero inline MICR assembly:** `grep` for `⑆\|⑈\|⑇\|⑉` across `packages/*/src` and
      `printchecks/src` returns nothing outside the engine's profile-driven mapping and its tests.
- [ ] Published packages render MICR with the correct font — a test asserts an `@font-face` for the
      MICR family exists in the printing package's output (C11).
- [ ] `fontSizePt` is **derived** from `charPitchMm ÷ advanceEm` and asserted numerically; a test
      confirms the computed pitch in mm equals the profile's `charPitchMm` within tolerance.
- [ ] If the font's height:pitch ratio (0.93) cannot satisfy both the 3.18 mm height and 4.76 mm
      pitch of E-13B, the build **fails** with an explicit "non-conforming font" error rather than
      silently printing (C12) — and D3's answer determines whether a compliant font is sourced or
      the existing one re-drawn.
- [ ] Per-field length, total band length, digit-only constraints and routing checksum are all
      profile-driven; a US profile and a non-US profile both validate correctly.
- [ ] `validationLevel` is recorded per profile; a print job for a profile at `'visual'` in a
      deployment requiring reader-grade output warns or blocks per policy.
- [ ] **Physical validation performed and recorded** for at least one (printer, stock, toner)
      combination — measured values, instrument, date, operator. *Until this exists, MICR output is
      declared unverified.*

**Conflicts resolved:** C9, C10, C11, C12, H24, M23.
**Depends on:** Phase 5 (the MICR band is laid out by the Layout Engine), **D3, D4** (blocking).

---

## Phase 7 — Printer Profiles & Calibration

**Objective.** Separate device behaviour from the template, and close the loop between predicted
and actual physical output. Without calibration the system cannot claim precision.

### Scope
- **`PrinterProfile`** per §8.4: identity/make/model, `paperFeed`, `trayId`, `orientation`,
  `duplex`, `nominalDpi`, nominal `xOffsetMm`/`yOffsetMm`, nominal `scale`,
  `unprintableMarginMm`, `supportsCustomPageSize`, `colourMode`, **`micrTonerCapable`**.
- **`PrinterCalibration`** per §8.5 — **independently stored and applied**, keyed by
  `(printerProfileId, templateId)`: measured `offsetXMm`/`offsetYMm`, `scaleX`/`scaleY`,
  `skewDeg`, `method`, `confidence`, `measuredAt`, `measuredBy`.
- **Application order:** `final = (templateMm + profileOffset) × profileScale + calibrationOffset`,
  with calibration scale applied last. Implemented once, in the layout/transform stage, and unit
  tested.
- **Calibration workflow:** generate a registration test page carrying known mm rulers and target
  boxes for the specific stock; print it; measure the deviation; store the calibration. Provide a
  UI for entering measurements and for iterating to convergence.
- **MICR verification step** integrated into calibration, feeding `MICRProfile.validationLevel`
  (Phase 6).
- Missing-calibration policy: warn or block; **never silently assume zero**.
- Printer profile management UI (Phase 8 renders it; the model and use cases live here).

### Deliverables
`PrinterProfile` + `PrinterCalibration` aggregates and repositories · transform pipeline with
tests · registration test-page generator · calibration capture workflow · missing-calibration
policy · per-(printer, stock) calibration records.

### Exit criteria
- [ ] Templates contain **no** printer offsets or scaling; printer profiles contain **no** template
      geometry — asserted by schema tests on both (P5).
- [ ] Changing a printer profile requires **no** template edit, and changing a bank template
      requires **no** re-calibration of the printer — both asserted by test.
- [ ] The transform application order is unit-tested with non-trivial values, including a case
      where profile scale ≠ 1 and calibration offset ≠ 0, verifying the exact expected mm result.
- [ ] A registration test page can be generated for any (template, printer) pair and prints rulers
      at true mm.
- [ ] Calibration is stored per `(printerProfileId, templateId)`; two printers using the same
      template hold **independent** calibrations.
- [ ] Printing with **no** calibration for the pair produces a typed warning, and in strict mode
      blocks the job — a test asserts it never silently proceeds with zero offsets.
- [ ] `micrTonerCapable: false` on a profile blocks or warns for MICR-bearing jobs.
- [ ] At least one real (printer, stock) pair is calibrated and the measured residuals recorded;
      residual error after calibration is documented in mm.
- [ ] **GATE 5 enforced:** production printing for an uncalibrated pair is blocked.

**Conflicts resolved:** C17, and completes C3/C5 by making physical accuracy achievable and
measurable.
**Depends on:** Phase 6, D12, physical access to a printer and real stock.

---

## Phase 8 — UI

**Objective.** Rebuild the UI as a thin presentation layer over application use cases. **The two
god components are replaced, not patched.**

### Scope
- New/rebuilt Vue layer bound to `packages/application` use cases; no business rules in components.
- **Decompose `CheckPrinter.vue` (2,215 lines)** into: `ChequeForm`, `ChequePreview`,
  `PartyPicker`, `ChequeBookPicker`, `PrintDialog`, `PrintJobPanel`, plus composables
  `useIssueCheque`, `usePrintJob`. Target ≤300 lines each (P12).
- **Decompose `CustomizationPanel.vue` (2,294 lines)`** into a template-field editor operating on
  the mm schema, plus a styling overlay editor.
- **mm-based preview renderer** driven by `PrintLayout` at a declared DPI, with calibration guides,
  a mm ruler overlay, and `isPrinted: false` guides visible only in preview. Replaces
  `CheckRenderer.vue` (604 lines, px canvas).
- Incoming vs outgoing cheque flows as distinct journeys.
- Cheque book management: list, activate, exhaust, retire, record spoiled stock, show next number.
- Cheque register: search, filter, sort, paginate — over repository indexes, not in-memory arrays.
- Cheque detail with full **status history timeline** and **audit trail** view.
- Template management: list, version, edit field geometry in mm, assign to a book.
- Printer profile and calibration UI (the calibration capture workflow from Phase 7).
- Print job queue: view, authorise, retry, reprint with attempt tracking.
- Deposit / collection / return flows.
- Reports and export (CSV, PDF).
- **Rendered error surface** — `appStore.errors` is currently written but never displayed; replace
  `alert()` and `window.location.reload()` control flow.
- Router rebuild: nested routes, params, guards, `meta`, 404 catch-all, scroll behaviour.
- i18n + RTL foundation if D5 requires it: message catalogues, `dir="rtl"` handling, RTL-aware
  layouts, Arabic amount-to-words.
- **Vendor all front-end assets locally**; remove the jsdelivr and Google Fonts `<link>`/`<script>`
  tags; add a CSP (SEC6).

### Deliverables
Rebuilt views and components · mm preview renderer · cheque register and detail · book management ·
template editor · printer/calibration UI · print job queue · reports · i18n/RTL (per D5) ·
locally-vendored assets + CSP.

### Exit criteria
- [ ] **No component exceeds ~300 lines** without a recorded justification; `CheckPrinter.vue` and
      `CustomizationPanel.vue` no longer exist in their current form.
- [ ] **No component contains print geometry, print CSS, `@media print` rules or
      `window.print()`.** A test/grep asserts zero hits outside `packages/printing` and its adapter.
- [ ] No component performs persistence: zero `secureStorage.*` or `localStorage.*` calls in
      `views/` and `components/` — all access flows through application use cases (resolves H12).
- [ ] Preview renders from `PrintLayout` in mm; a test asserts the px positions shown are derived
      from mm at the declared DPI, and that changing DPI changes preview px **without** changing
      print geometry (T5).
- [ ] Every use case has a component test; **no business logic is asserted in component tests** —
      logic assertions live in the domain/application suites.
- [ ] Errors surface in the UI; a test asserts a failed save renders a visible error (P11, H25).
- [ ] Status history and audit trail are visible for any cheque.
- [ ] All routes have guards and `meta`; a 404 catch-all exists.
- [ ] **Zero external network requests** at runtime: a build test asserts no `cdn.` or
      `fonts.googleapis.com` reference in `index.html` or the bundle (SEC6, H17).
- [ ] jsdom configured for component tests (`environment: 'jsdom'`), resolving M18.
- [ ] If D5 = yes: the app renders correctly in RTL with Arabic amount-to-words, and a visual test
      covers both directions.
- [ ] e2e (Playwright): issue → allocate number → preview → print job → void → reprint.

**Conflicts resolved:** C2 (UI assumption), H7, H11, H12, H22, H25, M10, M11, M12, M15, M25, H17.
**Depends on:** Phases 3–7 (the UI presents what the engine produces), D5, D6, D10.

---

## Phase 9 — Storage / API

**Objective.** Complete the adapter triad: local-first persistence, then a remote API, then ERP —
all interchangeable behind the same ports, with no change to the Domain Core.

### Scope
- **`IndexedDbRepository`** as the primary local store — per-record, indexed, transactional
  (S1–S3). Harvest and reuse `StorageAdapter`, `SecureStorageAdapter` and `LocalStorageAdapter`
  from `packages/core/src/storage/` as the low-level seam and encryption decorator.
- **`LocalStorageRepository`** retained as a thin bootstrap/fallback only, with an explicit 5 MB
  ceiling warning.
- **Binary asset store** — cheque images, logos, generated PDFs to IndexedDB blobs / OPFS / object
  storage. **Never** base64 data URLs inside a record (S7).
- **`HttpApiRepository`** — DTO ↔ domain mapping at the boundary, external-ID mapping, idempotency
  keys on every mutation, injected token provider (no secrets in storage — SEC2), retry with
  exponential backoff + jitter, circuit breaker, explicit offline mode, optimistic concurrency via
  version/ETag, server-side pagination and filtering, typed HTTP→domain error mapping.
- **`SyncingRepository`** — local write first, queued upstream sync, deterministic conflict
  resolution. **Financial records are never silently auto-resolved** — conflicts surface to a human
  (S8).
- **`ErpRepository`** — ERP DTO mapping plus an event-shaped connector subscribing to domain events
  (§15.4).
- **Schema migration framework** — versioned migrations with a recorded schema version (S6),
  replacing the `version: '1.0'` string.
- **Failures propagate** — every write error reaches the caller and the UI (S4, P11). Replaces the
  catch-and-log at `stores/history.ts:216-224`.
- **Import validates** — imports instantiate models and run validation before writing (S5),
  replacing `ImportExportView.vue:535-539`.
- Backup / restore with integrity checks.
- Offline support: service worker, PWA manifest, offline queue.
- Encryption: in-memory non-extractable `CryptoKey`; remove the plaintext `sessionStorage`
  password (`App.vue:39`); rate-limit and lock out verification attempts (SEC4); remove the
  `Math.random()` password fallback (SEC5).

### Deliverables
Four repository adapters · one shared contract-test suite · sync engine with conflict resolution ·
migration framework · binary asset store · backup/restore · offline support · hardened encryption.

### Exit criteria
- [ ] **One adapter contract suite passes identically** against in-memory, IndexedDB, LocalStorage,
      Http and ERP implementations (§14.2) — proving P10.
- [ ] **The Domain Core is unchanged** by the addition of any adapter: `git diff --stat
      packages/domain` is empty for this phase.
- [ ] Records are stored **per-record**; a test asserts that saving one cheque does not rewrite any
      other cheque (C18 resolved).
- [ ] Reads are index-backed; a test asserts a filtered query does not load the whole collection.
- [ ] Cheque creation + `nextNumber` advance commit **atomically**; a failure mid-transaction
      leaves neither partially applied (S3).
- [ ] A simulated quota/write failure **surfaces in the UI**; a test asserts it is never swallowed
      (C19, S4).
- [ ] An import containing an invalid record is rejected with a per-record error report; nothing
      invalid is written (S5, H14).
- [ ] Idempotency: replaying a mutate request with the same key does not allocate a second cheque
      number or create a duplicate.
- [ ] Optimistic concurrency: a conflicting update is detected and surfaced, never silently
      overwritten.
- [ ] Offline: writes made offline sync on reconnect, in order, with conflicts surfaced.
- [ ] Migrations run forward from the legacy schema and are recorded with a version; a downgrade
      path or an explicit refusal is defined.
- [ ] No secret is persisted: a test asserts `sessionStorage`/`localStorage` contain no password or
      raw key material (SEC2, H15).
- [ ] Verification failures trigger backoff and lockout; the `Math.random()` fallback is removed
      (SEC4, SEC5, M19, M20).
- [ ] Service worker + manifest present; the app functions with the network disabled (which also
      makes the local-first claim true).

**Conflicts resolved:** C18, C19, C20, H14, H15, H16, H23, H26, M13, M19, M20.
**Depends on:** Phase 3 (domain stable), D7, D8.

---

## Phase 10 — Security, Audit & Enterprise Features

**Objective.** Make the system defensible and auditable: identity, authorisation, a tamper-evident
audit chain, reporting, and multi-language/multi-currency maturity.

### Scope
- **`User` and `Role`** entities; RBAC with permissions per action and per entity scope
  (e.g. "may void cheques on accounts in business unit X").
- **Authorisation enforced in the application layer** — every use case checks permission before
  acting (SEC10). UI hiding is never authorisation.
- **`AuditEvent` chain** per §12.2: append-only, field-level `before`/`after` diff, chained
  `integrityHash = H(event ‖ previousHash)`, context including `templateVersion`,
  `printerProfileId`, `calibrationId`, `layoutHash`.
- All mandatory audited actions from §12.3 wired: cheque lifecycle, numbering allocation, printing,
  reference data, security events.
- **Audit rules A1–A7:** no update/delete, tamper evidence, same-unit-of-work emission, print
  reproducibility, masked sensitive values in payloads, configurable retention with export to
  immutable external storage, separately permissioned audit reads.
- **Reporting engine:** cheque register, outstanding/post-dated, returns and dishonours, bank
  reconciliation support, cheque-book usage and stock levels, amount-in-words verification report,
  print job log, audit log. Export to CSV and PDF. Date-range and per-bank/account/book scoping.
  Replaces the ad-hoc in-component statistics in `AnalyticsView.vue` (305 lines) and
  `CheckPrinter.vue:1263-1370`.
- **Multi-currency maturity:** currency fixed at `BankAccount`, explicit recorded FX conversion
  where a cheque currency differs, per-locale amount-in-words, currency-aware reports. Replaces the
  two conflicting closed `Currency` unions (7 codes in core, 4 in the app).
- **i18n / RTL completion** (if deferred from Phase 8): full message catalogues, Arabic
  amount-to-words, RTL-aware cheque layouts where a bank's stock requires it, country-aware
  validators replacing the US-hardcoded `validateStateCode` / `validateZipCode` /
  `validateRoutingNumber` defaults.
- **Security hardening:** CSP, no `v-html` on any cheque data path (M11), masked-by-default account
  numbers in UI, logs, exports and error messages (SEC8), dependency vulnerability scanning as a CI
  gate, secret-handling review, threat model documented.
- **Data retention and deletion policy**, including the legal-tension decision between audit
  immutability and right-to-erasure.
- Accessibility audit (WCAG AA) across the UI.
- Performance targets: register query latency, print job throughput, offline sync backlog handling.

### Deliverables
`User`/`Role`/RBAC · tamper-evident audit chain · reporting engine with CSV/PDF export ·
multi-currency and FX · completed i18n/RTL · security hardening and documented threat model ·
retention policy · accessibility conformance · performance baselines.

### Exit criteria
- [ ] Every use case enforces authorisation; a test per permission asserts that an unauthorised
      actor is rejected **in the application layer**, not merely hidden in the UI.
- [ ] The audit chain is **tamper-evident**: modifying or removing any event breaks verification,
      and a test asserts the break is detected.
- [ ] Audit records are **append-only at the type level** — no update or delete method exists (A1).
- [ ] Every action in §12.3 emits an audit event in the same unit of work; a test fails if an
      action can succeed without its audit record (A3).
- [ ] **Print reproducibility:** given a historical job's `templateId+version`, `printerProfileId`,
      `calibrationId` and `layoutHash`, the identical `PrintLayout` is regenerated byte-for-byte
      (A4).
- [ ] No full bank account number appears in any audit payload, log line, export or error message —
      asserted by test (A5, SEC8).
- [ ] Reports produce identical totals to the underlying records for a seeded corpus, including
      across currencies with recorded FX.
- [ ] Multi-currency: a cheque in a currency differing from its account's records an explicit FX
      conversion; the two conflicting `Currency` unions are replaced by ISO 4217 validation.
- [ ] If i18n/RTL in scope: the full UI renders in Arabic with correct direction, Arabic
      amount-to-words is correct for a validated sample set, and no US-only validator rejects valid
      non-US data.
- [ ] Zero `v-html` on any cheque data path (M11).
- [ ] CSP enforced; a test asserts no inline script and no external origin is required at runtime.
- [ ] Dependency scanning is a CI gate; no moderate-or-higher unresolved advisory.
- [ ] A documented threat model exists and is reviewed against SEC1–SEC11.
- [ ] WCAG AA conformance verified on all primary journeys.

**Conflicts resolved:** C22 (complete), H22 (complete), M11, M19, M20, M25, and the
permissions/audit/reporting/multi-currency/Arabic gaps from §3 of the product brief.
**Depends on:** Phases 3 and 9; D5, D6.

---

## Summary — conflict coverage by phase

| Conflict class | Resolved in |
|---|---|
| **C1** double-prints pre-printed form furniture | **Phase 4** (`preprinted` + rule T3) |
| **C2** blank-paper/voucher design assumption | **Phase 4** (design) + **Phase 8** (UI) |
| **C3** px as source of truth · **C4** transform-scale · **C5** no mm · **C6** no paper size · **C7** print as Vue component | **Phase 5** |
| **C8** no template engine | **Phase 4** |
| **C9** no MICR engine · **C10** absent glyphs · **C11** no font in packages · **C12** pitch non-conformance | **Phase 6** |
| **C13** global numbering · **C14** no ChequeBook | **Phase 2** |
| **C15** missing entities | **Phase 1** (skeletons) → **Phase 2/3** (complete) |
| **C16** two divergent cores | **Phase 3** |
| **C17** no printer profile / calibration | **Phase 7** |
| **C18** collection-blob persistence · **C19** silent data loss · **C20** key-namespace split | **Phase 9** |
| **C21** float money | **Phase 1** |
| **C22** no audit / users / roles | **Phase 3** (history) → **Phase 10** (complete) |
| **H9** CI runs no tests · **H10** cold-checkout failure · **M1–M9** dead code · **M16** doc drift | **Phase 0** |
| **H7/H11/H12** god components, logic in UI · **H25** unrendered errors · **M10–M12, M15** | **Phase 8** |
| **H15–H17** password/encryption/CDN | **Phase 8** (CDN) + **Phase 9** (secrets) |
| **H22** i18n/RTL | **Phase 8** (foundation) → **Phase 10** (completion) |
| **H23** no API/ERP | **Phase 9** |

---

## Immediate next step

**Complete Phase 0.** The architecture documentation deliverable is satisfied by
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and this roadmap. What remains before Phase 1 may start:

1. **Answer the 14 decisions in the Phase 0 decision register.** D1 (target countries/banks),
   D2 (measured stock specifications) and D3 (is true MICR required?) are **blocking** — Phase 4
   cannot author templates without D2, and Phase 6 cannot decide whether `micrenc.ttf` is an asset
   or a liability without D3.
2. **Execute Phase 0.3** — add the root `test` script, the CI test step, and the encoded build
   order, so a cold checkout is green. This is small, safe and unblocks trustworthy verification of
   every later phase.
3. **Execute Phase 0.4** — delete the verified dead code inventory.
4. **Execute Phase 0.5** — correct the false documentation claims.
5. **Re-verify the baseline:** 1,324 tests pass, lint clean, cold-checkout green.

Only then does GATE 0 open and Phase 1 (`packages/domain`) begin.

> **CRITICAL RULE (restated):** Phase 1 implementation must not start until Phase 0 architecture
> documentation is complete **and verified**. The documentation now exists; the decision register
> above is the remaining verification step, and it requires answers that cannot be derived from the
> repository.
