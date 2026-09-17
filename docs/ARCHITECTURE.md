# PrintChecks — Architecture

> **Document status:** AUTHORITATIVE — Phase 0 output.
> **Supersedes:** the previous `docs/ARCHITECTURE.md` (Bolt.new-era description of a blank-paper
> cheque printer). That description is obsolete and must not be used as a design reference.
> **Companion document:** [`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md)
> **Implementation environment:** Arena AI. Bolt.new is no longer used for this project.

This document defines the **target** architecture for PrintChecks as a cheque management and
precision printing system, and records the measured gap between that target and the repository as
it exists at commit `7c8b81e`.

Every current-state claim below is grounded in a `path:line` reference. Where a fact could not be
established from the repository it is marked **UNKNOWN — requires verification**.

---

## 1. Product definition

### 1.1 What PrintChecks is

PrintChecks is a **cheque management and precision printing system**. It records, tracks and
prints cheques — both cheques an organisation issues (outgoing) and cheques it receives
(incoming) — across banks, accounts and cheque books, with a full lifecycle, audit trail and
permission model.

### 1.2 The printing target — non-negotiable

**PrintChecks always prints onto PRE-PRINTED BANK CHEQUE STOCK supplied by the issuing bank.**

The bank's visual cheque design — logo, security background, field rules, captions
("Pay to the order of", "Date", "Memo", "Dollars", "Authorized Signature"), the amount box, and
the bank/routing artwork — **is already physically printed on the paper**.

The application prints **only the variable cheque data** onto that existing physical form:

- account holder / drawer name and address (where the stock does not pre-print it)
- cheque number (human-readable position)
- date
- payee name
- numeric amount
- amount in words
- memo / reference
- signature (where printed rather than wet-signed)
- the MICR line

The application **must not** be designed around generating or printing a complete cheque on blank
white paper. Blank-paper cheque generation is explicitly **out of scope** and must not be
reintroduced.

### 1.3 The core engineering problem

Because the form is already on the paper, printing is a **registration** problem, not a
**layout composition** problem. The application must place ink at precise physical coordinates
relative to the paper edge, matching a physical artefact it cannot see. Therefore:

- All layout coordinates are expressed in **physical units (millimetres)**.
- Screen pixels are **never** the source of truth for physical printing.
- CSS `transform: scale()` is **never** the precision mechanism.
- Browser preview geometry is **never** assumed to equal physical printer geometry.
- Every printer/template combination is **calibrated** against real stock.

### 1.4 Product boundary

| In scope | Out of scope |
|---|---|
| Outgoing cheques from cheque books | Printing complete cheques on blank paper |
| Incoming cheques (recorded as received) | Cheque artwork / security background design |
| Banks, accounts, cheque books, beneficiaries | Bank-side clearing or settlement |
| Lifecycle, status history, due dates | Direct bank network connectivity (initially) |
| Deposits, collections, returns, cancellations | Full double-entry general ledger |
| Templates, printer profiles, calibration, print jobs | Receipt/invoice generation as a primary product |
| Reports, audit trail, permissions | Payroll |
| Multi-currency readiness, Arabic/RTL readiness | — |
| Future ERP/API integration | — |
| Local-first / offline where practical | — |

---

## 2. Architectural principles

**P1 — Layered, dependency-inward.**
`UI → Application → Domain Core → Infrastructure/Adapters`. The Domain Core depends on nothing
outside itself. It must not import Vue, Pinia, Vue Router, `localStorage`, `window`, `document`,
or any I/O. Adapters depend on the Domain Core, never the reverse.

**P2 — The Domain Core is framework-agnostic and runtime-agnostic.**
It must be constructible and fully testable in a bare Node process with no DOM. This is what makes
"eventually running with local storage / an API backend / ERP integration / different printer
implementations" a configuration choice rather than a rewrite.

**P3 — Physical units are the source of truth for print geometry.**
Millimetres, from the paper edge, for every coordinate and dimension. Pixels appear only as a
derived, display-time concern (preview rendering), computed from mm via an explicit, declared DPI.

**P4 — Printing is a first-class subsystem, not a component.**
The printing engine is a library with its own package boundary, its own data model
(template + data + profile + calibration → layout → job), and its own tests. It is **not**
implemented as a large Vue component and must not emit DOM side effects from the domain layer.

**P5 — Separation of the four printing concerns.**
*What* to print (cheque data) is separate from *where* it goes (template), from *how the device
behaves* (printer profile), and from *how this specific device deviates* (calibration). Changing a
printer must not require editing a bank template. Changing a bank must not require re-calibrating
a printer.

**P6 — MICR is an engine, not text.**
MICR is not a font applied to a string. It is a profile-driven encoding subsystem with its own
symbol mapping, field-length rules, pitch/height geometry, and validation. On-screen rendering
correctness is **never** treated as evidence of bank/reader-grade output.

**P7 — Identity and business number are distinct.**
Every aggregate has an internal immutable UUID identity. Business numbers (cheque number, account
number, bank code) are attributes with scoped uniqueness — never the identity, never globally
unique by assumption.

**P8 — State transitions are events, not mutations.**
Cheque status is an append-only history. Overwriting a status field is prohibited. Every
domain-significant action emits an audit event.

**P9 — Money is exact.**
Amounts are integer minor units plus an explicit currency code. Binary floating point is prohibited
for monetary values. `string | number` unions for money are prohibited.

**P10 — Adapters are interchangeable behind one port.**
Persistence is reached only through a port. `IndexedDbAdapter`, `LocalStorageAdapter`,
`HttpApiAdapter` and an ERP adapter are substitutable without touching the Domain Core or the
Application layer.

**P11 — Failures are surfaced, never swallowed.**
A persistence failure on a cheque record is a user-visible error, not a `console.error`. Silent
data loss is treated as a defect of the same severity as a wrong amount.

**P12 — Prefer small, tested modules over large untested ones.**
No component or module exceeds ~300 lines without justification. Critical subsystems
(printing, MICR, numbering, money) require tests before they are considered done.

**P13 — Documentation describes the code that exists.**
Claims in `README.md`, `docs/` and changelogs must match the implementation. Known divergences are
tracked as defects (see Appendix A).

---

## 3. Domain model

### 3.1 Current state (measured)

The repository contains **two divergent, non-integrated domain models**:

| | `packages/core/src/models/` | `printchecks/src/types/` |
|---|---|---|
| Entities | `Check`, `BankAccount`, `Vendor`, `Receipt` | `CheckData`, `LegacyCheckData`, `CheckTemplate`, `CheckPrintJob`, `BankAccount`, `Vendor`, `ReceiptData`, `PaymentRecord` |
| Bank name field | `bankName` | `name` (labelled "Bank Name" at `BankAccountModal.vue:20`) |
| Account type | `'checking' \| 'savings' \| 'business'` | free `string` |
| Starting cheque # | absent | `startingCheckNumber: number` |
| SWIFT / IBAN / logo | present (`BankAccount.ts:26-33`) | absent |
| Vendor richness | 25 fields | 4 fields (`types/vendor.ts`) |
| `Currency` | 7 codes (`models/common.ts:34`) | 4 codes (`types/common.ts:44`) |

`printchecks/` does **not** depend on `@printchecks/core` — verified: zero references in
`printchecks/src`, `printchecks/package.json` and `printchecks/vite.config.ts`.

**Of the 16 target entities, 0 exist.** Verified by searching for `class|interface|type <Name>`
across `packages/*/src` and `printchecks/src`:

`Bank` 0 · `ChequeBook` 0 · `ChequeParty`/`Beneficiary` 0 · `ChequeStatusHistory` 0 ·
`BankChequeTemplate` 0 · `TemplateField` 0 · `MICRProfile` 0 · `PrinterProfile` 0 ·
`PrinterCalibration` 0 · `AuditEvent` 0 · `User` 0 · `Role` 0 · `CheckPrintJob` **1 declaration
(`printchecks/src/types/check.ts:88`) with zero usages — dead**.

### 3.2 Target domain model

```
Bank 1 ──── * BankAccount 1 ──── * ChequeBook 1 ──── * Cheque
  │                 │                                   │
  │                 └── 1 BankChequeTemplate            ├── * ChequeStatusHistory
  │                          │                          ├── * ChequeLine / attachment
  │                          └── * TemplateField        ├── 1 ChequeParty (payee)
  │                                   │                 └── * ChequePrintJob
  │                                   └── 1 MICRProfile
  │
  └── * PrinterProfile 1 ──── * PrinterCalibration

Cross-cutting:  * AuditEvent      User * ──── * Role
                Deposit / Collection / ChequeReturn  (reference Cheque)
```

#### Bank
Reference data for a financial institution. Not currently modelled — `bankName` is a denormalised
free-text string on `Check` (`models/Check.ts:19`) and `BankAccount` (`models/BankAccount.ts:18`).

```ts
interface Bank {
  id: string                      // UUID
  code: string                    // internal, unique per tenant
  name: string
  nameLocal?: string              // e.g. Arabic name
  country: string                 // ISO 3166-1 alpha-2
  bankCodeScheme: 'aba-routing' | 'iban' | 'sort-code' | 'bsb' | 'ifsc' | 'other'
  micrProfileId?: string
  defaultTemplateId?: string
  isActive: boolean
}
```

#### BankAccount
An account held at a `Bank`. Replaces both current incompatible `BankAccount` shapes.

```ts
interface BankAccount {
  id: string                      // UUID
  bankId: string
  holderName: string
  accountNumber: string           // displayable; masked in UI
  accountNumberMasked: string     // derived, never stored in plaintext logs
  routingNumber?: string          // ABA, when bankCodeScheme = 'aba-routing'
  iban?: string
  swiftCode?: string
  branchCode?: string
  accountType: 'checking' | 'savings' | 'business' | 'other'
  currency: string                // ISO 4217
  isDefault: boolean
  isActive: boolean
}
```

#### ChequeBook
**New and central.** A physical book of pre-printed cheque stock issued against a `BankAccount`,
owning an independent cheque-number sequence. See §6.

```ts
interface ChequeBook {
  id: string                        // UUID
  bankAccountId: string
  label: string                     // e.g. "Book 12"
  stockReference?: string           // bank's own stock/book identifier
  templateId: string                // BankChequeTemplate for this stock
  firstNumber: string               // inclusive
  lastNumber: string                // inclusive
  nextNumber: string                // cursor; advances monotonically
  numberPadding: number             // e.g. 4 → "0001"
  status: 'active' | 'exhausted' | 'retired' | 'lost' | 'destroyed'
  receivedAt?: string               // ISO date
  notes?: string
}
```

#### Cheque
Replaces `Check` (`models/Check.ts`) and `CheckData` (`printchecks/src/types/check.ts`).

```ts
interface Cheque {
  id: string                        // UUID — internal identity, NEVER the cheque number
  direction: 'outgoing' | 'incoming'

  // Outgoing only — populated from the ChequeBook sequence
  chequeBookId?: string
  bankAccountId?: string

  // Incoming only — recorded exactly as received; NOT part of any generator
  issuingBankName?: string
  issuingBankCode?: string
  drawerName?: string
  drawerAccountRef?: string

  chequeNumber: string              // scoped-unique, NOT globally unique
  chequeDate: string                // ISO date
  dueDate?: string                  // for post-dated / collection scheduling
  amount: Money                     // { minorUnits: bigint|number, currency: string }
  payeeId?: string                  // ChequeParty
  payeeNameSnapshot: string         // immutable at issue time
  memo?: string
  reference?: string
  signatureMode: 'wet' | 'printed' | 'stamp' | 'none'
  signatureText?: string

  status: ChequeStatus              // current, derived from history
  currency: string

  templateId?: string
  micrProfileId?: string
  amountInWords?: string            // derived, locale-aware
  micrLine?: string                 // derived by the MICR engine, never hand-edited

  createdAt: string
  updatedAt: string
  createdBy?: string
}

type ChequeStatus =
  | 'draft' | 'issued' | 'printed' | 'released'
  | 'pending_deposit' | 'deposited' | 'in_collection'
  | 'cleared' | 'returned' | 'cancelled' | 'void' | 'stopped'

interface Money { minorUnits: number; currency: string }   // integer minor units — P9
```

**Prohibited:** `amount: string | number` (currently `models/Check.ts:26`), `parseFloat` money
arithmetic (62 sites today), and direct assignment to `status` (currently `models/Check.ts:186,197`).

#### ChequeParty / Beneficiary
Replaces `Vendor`. The current app `Vendor` has only 4 fields (`types/vendor.ts`); core's has 25
(`models/Vendor.ts`). A single party model serves payees, drawers and beneficiaries, with a
`partyType` discriminator so incoming-cheque drawers and outgoing-cheque payees share one registry.

#### ChequeStatusHistory
**New.** Append-only. Replaces the mutable `status` field, which today loses prior states
(`models/Check.ts:186` overwrites `status` on print, `:197` on void).

```ts
interface ChequeStatusHistory {
  id: string
  chequeId: string
  fromStatus: ChequeStatus | null
  toStatus: ChequeStatus
  reason?: string
  actorId?: string
  occurredAt: string                // ISO timestamp
}
```

#### ChequePrintJob
**New (the existing `CheckPrintJob` type at `printchecks/src/types/check.ts:88` is dead and is
replaced, not extended).**

```ts
interface ChequePrintJob {
  id: string
  chequeId: string
  templateId: string
  printerProfileId: string
  calibrationId?: string
  status: 'queued' | 'rendering' | 'sent' | 'completed' | 'failed' | 'cancelled'
  attempt: number                   // supports controlled reprints
  isReprint: boolean
  authorisedBy?: string
  createdAt: string
  completedAt?: string
  error?: string
  layoutHash: string                // hash of the resolved layout, for reproducibility
}
```

#### BankChequeTemplate / TemplateField
See §7.

#### MICRProfile
See §9.

#### PrinterProfile / PrinterCalibration
See §8.4–8.5.

#### AuditEvent · User · Role
See §11–12.

#### Deposit / Collection / ChequeReturn
**New.** None exist today (verified: `deposit` 0 hits, `returned` 0 hits, `bounce` 0 hits).

```ts
interface Deposit       { id: string; bankAccountId: string; chequeIds: string[]; amount: Money; depositedAt: string; reference?: string }
interface Collection    { id: string; chequeId: string; status: 'submitted'|'in_collection'|'cleared'|'returned'; submittedAt: string; expectedAt?: string }
interface ChequeReturn  { id: string; chequeId: string; reasonCode: string; reasonText: string; returnedAt: string; bankReference?: string; fee?: Money }
```

### 3.3 Invariants enforced by the Domain Core

1. `Cheque.id` is a UUID and is never derived from, nor equal to, `chequeNumber`.
2. `chequeNumber` uniqueness is scoped to `(chequeBookId)` for outgoing and to
   `(issuingBankCode, drawerAccountRef, chequeNumber)` for incoming — **never global**.
3. A cancelled/voided cheque number is **never** returned to the sequence (§5.4).
4. `nextNumber` on a `ChequeBook` is monotonically non-decreasing.
5. An incoming cheque's `chequeNumber` never influences any outgoing generator.
6. `Cheque.status` is always derivable from the last `ChequeStatusHistory` entry.
7. `amount.currency` equals the `BankAccount.currency` for outgoing cheques (or an explicit,
   recorded FX conversion).
8. A cheque may only be printed if it has a resolved template, a printer profile, and a valid MICR
   line for its direction.
9. Money arithmetic never uses binary floating point.
10. No aggregate mutates another aggregate directly; changes flow through application services.

---

## 4. Layer architecture

```
┌──────────────────────────────────────────────────────────────┐
│  UI  (Vue 3 SFCs, Pinia, Vue Router)                         │
│  - thin, presentational; no business rules                   │
│  - preview rendering: mm → px via declared DPI (display only)│
└───────────────────────────┬──────────────────────────────────┘
                            │ calls
┌───────────────────────────▼──────────────────────────────────┐
│  APPLICATION  (use cases / services)                         │
│  - IssueOutgoingCheque, RecordIncomingCheque, CancelCheque,  │
│    AllocateChequeNumber, EnqueuePrintJob, CalibratePrinter,  │
│    DepositCheque, ReturnCheque                               │
│  - transactions, authorisation checks, audit emission        │
│  - framework-agnostic (no Vue imports)                       │
└───────────────────────────┬──────────────────────────────────┘
                            │ depends on
┌───────────────────────────▼──────────────────────────────────┐
│  DOMAIN CORE  (pure TypeScript — no Vue, no DOM, no I/O)     │
│  - entities, value objects (Money, ChequeNumber, MicrLine)   │
│  - invariants, state machine, domain events                  │
│  - ports (interfaces) for everything external                │
└───────────────────────────┬──────────────────────────────────┘
                            │ ports implemented by
┌───────────────────────────▼──────────────────────────────────┐
│  INFRASTRUCTURE / ADAPTERS                                   │
│  - ChequeRepository: IndexedDb | LocalStorage | HttpApi | ERP│
│  - LayoutEngine (mm geometry), MicrEngine, PrintJobRunner    │
│  - PrinterAdapter: BrowserPrint | PdfOutput | Driver | ERP   │
│  - Clock, IdGenerator, CryptoService, AuditSink              │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Ports owned by the Domain Core

```ts
interface ChequeRepository      { /* CRUD + scoped queries, async */ }
interface BankRepository        { }
interface ChequeBookRepository  { }
interface TemplateRepository    { }
interface PrinterProfileRepository { }
interface AuditSink             { record(event: AuditEvent): Promise<void> }
interface IdGenerator           { uuid(): string }
interface Clock                 { now(): string }
interface LayoutEngine          { resolve(input: LayoutInput): Promise<PrintLayout> }
interface MicrEngine            { build(input: MicrInput): MicrLine; validate(line: MicrLine): MicrValidation }
interface PrinterAdapter        { submit(job: RenderedPrintJob): Promise<PrintResult> }
```

### 4.2 Proposed package layout

```
packages/
  domain/          pure TS — entities, value objects, invariants, ports, events   (NEW)
  application/     use cases / services, transaction + audit orchestration        (NEW)
  printing/        layout engine (mm), MICR engine, print job runner              (NEW)
  templates/       BankChequeTemplate schema, registry, bank layouts              (NEW)
  adapters-storage/ IndexedDb, LocalStorage, Http, ERP adapters                   (NEW; reuses core/storage)
  adapters-print/   BrowserPrint, PdfOutput adapters                             (NEW)
  vue/             composables that bind application services to Vue              (REFACTOR existing)
  ui/              the SPA — views, components, preview renderer                  (REBUILD from printchecks/)
  legacy-core/     @printchecks/core, frozen, mined for reusable utilities        (HARVEST then DELETE)
```

### 4.3 Current-state conflicts with this layering

| Conflict | Evidence |
|---|---|
| Business logic lives inside Vue components | `CheckPrinter.vue` = 2,215 lines: form + modals + line items + analytics + style computation + print CSS + persistence + route guards |
| Domain logic depends on Vue | `stores/customization.ts` (1,393 lines) is a Pinia store holding what should be domain/reference data |
| No application layer | Views call `secureStorage.get(...)` + `JSON.parse` directly: `CheckPrinter.vue:1881-1887`, `BankAccountsView.vue` |
| No port/adapter separation in the app | `secureStorage` is a hardcoded singleton imported by stores and components |
| Domain Core depends on the DOM | `packages/core` compiles with `"lib": [... "DOM"]` (`packages/core/tsconfig.json:5`) and `LocalStorageAdapter` throws on missing `localStorage` |
| Duplicate domain models | §3.1 |

---

## 5. Cheque numbering rules — non-negotiable

### 5.1 Numbering is scoped to the cheque book

Outgoing cheques are issued from **cheque books**. Each cheque book owns an **independent**
sequence. The same cheque number may legitimately exist in two books, at two banks, simultaneously:

```
Bank A / Book 1:  4567, 4568, 4569, 4570
Bank B / Book 1:  4567, 4568, 4569, 4570     ← VALID
```

`chequeNumber` is **NOT globally unique**. Uniqueness is enforced only within
`(chequeBookId, chequeNumber)`.

### 5.2 Identity is separate from number

```
id           = "0f7c1e9a-3b2d-7c41-9a55-1de0b7c3a842"   ← UUIDv7, immutable, internal
chequeNumber = "4567"                                    ← business attribute, scoped-unique
```

No code path may use `chequeNumber` as a key, a route parameter, a storage key, or a join key.

### 5.3 Automatic generation

The next outgoing cheque number is generated automatically from the **active cheque book**
sequence — never entered manually for a new outgoing cheque, never computed globally.

```
AllocateChequeNumber(chequeBookId):
  book = load(chequeBookId)
  assert book.status == 'active'
  n = book.nextNumber
  assert n <= book.lastNumber            else → book.status = 'exhausted', error
  book.nextNumber = increment(n, book.numberPadding)
  persist(book)                          atomically with the cheque insert
  return pad(n, book.numberPadding)
```

Allocation must be **atomic with cheque creation** to prevent gaps and duplicates under
concurrency.

### 5.4 Cancelled and voided numbers are never reused

When a cheque is cancelled, voided, stopped, or destroyed (including spoiled/ruined stock), its
number is **consumed**. The sequence cursor never moves backwards. A replacement cheque receives a
**new** number from the same book.

```
Book 1: 4567 issued → 4568 issued → 4568 CANCELLED → next allocation is 4569 (never 4568 again)
```

Spoiled stock (misprint, printer jam, torn cheque) must be recordable as a consumed number with
status `void` and reason `spoiled`, so the physical book and the system stay in agreement.

### 5.5 Incoming cheques are recorded, never generated

An incoming cheque's number is captured **exactly as received from the issuing bank** and does
**not** participate in any outgoing generator. Incoming cheques:

- have no `chequeBookId`
- do not advance any `nextNumber`
- are unique-scoped by `(issuingBankCode, drawerAccountRef, chequeNumber)`, and even that is a
  soft constraint — a duplicate may be a legitimate re-presentation or a data-entry error, so it
  must raise a **warning**, not a hard failure
- are never allocated, cancelled-and-reused, or exhausted

### 5.6 Current-state conflicts

| Conflict | Evidence | Severity |
|---|---|---|
| Numbering is **global**, not per book | `CheckService.getNextCheckNumber()` (`packages/core/src/services/CheckService.ts:288-304`) — `checkNumber` itself is stored as a plain `string` (`models/Check.ts:24`); the generator coerces it with `parseInt` and takes `Math.max` over **all** cheques in the store | **Critical** |
| Two independent, disagreeing generators | `CheckService.ts:288` vs `CheckPrinter.vue:1083-1097` | High |
| No `ChequeBook` entity — nowhere to scope a sequence | §3.1 (0 hits) | **Critical** |
| `startingCheckNumber` exists only in the app type and is **ignored** by the generator | `types/bankAccount.ts:13`; `CheckPrinter.vue:1083` computes max from history instead | High |
| No uniqueness enforcement at all | no duplicate-number check in `CheckService.createCheck()` (`:41-73`) | High |
| `id` is not a UUID and is time-derived | `Date.now().toString(36) + Math.random()...substr(2)` in all four core models (`models/Check.ts:298`); `stores/history.ts:165` uses bare `Date.now().toString()` — collides on rapid inserts | High |
| No concept of a consumed-but-unused (spoiled) number | — | Medium |
| `'cancelled'` status exists in the union but is **never assigned anywhere** | `models/Check.ts:8`; verified 0 assignments | Medium |

---

## 6. Bank / ChequeBook relationship

```
Bank (1) ──< BankAccount (N) ──< ChequeBook (N) ──< Cheque (N)
                                        │
                                        └── 1 BankChequeTemplate  (the physical stock layout)
                                                 │
                                                 └── N TemplateField
                                                 └── 1 MICRProfile
```

Rules:

1. A `BankAccount` belongs to exactly one `Bank`.
2. A `ChequeBook` belongs to exactly one `BankAccount` and references exactly one
   `BankChequeTemplate` — because a book is a batch of *specific physical stock*.
3. An account may hold several books concurrently (a partially used book plus a new one). Exactly
   one may be `status: 'active'` for automatic allocation; others are `exhausted`/`retired`.
4. Switching active book is an audited action and changes the numbering sequence context.
5. A `Bank` may have multiple templates (different stock designs, different branches, personal vs
   corporate). The template is bound at **book** level, not account or bank level, because the book
   *is* the physical stock.
6. Currency is fixed at `BankAccount` level.
7. Incoming cheques reference a `Bank` (the issuing bank) but **no** `BankAccount` and **no**
   `ChequeBook` of ours.

### 6.1 Current-state conflicts

- **No `Bank` entity.** `bankName` is a free-text string duplicated on `Check`
  (`models/Check.ts:19`) and `BankAccount` (`models/BankAccount.ts:18`). Renaming a bank requires
  updating every cheque.
- **Bank and account are conflated.** In the app, `BankAccount.name` *is* the bank name
  (`BankAccountModal.vue:20`), while `accountHolderName` is the customer — one entity, two
  different real-world things.
- **No `ChequeBook`.** Therefore no place to bind a template to physical stock, and no scope for a
  number sequence.
- **Template is bound to the account, not the stock.** `types/bankAccount.ts:17` has
  `templateId?: string`, and `CheckPrinter.vue:1726` resolves
  `customizationStore.presets.find(p => p.id === selectedBank.value.templateId)` — i.e. the
  "template" is a **cosmetic preset** selected per bank account. See §7.

---

## 7. Template architecture

### 7.1 What a template is

A `BankChequeTemplate` describes the **physical pre-printed bank cheque form**: where the variable
data must be placed on a sheet of a specific size. **A template is not a complete visual cheque
design.** It contains no artwork, no logo rendering, no security background, no drawn field rules
or captions — those already exist on the paper.

### 7.2 Target schema

```ts
interface BankChequeTemplate {
  id: string
  version: number                       // templates are versioned; jobs record which was used
  bankId: string
  name: string                          // e.g. "NBE — Personal Cheque — 2024 stock"
  stockType: string                     // bank's stock identifier
  description?: string

  // Physical sheet — the source of truth, in MILLIMETRES
  paper: {
    widthMm: number
    heightMm: number
    orientation: 'portrait' | 'landscape'
    // Where the cheque body sits on the sheet (e.g. one of three on a voucher sheet)
    bodyOriginMm: { x: number; y: number }
    bodyWidthMm: number
    bodyHeightMm: number
  }

  // Reference origin for all field coordinates
  origin: 'top-left' | 'bottom-left'
  unit: 'mm'                            // literal — px is not permitted

  fields: TemplateField[]
  micrProfileId: string
  micrField: TemplateField              // the MICR band, separately specified
  printerConfigHint?: Partial<PrinterProfile>

  // What the stock already contains, so the app does NOT re-print it
  preprinted: {
    hasPayeeCaption: boolean
    hasDateCaption: boolean
    hasMemoCaption: boolean
    hasAmountBox: boolean
    hasDollarsCaption: boolean
    hasSignatureCaption: boolean
    hasRules: boolean
    hasBankArtwork: boolean
    hasSecurityBackground: boolean
  }

  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface TemplateField {
  id: string
  key: ChequeFieldKey                   // 'payee' | 'amountNumeric' | 'amountWords' | 'date'
                                        // | 'memo' | 'chequeNumber' | 'signature' | 'drawer'
                                        // | 'drawerAddress' | 'bankInfo' | 'micr' | custom
  label: string

  // Geometry — MILLIMETRES from the template origin
  x: number
  y: number
  width: number
  height: number

  typography: {
    fontFamily: string
    fontSizePt: number                  // POINTS, not px — a print unit
    fontWeight: number
    fontStyle: 'normal' | 'italic'
    letterSpacingPt?: number
    lineHeight?: number
    isMicr: boolean                     // true only for the MICR band
  }

  alignment: {
    horizontal: 'left' | 'center' | 'right'
    vertical: 'top' | 'middle' | 'bottom' | 'baseline'
  }

  overflow: 'shrink' | 'wrap' | 'clip' | 'error'
  maxChars?: number
  textTransform?: 'none' | 'uppercase'
  format?: 'date-DDMMYYYY' | 'amount-2dp' | 'amount-words-en' | 'amount-words-ar' | 'number-padded'
  zIndex: number
  isPrinted: boolean                    // false → preview-only guide, never sent to the printer
  rotationDeg?: number
}
```

### 7.3 Design rules

- **T1 — Units.** `x/y/width/height` in mm; `fontSizePt` in points. Pixels are forbidden in the
  template schema.
- **T2 — No artwork.** A template never draws a rule, a caption, a box or a background. If the
  field is on the stock, it is not in the template.
- **T3 — `preprinted` is authoritative.** The layout engine must not emit any glyph or vector that
  the template declares pre-printed.
- **T4 — Versioning.** Templates are immutable once published; a change creates a new `version`.
  Every `ChequePrintJob` records `templateId` **and** `version` so a past print can be reproduced.
- **T5 — Preview is derived.** On-screen preview converts mm → px using an explicit declared DPI
  (default 96) and renders `isPrinted: false` guides. Preview geometry is never fed back into print
  geometry.
- **T6 — Bank-specific by construction.** One template per bank stock design. A bank with three
  stock designs has three templates.
- **T7 — Printer-independent.** A template contains no printer offsets or scaling. Those live in
  `PrinterProfile` / `PrinterCalibration` (§8.4–8.5).

### 7.4 Current-state conflicts

| Conflict | Evidence | Severity |
|---|---|---|
| **No template engine exists.** `CustomizationSettings` is cosmetic styling: fonts, colours, logo, px offsets. No paper size, no geometry, no field anchors, no units | `printchecks/src/types/customization.ts:76-124` | **Critical** |
| Coordinates are **hardcoded pixel literals** in components, in four duplicated tables that must be hand-synchronised | `CheckRenderer.vue:388-401`, `:459-471`; `CheckPrinter.vue:1110`, `:1176` — one comment reads *"matched with CheckPrinter.vue for consistency"* | **Critical** |
| **The app prints the cheque form furniture** — exactly what pre-printed stock already carries. The print stylesheet suppresses only app chrome | See §7.5 | **Critical** |
| `CheckTemplate` is a saved data snapshot, not a layout | `types/check.ts:60-66` = `{ name, description, checkData: Partial<CheckData>, customizationId }` | High |
| Only 2 built-in "templates", both purely aesthetic | `stores/customization.ts:503-552`: `'business-classic'`, `'modern-minimal'` | High |
| Position "adjustments" are CSS transforms in screen px | `CheckPrinter.vue:1404`, `CheckRenderer.vue:530`: `transform: translate(${x}px, ${y}px)` | High |
| Design canvas is inconsistent between preview and print | `CheckPrinter.vue:2131-2133` = 1200×**500**px; `CheckRenderer.vue:370-371` = 1200×**490**px with logo bounds computed against **450** (`:441-448`) | High |
| Cheque artwork is rendered by the app as a PNG background | `CheckPrinter.vue:2134` `background: url('../assets/checkbg.png')`; `CheckRenderer.vue:374` `url(/src/assets/checkbg.png)` — the latter leaks a dev path into the production bundle (verified present in `dist/assets/CustomizationView-*.js` with no `dist/src/` → 404) | Medium |
| 76 font entries hardcoded inline in a Pinia store (~800 lines of reference data) | `stores/customization.ts:609+`; plus an orphaned 631-line `expanded_fonts.js` imported nowhere and eslint-ignored (`eslint.config.mjs:18`) | Medium |
| Sample MICR text uses the wrong symbol for a routing field | `CustomizationPanel.vue:969`: `'⑈123456789⑈'` (amount symbol, should be transit) | Low |

### 7.5 Critical finding — the app double-prints the bank's form

The print stylesheet injected by `CheckPrinter.vue:1456-1591` hides **only application chrome**:

```css
.container:has(.nav-tabs) { display: none !important; }
.form-container           { display: none !important; }
.nav, .nav-tabs, .nav-item, .nav-link,
.panel-header, .header, h1, p, nav { display: none !important; }
```

It does **not** hide the cheque form furniture inside `#check-box-print`, all of which is therefore
printed onto the paper:

| Pre-printed element the app re-prints | Location |
|---|---|
| `Date: _____________________` | `CheckPrinter.vue:399` |
| `Memo: ____________________________________` | `CheckPrinter.vue:513` |
| Signature rule `_______________________________` | `CheckPrinter.vue:534` |
| `Authorized Signature` caption | `CheckPrinter.vue:547` |
| Amount box — **225×40px, `border: 1px solid #c7c7c7`, `background-color: white`** | `CheckPrinter.vue:402-411` |
| Dollar sign | `CheckPrinter.vue:413-420` |
| "Dollars" caption + 840px rule | `CheckPrinter.vue:2150-2158` (`.dollar-line::after { content: 'Dollars' }`) |
| Payee rule, 776px with right border | `CheckPrinter.vue:2166-2174` (`.payto-line`) |
| Hand-drawn amount line (SVG path) | `CheckPrinter.vue:477-497` |
| "Pay to the order of" caption, bank name, bank address, account holder block | `CheckPrinter.vue` `:393`, `:443`, `:467`, `:507`, `:528` |

The `background-color: white` on `.amount-box-border` is especially damaging: it paints an
**opaque white rectangle over the bank's own pre-printed amount box**.

Note the partial, inconsistent migration already present: the artwork PNG *is* correctly suppressed
at print time (`CheckPrinter.vue:1540-1543`, `#check-box-print { background: none !important }`),
but every HTML/vector-drawn form element is left in place. This confirms the codebase was moving
toward pre-printed stock and stopped halfway.

**This is a non-negotiable product-definition violation and the highest-priority architectural
conflict in the repository.**

---

## 8. Printing architecture

### 8.1 Target pipeline

```
Cheque Data
    ↓
Bank Cheque Template          (mm geometry, field definitions, preprinted flags)
    ↓
Precision Layout Engine       (resolve fields → absolute mm placement; overflow; collision)
    ↓
MICR Engine                   (profile-driven encoding + geometry + validation)
    ↓
Printer Profile               (device identity, feed, orientation, tray, nominal offsets)
    ↓
Printer Calibration           (measured per device+template; X/Y offset, scale, skew)
    ↓
Print Job                     (queued, authorised, hash-stamped, attempt-tracked)
    ↓
Physical Pre-Printed Bank Cheque
```

### 8.2 Precision Layout Engine

A pure function of `(cheque, template, micrLine) → PrintLayout`, with **no DOM and no Vue**:

```ts
interface PlacedGlyphRun {
  fieldKey: string
  text: string
  xMm: number; yMm: number; widthMm: number; heightMm: number
  fontFamily: string; fontSizePt: number; fontWeight: number
  alignH: 'left'|'center'|'right'; alignV: 'top'|'middle'|'bottom'|'baseline'
  isMicr: boolean
  rotationDeg: number
  zIndex: number
}
interface PrintLayout {
  templateId: string; templateVersion: number
  paper: { widthMm: number; heightMm: number; orientation: 'portrait'|'landscape' }
  runs: PlacedGlyphRun[]
  suppressedFields: string[]        // declared preprinted → deliberately not emitted (T3)
  warnings: LayoutWarning[]         // overflow, collision, out-of-bounds, MICR length
  layoutHash: string
}
```

Responsibilities: resolve `format` directives (dates, amounts, amount-in-words per locale,
padded numbers); apply `overflow` policy; detect field collision and out-of-bounds; suppress
anything the template declares pre-printed; emit an ordered, deterministic run list; produce a
stable `layoutHash`.

**Preview is a separate, downstream concern.** The UI renders `PrintLayout` by converting
mm → px at a declared DPI and drawing calibration guides. Preview never influences print geometry
(P5, T5).

### 8.3 Output adapters

```ts
interface PrinterAdapter { submit(job: RenderedPrintJob): Promise<PrintResult> }
```

- **`BrowserCssPagedMediaAdapter`** — builds an isolated print document (hidden iframe or a
  dedicated print route, never the live screen DOM), sets `@page { size: <W>mm <H>mm; margin: 0 }`
  from the template, positions runs absolutely in mm/pt, then invokes print.
- **`PdfOutputAdapter`** — renders the same `PrintLayout` to PDF (pdf-lib or equivalent) for
  archival, remote printing, and driver-level output. Also gives a measurable artefact for
  calibration.
- Future: OS driver adapter, ERP print service, network printer adapter.

Both consume the identical `PrintLayout`, so the geometry is defined once.

### 8.4 PrinterProfile

Printer configuration is **separated from the cheque template** (P5).

```ts
interface PrinterProfile {
  id: string
  name: string
  make?: string; model?: string
  driverOrQueue?: string
  paperFeed: 'manual' | 'tray' | 'continuous' | 'sheet'
  trayId?: string
  orientation: 'portrait' | 'landscape'
  duplex: 'none' | 'long-edge' | 'short-edge'
  nominalDpi: { x: number; y: number }
  // Device-level nominal offsets, before calibration
  xOffsetMm: number
  yOffsetMm: number
  scale: { x: number; y: number }      // nominal 1.0
  unprintableMarginMm: { top: number; right: number; bottom: number; left: number }
  supportsCustomPageSize: boolean
  colourMode: 'mono' | 'colour'
  micrTonerCapable: boolean
  notes?: string
}
```

### 8.5 PrinterCalibration

Calibration is **independently stored and applied** — it is never baked into a template or a
profile.

```ts
interface PrinterCalibration {
  id: string
  printerProfileId: string
  templateId: string                  // calibration is per (printer, stock) pair
  measuredAt: string
  measuredBy?: string
  offsetXMm: number                   // measured deviation to be compensated
  offsetYMm: number
  scaleX: number                      // 1.0 = no correction
  scaleY: number
  skewDeg?: number
  method: 'manual-ruler' | 'test-page' | 'micr-reader'
  confidence: 'draft' | 'verified'
  notes?: string
}
```

Applied as: `final = (templateMm + profileOffset) * profileScale + calibrationOffset`, with
calibration scale multiplied last. Calibration is looked up by `(printerProfileId, templateId)`;
if absent, printing must **warn** and optionally block, never silently assume zero.

**A calibration workflow is required:** print a registration test page carrying known mm rulers
and target boxes on the real stock, measure the deviation, store it. Without this loop the system
cannot claim precision.

### 8.6 Print Job lifecycle

```
created → queued → authorised → rendering → sent → completed
                                    ↓          ↓
                                 failed    failed → (retry, attempt+1, isReprint=true)
cancelled at any pre-sent stage
```

Reprints are explicit, authorised, numbered and audited. A job records `templateId`,
`templateVersion`, `printerProfileId`, `calibrationId` and `layoutHash` so any past print is
reproducible and attributable.

### 8.7 Current-state conflicts

| Conflict | Evidence | Severity |
|---|---|---|
| **Printing is implemented as a large Vue component** — the exact anti-pattern prohibited | `CheckPrinter.vue:1443-1595` `printCheck()` | **Critical** |
| Mechanism is: append a `<style>` element to `document.head`, print the **live screen DOM**, then `style.remove()` synchronously | `CheckPrinter.vue:1456`, `:1592`, `:1593`, `:1594` | **Critical** |
| **CSS `transform: scale()` is the precision mechanism** — explicitly prohibited | `CheckPrinter.vue:2138` `transform: scale(calc(100cqw / 1200px))` | **Critical** |
| **Screen pixels are the source of truth** — 1200×500px canvas, all field coordinates hardcoded px | `CheckPrinter.vue:2131-2133`; `:404-408`, `:133-136`, `:239-241` etc. | **Critical** |
| **No mm-based coordinates anywhere.** The only mm in the print path is a fudge offset inside a viewport calc | `height: calc((100vh - 12mm) / 3)` at `CheckPrinter.vue:1520`, `:1547`, `:1573` | **Critical** |
| **Viewport units used for print geometry** — browser-dependent, not a paper measurement | same three lines | **Critical** |
| **No paper size declared** — only `@page { margin: 0 }` | `CheckPrinter.vue:1459` | **Critical** |
| Double-prints pre-printed form furniture | §7.5 | **Critical** |
| No print job entity, queue, authorisation, attempt or reprint tracking | `CheckPrintJob` declared at `types/check.ts:88`, **zero usages** | High |
| No printer profile, no calibration, no test page | 0 hits for `PrinterProfile`/`PrinterCalibration` | **Critical** |
| No PDF / driver output path | `check-preview.ts:359` comment: *"In a real implementation, you'd use a library like jsPDF"* — download is a stub emitting `download-requested` | High |
| `PrintOptions` type exists, is stored, and is **never read by any printing code** | `models/common.ts:25`, `types/common.ts:22`, `stores/app.ts:14` | Medium |
| `print-js@^1.6.0` **and** `printjs@^1.1.0` both declared, **neither imported** | `printchecks/package.json`; verified 0 import hits | Low |
| `style.remove()` assumes `window.print()` blocks | `CheckPrinter.vue:1593-1594` | Medium |
| Library print path uses physical units but is a **full voucher page**, not a stock overlay, and renders MICR in Courier | `printable-check-page.ts:273,280,310`; `:474` | Medium |

---

## 9. MICR architecture

### 9.1 Principle

MICR is an **independent engine driven by a profile** — not a font applied to a string, and not
ordinary text (P6). On-screen correctness is never accepted as evidence of bank/reader-grade
output. The implementation must support future **physical validation** against actual bank stock,
the actual printer, and actual MICR reader requirements.

### 9.2 MICRProfile

```ts
interface MICRProfile {
  id: string
  name: string
  standard: 'E-13B' | 'CMC-7'
  country?: string
  charset: 'digits' | 'digits+symbols'

  // Font binding — the profile owns the mapping, components never hardcode it
  font: {
    family: string                 // registered @font-face family
    sourceUrl?: string             // bundled asset
    unitsPerEm: number
    advanceEm: number              // expected fixed pitch, e.g. 0.5
    symbolMap: {                   // codepoint the engine EMITS → semantic symbol
      transit: string              // e.g. 'a' for micrenc.ttf
      onUs: string
      amount: string
      dash: string
    }
    supportedCodepoints: number[]  // validated against the font at build/test time
  }

  // Physical geometry — PRINT units, not px
  geometry: {
    charHeightMm: number           // E-13B: 3.18mm (1/8")
    charPitchMm: number            // E-13B: 4.76mm (0.1875", 10 cpi)
    fontSizePt: number             // derived to satisfy pitch, validated against height
    bandHeightMm: number
    baselineOffsetMm: number
    minClearanceMm: number
  }

  // Field layout on the band
  fields: {
    routing:    { present: boolean; length?: number; position?: number }
    account:    { present: boolean; maxLength: number }
    chequeNumber:{ present: boolean; maxLength: number }
    amount:     { present: boolean; maxLength: number }   // some standards print amount in MICR
    onUsExtra?: { present: boolean; maxLength: number }
  }

  maxTotalChars: number            // e.g. 43 for US personal; parameterised, not hardcoded
  requiresMicrToner: boolean
  validationLevel: 'visual' | 'reader-verified'
  readerVerifiedAt?: string
  notes?: string
}
```

### 9.3 MicrEngine

```ts
interface MicrEngine {
  build(input: { profileId: string; routing?: string; account: string;
                 chequeNumber: string; amount?: Money }): MicrLine
  validate(line: MicrLine): MicrValidation
  geometryFor(profileId: string): { fontSizePt: number; charPitchMm: number; charHeightMm: number }
}
```

`MicrLine` is a **value object**, not a string: it carries the encoded text (using the profile's
`symbolMap` codepoints), the resolved geometry, the per-field spans, and validation state. It is
produced only by the engine and is never hand-assembled in a component.

Validation must cover: character set legality; per-field length; total band length against
`maxTotalChars`; routing checksum where the standard requires it (ABA mod-10 for US); digit-only
constraints on encoded fields; font-coverage check that every emitted codepoint exists in the bound
font's `cmap`; and pitch/height ratio conformance.

### 9.4 Physical validation protocol (required, currently absent)

1. Print a MICR test band on real stock with the real printer and real toner.
2. Measure pitch and height physically (scale or microscope); compare to `geometry`.
3. Where available, verify with a MICR reader or the bank's own acceptance check.
4. Record the result on the profile: `validationLevel`, `readerVerifiedAt`, `notes`.
5. Block or warn on production printing when `validationLevel === 'visual'` and the deployment
   requires reader-grade output.

> **UNKNOWN — requires verification:** whether the bundled `micrenc.ttf` produces reader-grade
> output on any physical device. No evidence of physical validation exists in the repository.

### 9.5 Current-state findings (measured)

The bundled font `printchecks/src/assets/micrenc.ttf` (15,580 bytes) was parsed at the binary level
(`cmap` format 0 + format 4, `hmtx`, `glyf`, `head`, `maxp`):

- **23 glyphs**, `unitsPerEm = 4096`, **uniform advance 2048 = 0.5 em** → correct fixed pitch
  behaviour for MICR.
- Symbol mapping, identified from outline geometry (contour count and y-extent):

| Codepoint | gid | Geometry | Symbol |
|---|---|---|---|
| `A` / `a` | 14 / 15 | 3 contours, y 23→1894 (full height) | **transit ⑆** |
| `B` / `b` | 16 / 17 | 3 contours, y 23→1899 (full height) | **on-us ⑇** |
| `C` / `c` | 18 / 19 | 3 contours, y 348→1795 (inset) | **amount ⑈** |
| `D` / `d` | 20 / 21 | 3 contours, y 561→1364 (short, centred) | **dash ⑉** |
| `0`–`9` | 4–13 | digits | — |
| **U+2446 ⑆ / U+2447 ⑇ / U+2448 ⑈ / U+2449 ⑉** | **0** | **.notdef** | **ABSENT FROM THE FONT** |

**Conflicts:**

| Conflict | Evidence | Severity |
|---|---|---|
| **No MICR engine or profile exists.** MICR is treated as ordinary text with a font family | `.banking { font-family: 'banking'; font-size: 37px }` at `CheckPrinter.vue:2146-2148` | **Critical** |
| **No MICR line builder.** The string is assembled inline in four places with two incompatible delimiter conventions | see table below | **Critical** |
| **Three of four renderers emit codepoints the bundled font does not contain** → `.notdef`/fallback glyphs | `CheckRenderer.vue:269-270`, `check-preview.ts:328`, `printable-check-page.ts:776` all use `⑆`/`⑈` (U+2446/U+2448 → gid 0) | **Critical** |
| Only the app print path uses the font-correct convention | `CheckPrinter.vue:559-560`: `a{{routing}}a` … `{{account}}c` ✓ | — |
| **Published packages have no MICR font at all.** No `@font-face` exists anywhere in `packages/`; `printable-check-page.ts:474` requests family `'MICR'` which is never defined, falling back to `'Courier New'`; `check-preview.ts:61` requests Courier directly | verified: the only `@font-face` rules are `CheckPrinter.vue:2141` and `CheckPrinter.vue.backup:1486` | **Critical** |
| A prior remediation made this **worse**: the changelog records unifying on `⑆`/`⑈` across three components — standardising on glyphs the shipped font lacks | `QUEUE-COMPLETED.md:6`; `docs/reference/changelog.md:19` | High |
| Font registration is **mount-order dependent**: `micrenc.ttf` is referenced only by `CheckPrinter.vue` in a non-scoped `<style>`; `CheckRenderer.vue` requests family `banking` but is used on the `/customization` route | `CheckRenderer.vue:262`; `CheckTemplatePreview.vue:13` | High |
| **MICR geometry is not pinned to physical units.** `font-size: 37px` on a 1200px canvas scaled by `100cqw/1200px`. At an 8.5in content width (816 CSS px) scale ≈ 0.68 → pitch ≈ 12.6px ≈ **0.131 in** vs ANSI X9.27 E-13B **0.1875 in** (10 cpi) — ~30% too narrow. Glyph height ≈ 0.122 in vs spec 0.125 in — close. The font's intrinsic height:pitch ratio is 0.464/0.5 = **0.93** vs E-13B's 0.125/0.1875 = **0.667**, so height and pitch cannot both be compliant at any size | computed from `hmtx`/`glyf`; assumes 96 CSS px = 1 in and no browser fit-to-page scaling | **Critical** — *physical confirmation* **UNKNOWN, requires verification** |
| `validateMICRLineLength()` **ignores its own routing parameter** and hardcodes US assumptions (`overhead = 14`, routing = 9, cap = 43) | `packages/core/src/utils/validation.ts:273-283` — signature is `(_routingNumber, accountNumber, checkNumber)` | High |
| No CMV-7/CMC-7 support; no non-US profiles | — | Medium |
| Font licensing undocumented — redistribution risk given `publishConfig.access: 'public'` | no licence file for `micrenc.ttf` | **UNKNOWN — requires verification** |

**Delimiter conventions in the repository today:**

| File | Code | Correct for `micrenc.ttf`? |
|---|---|---|
| `CheckPrinter.vue:559-560` | `a{{routing}}a` … `{{account}}c` | ✅ yes |
| `CheckRenderer.vue:269-270` | `⑆{{routing}}⑆` … `{{account}}⑈` | ❌ gid 0 |
| `web-components/check-preview.ts:328` | `⑆${routing}⑆ ${account}⑈` | ❌ gid 0 |
| `web-components/printable-check-page.ts:776` | `⑆${routing}⑆ ${account}⑈` | ❌ gid 0 |
| `CustomizationPanel.vue:969` (sample) | `'⑈123456789⑈'` | ❌ gid 0 **and** wrong symbol for routing |

### 9.6 Reusable MICR asset

`micrenc.ttf` itself is worth keeping: uniform 0.5 em advance and a coherent A/B/C/D symbol
mapping are genuinely hard to source. It must be (a) licensed for redistribution, (b) bound through
`MICRProfile.font.symbolMap` rather than hardcoded in components, (c) re-verified for pitch/height
conformance — and if the 0.93 height:pitch ratio is confirmed non-conforming, a compliant E-13B
font must be sourced or the existing one re-drawn.

---

## 10. Storage architecture

### 10.1 What already works — reuse it

`packages/core/src/storage/StorageAdapter.ts` is the strongest architectural artifact in the
repository and is the correct foundation for the adapter layer:

```ts
interface StorageAdapter {
  get<T>(key): Promise<T|null>;  set<T>(key, value): Promise<void>
  remove(key): Promise<void>;    clear(): Promise<void>
  keys(): Promise<string[]>;     has(key): Promise<boolean>
  getMany<T>(keys): Promise<Map<string, T|null>>
  setMany(entries: Map<string, unknown>): Promise<void>
}
interface EncryptedStorageAdapter extends StorageAdapter {
  initialize(password): Promise<void>;  isEncryptionEnabled(): boolean
  migrateToEncrypted(password): Promise<void>;  migrateToPlainText(password): Promise<void>
  changePassword(old, new): Promise<void>
}
```
Plus `StorageOptions` (prefix, encryption, password, custom serialization) and typed
`StorageError` / `EncryptionError`. `SecureStorageAdapter` (427 lines) proves the decorator pattern
over an arbitrary base adapter, backed by 649 lines of tests; `LocalStorageAdapter` (163 lines)
handles prefixing and `QuotaExceededError`, backed by 327 lines of tests.

### 10.2 Why it is not sufficient

A generic key/value port cannot express a relational cheque domain. It has no query capability
beyond `keys()`, no transactions, no indexes, no referential integrity, no pagination.

### 10.3 Target storage architecture

Domain-owned **repository ports**, implemented by adapters:

```
ChequeRepository / BankRepository / ChequeBookRepository / TemplateRepository /
PrinterProfileRepository / CalibrationRepository / AuditRepository  (ports, in Domain Core)
        ↓ implemented by
IndexedDbRepository      — primary local-first store (structured, indexed, transactional)
LocalStorageRepository   — thin fallback / bootstrap only (5 MB ceiling)
HttpApiRepository        — remote backend
ErpRepository            — ERP integration, DTO-mapped
        ↓ optionally wrapped by
EncryptedDecorator       — reuses core's SecureStorageAdapter pattern
```

A low-level `StorageAdapter` remains useful *inside* `LocalStorageRepository` and as the encryption
decorator seam, but repositories — not raw key/value — are the domain-facing contract.

### 10.4 Storage rules

- **S1 — Per-record granularity.** One record per key/row. Whole-collection blobs are prohibited.
- **S2 — Indexed queries.** By `chequeBookId`, `bankAccountId`, `status`, `chequeDate`, `dueDate`,
  `payeeId`, `direction`, `chequeNumber`.
- **S3 — Transactional allocation.** Cheque creation and `ChequeBook.nextNumber` advance commit
  atomically (§5.3).
- **S4 — No silent failure.** Any write error propagates to the caller and surfaces in the UI (P11).
- **S5 — Import validates.** Imports instantiate models and run validation; nothing is written
  straight to storage.
- **S6 — Migration framework.** Versioned schema migrations with a recorded schema version.
- **S7 — Binary assets out of the record store.** Cheque images, logos and generated PDFs go to
  IndexedDB blobs / OPFS / object storage — never base64 data URLs in a record.
- **S8 — Offline-first with explicit sync.** Local write, queued sync, deterministic conflict
  resolution, last-writer-wins rejected for financial records.

### 10.5 Current-state conflicts

| Conflict | Evidence | Severity |
|---|---|---|
| **Whole collections stored as one JSON blob.** Every read and write is O(n); `getCheck(id)` linear-scans | `CheckService.ts:11` (`STORAGE_KEY='checks'`), `saveCheck()` at `:330-340`, `getCheck()` at `:81-85`; identical pattern in Vendor/BankAccount/Receipt services | **Critical** |
| **Silent data loss on save failure** — caught and logged, UI reports success | `stores/history.ts:216-224` | **Critical** |
| **Two disjoint key namespaces** that do not agree | core `CheckService` writes `'checks'`; app writes `'checkList'` (`history.ts:135`). core `SecureStorageAdapter.DEFAULT_SENSITIVE_KEYS` = `['checkList','checks','receipts','payments','vendors','bankAccounts','templates','customization','presets','settings']` vs app `SENSITIVE_KEYS` = `['checkList','printchecks_receipts','printchecks_payments','vendors','bankAccounts','printchecks_templates','printchecks_receipt_templates','printchecks_customization','printchecks_presets','printchecks_settings']` (`services/secureStorage.ts:9-21`) | **Critical** |
| **Consequence:** wiring the app onto core's secure adapter today would leave `printchecks_receipts` in **plaintext** | derived from the row above | **Critical** |
| **Import bypasses all validation** | `ImportExportView.vue:535-539` writes parsed JSON straight to storage keys | High |
| No IndexedDB; localStorage only, ~5 MB ceiling | `LocalStorageAdapter.getStorageStats():154`; zero IndexedDB references | High |
| No API/ERP adapter; zero `fetch`/`XHR`/`axios` in any `src/` | verified | High |
| No migration framework — only a `version: '1.0'` string in export | `PrintChecksCore.ts:349` | Medium |
| No offline sync, no service worker, no PWA manifest | verified 0 hits for `serviceWorker`/`manifest`/`workbox`/`vite-plugin-pwa` | Medium |
| Logos/backgrounds stored as **data URLs** in localStorage → quota exhaustion | `types/customization.ts` `LogoSettings.file/url`; `background.image` | Medium |
| No transactions; `getMany`/`setMany` exist but no service uses them | `StorageAdapter.ts` | Medium |
| Encryption initialisation is a documented race: constructor kicks off async init, callers must remember to `await waitForInitialization()` | `PrintChecksCore.ts:110-127`, `:138-142` | Medium |

---

## 11. Security principles

**SEC1 — Classify the data.** Cheque numbers, bank account numbers, routing numbers, IBANs, payee
names and amounts are sensitive financial data. Classification drives encryption, masking, logging
and export policy.

**SEC2 — Never persist a secret in web storage.** Today the encryption password is written to
`sessionStorage` in plaintext (`App.vue:39`:
`sessionStorage.setItem('encryption_password', passwordInput.value)`). This defeats
encryption-at-rest against any XSS or shared-machine scenario. The target holds the derived
`CryptoKey` in memory only (non-extractable, never serialised), with an explicit, documented
re-unlock flow.

**SEC3 — Encryption is not silently optional.** Today encryption is opt-in and defaults off
(`services/secureStorage.ts:33`), and `App.vue:20-24` actively sets
`encryption_enabled='false'` and reloads when `encryption_test` is missing. In the target,
sensitivity classification determines the floor; downgrade requires an explicit, audited decision.

**SEC4 — Rate-limit and lock out secret verification.** `verifyPassword()` performs a full
decryption with no rate limit, backoff or lockout (`utils/encryption.ts:160`). Target: exponential
backoff + lockout + audit on failure.

**SEC5 — Cryptographic randomness only.** `generatePassword()` falls back to `Math.random()` with
only a `console.warn` (`core/utils/encryption.ts:213`). Non-CSPRNG secret generation must be a hard
failure, not a warning.

**SEC6 — Honour the offline/local claim, or retract it.** `README.md` claims "No Network Requests:
Zero external server communication" and "100% Local", but `printchecks/index.html` loads Bootstrap
CSS and JS from `cdn.jsdelivr.net` (lines 9, 22) and Google Fonts from
`fonts.googleapis.com`/`fonts.gstatic.com` (lines 14-16) on every page load of an application whose
selling point is banking-data privacy. Third-party CDNs leak IP and referrer and create a
supply-chain dependency. Target: vendor all assets locally; add a CSP; add SRI where any external
resource is unavoidable. Bootstrap is pinned at EOL 5.0.2.

**SEC7 — No HTML injection sinks.** `v-html` remains in the print path at `CheckPrinter.vue:461`,
fed by `toWords()` whose `catch` returns `` `${e}` `` (`:1007`). `docs/reference/changelog.md:20`
claims the `v-html` XSS was removed; that is true only for `CheckRenderer.vue`. Target: no `v-html`
on any cheque data path.

**SEC8 — Mask, and do not leak through logs.** `getMaskedAccountNumber()` exists
(`models/BankAccount.ts:117`) but the app masks inline (`BankAccountsView.vue:22`,
`CheckPrinter.vue:26`) while the full number sits in storage and the DOM. Target: masked-by-default
rendering, no full account numbers in logs, exports or error messages.

**SEC9 — Validate at every trust boundary.** Import, API responses and ERP payloads are validated
before they become domain objects (contrast §10.5, `ImportExportView.vue:535-539`).

**SEC10 — Authorisation is enforced in the application layer**, not hidden in the UI. Every use
case checks permission before acting (§12.3).

**SEC11 — Retain the good parts.** AES-256-GCM + PBKDF2-SHA256 at 100,000 iterations, 16-byte
random salt, 12-byte random IV, non-extractable `CryptoKey`
(`core/utils/encryption.ts:6-10`), chunked base64 to avoid stack overflow (`:62-70`),
`isCryptoAvailable()` guard, `StorageError`/`EncryptionError` taxonomy, `escapeHtml()` on all
interpolated data in web components, and `updateCheck()` stripping `id`/`createdAt` from patches
(`CheckService.ts:184-187`). These are kept.

---

## 12. Audit requirements

### 12.1 Current state — no audit trail exists

`PaymentRecord.auditTrail` and `.printHistory` are declared at `printchecks/src/types/receipt.ts:150`
and `:157` but are **never populated by production code** — verified: the only occurrences outside
the declaration are test fixtures setting them to `[]` (`__tests__/checkFilters.test.ts:44-45`,
`__tests__/useHistoryStore.test.ts:79-80`). There is no `AuditEvent` entity (0 hits), no user
identity (the only `userId` is the unused optional at `types/receipt.ts:160`), and no permissions
model.

Additionally, `stores/history.ts:172-176` deliberately disables cheque deletion
(`deleteCheck()` logs a warning and returns) — a good immutability instinct, but with no audit
record there is no forensic trail of who printed, voided or reprinted what.

### 12.2 Target audit model

```ts
interface AuditEvent {
  id: string                        // UUID
  occurredAt: string                // ISO, from an injected Clock
  actorId?: string
  actorName?: string
  action: AuditAction
  entityType: string                // 'Cheque' | 'ChequeBook' | 'BankChequeTemplate' | ...
  entityId: string
  before?: Record<string, unknown>  // field-level diff
  after?: Record<string, unknown>
  reason?: string
  context: {
    sessionId?: string
    ipAddress?: string
    userAgent?: string
    templateVersion?: number
    printerProfileId?: string
    calibrationId?: string
    layoutHash?: string
  }
  integrityHash: string             // chained hash: H(event || previousHash)
}
```

### 12.3 Mandatory audited actions

**Cheque lifecycle:** create (outgoing), record (incoming), issue, print, reprint, release, cancel,
void, stop payment, spoil (ruined stock — consumes a number, §5.4), deposit, submit for
collection, mark cleared, mark returned, amend any field.

**Numbering:** every `AllocateChequeNumber` (book, from, to), book activation, book exhaustion,
book retirement/loss/destruction.

**Printing:** job created, authorised, sent, completed, failed, retried — each with
`templateId+version`, `printerProfileId`, `calibrationId`, `layoutHash`.

**Reference data:** bank/account/book create and amend; template publish, version bump, deactivate;
MICR profile change; printer profile change; calibration create and verify.

**Security:** encryption enabled/disabled, password changed, unlock success and **failure**,
export performed, import performed, bulk delete, permission granted/revoked, role change.

### 12.4 Audit rules

- **A1 — Append-only.** No update, no delete. Correction is a new event.
- **A2 — Tamper-evident.** Chained `integrityHash`; a broken chain is a detectable incident.
- **A3 — Emitted from the application layer**, inside the same unit of work as the action, so an
  action cannot succeed without its audit record.
- **A4 — Immutable print reproducibility.** `layoutHash` plus recorded template version, printer
  profile and calibration must allow any past print to be reconstructed exactly.
- **A5 — No sensitive values in plain audit payloads.** Account numbers masked in `before`/`after`.
- **A6 — Retention policy** is configurable and enforced; export to immutable external storage
  supported.
- **A7 — Audit reads are permissioned** separately from audit writes.

---

## 13. Migration strategy

### 13.1 Approach

**Strangler fig, bottom-up, behind ports.** Build the new layers as separate workspace packages;
harvest what is genuinely reusable from `@printchecks/core`; re-point the UI at the new application
layer use case at a time; delete legacy code only once nothing references it. The existing
1,324-test suite (measured, all passing) is the regression baseline for the harvest step.

**Explicitly rejected:** patching `CheckPrinter.vue` (2,215 lines) and `CustomizationPanel.vue`
(2,294 lines) in place. Both are replaced, not incrementally fixed.

### 13.2 Disposition inventory

#### REUSE (as-is or lightly adapted)

| Asset | Path | Notes |
|---|---|---|
| `StorageAdapter` / `EncryptedStorageAdapter` / `StorageOptions` / `StorageError` / `EncryptionError` | `packages/core/src/storage/StorageAdapter.ts` | The correct seam for the adapter layer. Keep as the low-level port inside repository adapters |
| `SecureStorageAdapter` (decorator) | `packages/core/src/storage/SecureStorageAdapter.ts` | 427 lines, 649 lines of tests. Make `sensitiveKeys` injected, not hardcoded |
| `LocalStorageAdapter` | `packages/core/src/storage/LocalStorageAdapter.ts` | Prefixing, quota detection, stats |
| Encryption primitives (AES-256-GCM, PBKDF2) | `packages/core/src/utils/encryption.ts` | Keep the **core** copy; delete the app duplicate |
| Validation helpers | `packages/core/src/utils/validation.ts` | ABA mod-10 routing checksum (`:31-45`) is correct; email/phone/url/length/range/postal reusable |
| Formatting helpers | `packages/core/src/utils/formatting.ts` | `formatCurrency` with memoized `Intl.NumberFormat` (`:9-30`), `formatDate`, `parseCurrency` |
| E-13B MICR font | `printchecks/src/assets/micrenc.ttf` | Uniform 0.5 em advance; A/B/C/D → transit/on-us/amount/dash. Bind via `MICRProfile.font.symbolMap`. **Licence UNKNOWN — requires verification** |
| Model pattern (`Data` interface + class with `validate/toJSON/fromJSON`) | `packages/core/src/models/*.ts` | Keep the pattern, replace the schemas |
| Service pattern (injected storage + `Filters` + `getStatistics`) | `packages/core/src/services/*.ts` | Keep the shape, fix persistence granularity |
| Composable wrapper pattern | `packages/vue/src/composables/*.ts` | Thin, consistent; re-point at new application services |
| Web Component packaging + `component-base.ts` | `packages/web-components/src/utils/component-base.ts` | Valuable for ERP embedding |
| Build/release tooling | `tsup.config.ts` ×3, `.changeset/`, `.github/workflows/release.yml` | Subpath `exports` map is ready for new packages |
| Core test corpus | `packages/core/src/__tests__/` (660 tests) | Regression baseline during harvest |
| Physical-unit CSS instinct | `printable-check-page.ts:273,280,310` (`8.5in`, `3.5in`, `@page margin: 0.5in`) | The only correct unit instinct in the repo — a starting point, not a solution |

#### REFACTOR

| Item | Path | Change |
|---|---|---|
| Merge the two cores | `printchecks/` ← `@printchecks/core` | Make the app depend on core; delete duplicate types/services/utils; one key namespace |
| `BankAccount` model | `models/BankAccount.ts` + `types/bankAccount.ts` | Merge to the union of both; split `Bank` out as its own entity |
| `Vendor` → `ChequeParty` | `models/Vendor.ts`, `types/vendor.ts` | Add `partyType`; reconcile the 25-field and 4-field versions |
| Money | `models/Check.ts:26` + 62 `parseFloat` sites | `Money` value object, integer minor units |
| Status | `models/Check.ts:186,197` | Replace mutable field with append-only `ChequeStatusHistory` |
| ID generation | all four core models (`Check.ts:298` etc.), `stores/history.ts:165` | UUIDv7; remove deprecated `.substr` |
| `getNextCheckNumber` | `CheckService.ts:288` and `CheckPrinter.vue:1083` | Replace both with `AllocateChequeNumber(chequeBookId)` |
| `validateMICRLineLength` | `utils/validation.ts:273-283` | Use the routing parameter; parameterise per profile/country |
| Amount-to-words | **5 implementations** — `utils/formatting.ts:130`, `CheckPrinter.vue:994`, `stores/check.ts:42`, `check-preview.ts:441`, `printable-check-page.ts:215` | One locale-parameterised core function; HTML-free output |
| `amountToWords` performance | `utils/formatting.ts:130` | Instantiates `new ToWords(...)` on every call — memoise (contrast `getCurrencyFormatter`) |
| Persistence granularity | all four services | Per-record storage, indexes, transactions |
| Error propagation | `stores/history.ts:216-224` | Surface failures; render `appStore.errors` (currently written but never displayed — verified) |
| Cross-component signalling | `App.vue:43-44`, `CheckPrinter.vue:1897`, `stores/history.ts:265` | Replace `window.dispatchEvent('password-initialized')` with store/service state |
| Routing | `printchecks/src/router/index.ts` | Nested routes, params, guards, `meta`, 404 catch-all, scroll behaviour |
| CI + scripts | `.github/workflows/verify.yml`, root `package.json` | Add root `test` script and CI test step; encode core→vue build order |
| Password handling | `App.vue:39` | In-memory non-extractable key (SEC2) |
| `useSessionTimeout` | `composables/useSessionTimeout.ts` | Sound design; remove `alert()` + `window.location.reload()` control flow (`:57-60`) |

#### DELETE

| Item | Path | Reason |
|---|---|---|
| Dead Pinia store | `printchecks/src/stores/check.ts` (365 lines) | Referenced **only** by its own test file — verified |
| Component backup | `printchecks/src/components/CheckPrinter.vue.backup` (~1,500 lines) | Dead copy of the main component |
| Orphaned font data | `printchecks/expanded_fonts.js` (631 lines) | Imported nowhere; eslint-ignored (`eslint.config.mjs:18`) |
| CI artifact | `lint_results.json` (573 KB, UTF-16LE) | Build artifact; leaks `C:\Users\joshu\Documents\Programming\PrintChecks` |
| Empty stylesheet | `printchecks/src/assets/main.css` (**0 bytes**) | Imported at `main.ts:1`, contains nothing |
| Unused assets | `printchecks/src/assets/check_bg.jpg` (58 KB), `pmc.png` (4.7 KB) | No source references — verified |
| Unused dependencies | `print-js@^1.6.0`, `printjs@^1.1.0` (both, same library under two names), root `globals` | Zero imports — verified |
| Conflicting lockfiles | `printchecks/package-lock.json`, `docs/package-lock.json`, `packages/core/package-lock.json`, `packages/web-components/package-lock.json` | Repo is pnpm (`pnpm-lock.yaml`); mixed managers |
| Legacy type shim | `printchecks/src/types/check.ts` `LegacyCheckData`, `CheckTemplate`, `CheckHistory`, dead `CheckPrintJob` | Superseded |
| Legacy utility shim | `printchecks/src/utilities.ts` | Two-line re-export |
| Cheque artwork PNG | `printchecks/src/assets/checkbg.png` (204 KB) | Out of scope once blank-paper rendering is dropped (§1.2) |
| Duplicate app services | `printchecks/src/services/encryption.ts`, `services/secureStorage.ts` | After core merge |
| Agent-local config | `.claude/settings.local.json` | Not project configuration |

#### REPLACE (rebuild — do not extend)

| Item | Path | Replacement |
|---|---|---|
| **The entire print path** | `CheckPrinter.vue:1443-1595` | `packages/printing`: LayoutEngine + PrinterAdapter, isolated print document, `@page size` in mm |
| **The template system** | `types/customization.ts`, `stores/customization.ts` (1,393 lines), `CustomizationPanel.vue` (2,294 lines) | `packages/templates`: `BankChequeTemplate` + `TemplateField` schema in mm |
| **MICR handling** | 4 inline assemblies, 2 delimiter conventions | `packages/printing/micr`: `MICRProfile` + `MicrEngine` |
| **The god component** | `CheckPrinter.vue` (2,215 lines) | Small components bound to application use cases |
| **Cheque renderer** | `CheckRenderer.vue` (604 lines, px canvas, `.notdef` MICR) | mm-based preview renderer driven by `PrintLayout` |
| **Domain models** | `models/Check.ts`, `types/check.ts` | `Cheque`, `ChequeBook`, `Bank`, `ChequeParty`, `ChequeStatusHistory` |
| **System of record** | localStorage collection blobs | IndexedDB repository adapters (+ Http/ERP later) |
| **Blank-paper voucher page** | `printable-check-page.ts` (901 lines) | Stock-overlay print document |
| **Client-only auth** | `App.vue:16-75` | Proper session model; documented threat model |
| **CDN-served UI deps** | `index.html:9,14-16,22` | Locally vendored assets + CSP |
| **Legacy architecture doc** | previous `docs/ARCHITECTURE.md` (779 lines) | This document |

#### NEW (must be implemented — nothing exists)

`Bank` · `ChequeBook` · `ChequeParty`/`Beneficiary` · `ChequeStatusHistory` · `ChequePrintJob`
(the existing declaration is dead) · `BankChequeTemplate` · `TemplateField` · `MICRProfile` ·
`PrinterProfile` · `PrinterCalibration` · `AuditEvent` · `User` · `Role` · `Deposit` ·
`Collection` · `ChequeReturn` · `Money` value object · Layout Engine · MICR Engine · Print Job
Runner · Printer Adapters (CSS paged media + PDF) · Calibration workflow and test page ·
IndexedDB / Http / ERP repository adapters · Application use-case layer · Domain ports ·
Schema migration framework · i18n + RTL foundation (incl. Arabic amount-to-words) ·
Permissions/RBAC · Reporting engine · e2e and visual-regression tests.

### 13.3 Migration sequencing

Ordered so that each step leaves the repository green and no step depends on a later one. Full
phase detail in [`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md).

1. **Stabilise** — CI runs tests; cold checkout passes; delete dead code; vendor CDN assets.
2. **Establish layer boundaries** — ✅ **DONE (Phase 0).** Created `packages/cheque-core`
   (`@printchecks/cheque-core`) with four enforced layers: `domain/`, `ports/`, `application/`,
   `infrastructure/`. No Vue, no DOM — `lib: ["ES2022"]` only, tests run with
   `environment: 'node'`. The plan originally called for two separate packages
   (`packages/domain` + `packages/application`); one package with subpath exports was built
   instead, and the boundary is enforced by
   `src/__tests__/architecture-layers.test.ts`. See roadmap decision **D15**.
3. **Unify the core** — app depends on one domain; duplicates deleted; `Money` introduced.
   `Money` itself is ✅ built (integer minor units, `BigInt` arithmetic, currency resolved
   through an injectable registry); the app does not consume it yet.
4. **Build the domain** — ✅ **DONE (Phase 0).** `Bank`, `BankAccount`, `ChequeBook`, `Cheque`,
   append-only status history, and per-book numbering are implemented with 284 tests.
   `ChequeParty` deferred (roadmap decision **D16**).
5. **Templates** — mm schema, registry, first real bank layouts.
6. **Printing engine** — layout engine, isolated print document, PDF output.
7. **MICR** — profile, engine, font binding, geometry.
8. **Printer profiles + calibration** — profiles, calibration storage, test-page workflow.
9. **UI** — rebuild views/components against application use cases.
10. **Storage/API** — IndexedDB first, then Http, then ERP.
11. **Security, audit, enterprise** — RBAC, audit chain, i18n/RTL, reporting.

### 13.4 Data migration

Existing user data (if any) lives in localStorage under the app's key namespace
(`checkList`, `vendors`, `bankAccounts`, `printchecks_receipts`, `printchecks_payments`,
`printchecks_presets`, `printchecks_customization`, `printchecks_settings`).

A versioned migrator must: read legacy keys → map `CheckData` → `Cheque` with
`direction: 'outgoing'` → synthesise a `Bank` and `BankAccount` from the denormalised
`bankName`/`routingNumber`/`bankAccountNumber` fields → synthesise a `ChequeBook` per bank account
spanning the observed min/max cheque numbers, with `nextNumber` set above the maximum → generate
UUIDs for every record and preserve the legacy id in a `legacyId` field → emit
`ChequeStatusHistory` entries reconstructing `draft`/`printed`/`void` from the legacy flags →
carry cosmetic presets across as styling only (they cannot become templates, since they contain no
geometry).

> **UNKNOWN — requires verification:** whether any real deployed instances hold user data that must
> be migrated, or whether a clean break is acceptable. This determines whether the migrator is
> Phase 3 work or can be dropped.

---

## 14. Testing strategy

### 14.1 Current state (measured)

Executed during this assessment:

| Suite | Result |
|---|---|
| `packages/core` | ✅ 16 files, **660 tests** passed |
| `packages/vue` | ✅ 6 files, **123 tests** passed *(only after `packages/core` is built — see below)* |
| `packages/web-components` | ✅ 8 files, **167 tests** passed |
| `printchecks` | ✅ 11 files, **374 tests** passed |
| **Total** | **41 files, 1,324 tests, all passing** |
| `eslint .` | ✅ 0 errors, 0 warnings |
| `pnpm type-check` (cold) | ❌ **fails** — 30+ errors in `packages/vue` |
| `pnpm type-check` (after `build:core`) | ✅ passes |
| `packages/vue` tests (cold) | ❌ **all 6 files fail** — 0 tests run |
| `printchecks` production build | ✅ 212 modules, 4.10 s |

**Build-order defect:** from a clean checkout, `packages/vue` type-check fails with
`TS2307: Cannot find module '@printchecks/core/storage'` (and `/models`, `/services`, `/utils`,
root) plus `TS7006` implicit-any knock-ons, and all six of its test files fail with
`Cannot find package '@printchecks/core/services'`. Cause: core's subpath `exports` resolve to
`./dist/*`, which does not exist until built. After `pnpm build:core`, vue type-checks clean and
123/123 pass. **This is a build-ordering defect, not a code defect** — but it is not encoded
anywhere: there is no `pretype-check`/`pretest` hook, no tsconfig project references, and no
`exports` fallback to `src`.

**CI blind spots:** `.github/workflows/verify.yml` runs install → build → type-check → lint. **It
runs no tests.** The root `package.json` has **no `test` script** (verified: `build`, `build:core`,
`build:vue`, `dev:core`, `dev:vue`, `type-check`, `lint`, `changeset`, `version`, `publish`,
`docs:*`), yet `CLAUDE.md:29` instructs "Run `pnpm test`" — which fails. CI masks the build-order
defect because it builds first.

**Coverage gaps:**
- **Zero tests on the print path.** No test exercises `printCheck()`, the injected `@media print`
  stylesheet, layout geometry, or print output.
- **Zero tests on the two largest files:** `CheckPrinter.vue` (2,215 lines) and
  `CustomizationPanel.vue` (2,294 lines) — 4,509 untested lines.
- No tests for `HomeView`, `HistoryView`, `BankAccountsView`, `VendorsView`, `ReceiptView`,
  `CustomizationView`.
- No coverage configuration or thresholds in any `vitest.config.ts`.
- No e2e tests. `printchecks/tsconfig.node.json:4-10` lists `cypress.config.*`,
  `nightwatch.conf.*` and `playwright.config.*` globs, but no such config or dependency exists.
- `printchecks/vitest.config.ts` sets `environment: 'node'` while `jsdom` and `@vue/test-utils` are
  devDependencies — component-level DOM testing is not actually configured.
- `packages/web-components/src/__tests__/mocks/core.ts` mocks core wholesale, so web-component
  tests never exercise real core behaviour.

### 14.2 Target testing strategy

**Pyramid, by layer:**

| Layer | Test type | Tooling | Bar |
|---|---|---|---|
| Domain Core | Pure unit — no DOM, no mocks | Vitest, `environment: 'node'` | **100%** of invariants; ≥95% statements |
| Application | Use-case tests with in-memory repositories | Vitest | Every use case; every authorisation path |
| Layout Engine | **Golden-file geometry** — assert exact mm coordinates | Vitest snapshot | Every template × every field × overflow case |
| MICR Engine | Encoding + validation + **font-coverage** tests | Vitest + TTF `cmap` parser | Every profile; every symbol; every length boundary |
| Adapters | Contract tests — one suite, all adapters | Vitest + fake-indexeddb / msw | Identical behaviour across IndexedDb/LocalStorage/Http |
| UI | Component tests, jsdom | Vitest + @vue/test-utils | No business logic asserted here |
| Print output | **PDF snapshot / pixel regression** | Vitest + pdf-parse / Playwright PDF | Golden PDFs per template |
| E2E | Critical journeys | Playwright | Issue → allocate → print → void → reprint |
| Physical | **Manual, recorded protocol** | Test page + ruler + MICR reader | Per (printer, stock) before go-live |

**Non-negotiable testing rules:**

- **TT1 — Domain Core tests run in bare Node.** If a domain test needs `jsdom`, the domain has
  leaked a DOM dependency (P2).
- **TT2 — Geometry is asserted numerically.** Layout tests assert `expect(run.xMm).toBeCloseTo(42.5, 3)`,
  never "renders without error".
- **TT3 — MICR font coverage is a build-time test.** Parse the bound font's `cmap` and assert every
  codepoint in `symbolMap` and every emitted character resolves to a non-zero glyph id. **This test
  would have caught the `⑆`/`⑈` → `.notdef` defect (§9.5).**
- **TT4 — Numbering invariants are property-tested.** Scoped uniqueness, monotonic cursor,
  never-reuse-after-cancel, incoming never allocates.
- **TT5 — Money is property-tested.** No float drift across rounding, summation and conversion.
- **TT6 — Print output is regression-locked.** Golden PDF per template version; a geometry change
  fails the build.
- **TT7 — CI runs the full suite**, with coverage thresholds, on every push and PR.
- **TT8 — Cold-checkout green.** `install → type-check → lint → test` must pass from clean, in any
  order, without a prior manual build.
- **TT9 — Physical validation is a recorded checklist**, not a code test, but is a release gate for
  any template/printer combination used in production.
- **TT10 — No critical file without tests.** A file exceeding ~300 lines requires coverage
  justification.

### 14.3 Immediate CI remediation

1. Add `"test": "pnpm -r run test"` to root `package.json`.
2. Add a `Test` step to `.github/workflows/verify.yml`.
3. Encode build order: add `"pretype-check": "pnpm run build:core"` and `"pretest"` hooks, **or**
   add tsconfig project references, **or** add a development `exports` condition pointing at `src`.
4. Add coverage thresholds (`@vitest/coverage-v8`) per package.
5. Add Playwright for e2e and PDF snapshot capture.
6. Set `printchecks/vitest.config.ts` `environment: 'jsdom'` for component tests.
7. Add `pnpm audit --audit-level=moderate` as a CI gate.

---

## 15. Future API / ERP integration strategy

### 15.1 Current state

**No integration capability exists.** Verified: zero `fetch`, `XMLHttpRequest` or `axios` calls in
`packages/*/src` or `printchecks/src`. No HTTP client, no DTO layer, no auth token handling, no
retry/backoff, no idempotency, no external-ID mapping, no webhooks, no sync, no conflict
resolution. Persistence is localStorage only.

### 15.2 Integration architecture

```
Application use cases
        ↓ (unchanged)
Repository ports  ──→  LocalIndexedDbRepository     (local-first)
                  ──→  HttpApiRepository            (remote backend)
                  ──→  ErpRepository                (ERP DTO mapping)
                  ──→  SyncingRepository            (local write + queued upstream sync)
```

Because the Domain Core speaks only to ports (§4.1), moving from local-only to server-backed to
ERP-integrated is an **adapter swap**, not a rewrite. This is the single largest payoff of P1/P2/P10.

### 15.3 API adapter requirements

- **DTO ↔ domain mapping** at the boundary; the wire format never becomes the domain model.
- **External ID mapping**: `id` (local UUID) ↔ `externalId` (ERP/API key), per system, so the same
  cheque can be referenced by multiple upstream systems.
- **Idempotency keys** on every mutating call — critical for cheque issue and print authorisation,
  where a retry must not allocate a second cheque number.
- **AuthN/AuthZ** via injected token provider; no secrets in storage (SEC2).
- **Retry with exponential backoff + jitter**; circuit breaker; explicit offline mode.
- **Optimistic concurrency** via `updatedAt`/ETag/version; conflict surfaced to a human for
  financial records — never silently auto-resolved (S8).
- **Pagination and filtering server-side** for cheque history and reports.
- **Typed error mapping** from HTTP status to domain errors, preserving the `StorageError`-style
  taxonomy.
- **Contract tests** — one adapter contract suite run against local, HTTP and ERP implementations
  (§14.2).

### 15.4 ERP integration surface

| Capability | Direction | Notes |
|---|---|---|
| Chart of accounts / cost centres | inbound | Reference data for memo/coding |
| Vendor / beneficiary master | inbound ↔ bidirectional | Maps to `ChequeParty` |
| Bank account master | inbound | Maps to `Bank` + `BankAccount` |
| Payment run / AP invoices | inbound | Source of outgoing cheques |
| Cheque issue confirmation | outbound | Number, amount, payee, date, status |
| Void / stop-payment notification | outbound | Must reconcile with ERP |
| Bank reconciliation / clearing status | inbound | Drives `cleared` / `returned` |
| Cheque image / PDF archive | outbound | From the PDF print adapter |
| Audit event export | outbound | For enterprise SIEM/compliance |

Integration must be **event-shaped** (domain events emitted by the Application layer) so an ERP
connector subscribes rather than the domain reaching outward.

### 15.5 Web Components as an embedding surface

`@printchecks/web-components` (8 Custom Elements, 167 passing tests) is a genuine asset for
embedding cheque functionality inside a non-Vue ERP host. It must be rebuilt on the new
application layer, and it currently **cannot render MICR at all** (§9.5) — it ships no
`@font-face` and requests an undefined `'MICR'` family (`printable-check-page.ts:474`).

### 15.6 Prerequisites before any integration work

1. Repository ports defined and implemented by at least two adapters (proves the seam).
2. Domain events emitted from the Application layer.
3. External-ID mapping and idempotency in the domain model.
4. Audit trail operational (§12) — enterprise integration without audit is not acceptable.
5. RBAC operational (§12.3, Phase 10).

---

## Appendix A — Architecture conflict register

Consolidated, severity-ordered. "Evidence" is a verified `path:line`.

### Critical — blocks the product definition

| # | Conflict | Evidence |
|---|---|---|
| C1 | **App prints the bank's pre-printed form furniture** (captions, rules, amount box with opaque white background) onto the stock | §7.5; `CheckPrinter.vue:399,402-411,413-420,513,534,547,2150-2158,2166-2174`; print CSS hides only chrome (`:1490-1518`) |
| C2 | **Blank-paper/voucher design assumption** — 3-up page sectioning and app-rendered cheque artwork | `CheckPrinter.vue:1520,1547,1573` `calc((100vh - 12mm)/3)`; `:2134` `background: url('../assets/checkbg.png')`; `README.md:24` "8.5\" x 11\" paper" |
| C3 | **Screen pixels are the source of truth for print geometry** | `CheckPrinter.vue:2131-2133` (1200×500px canvas); all field coords hardcoded px |
| C4 | **CSS `transform: scale()` is the precision mechanism** | `CheckPrinter.vue:2138` `scale(calc(100cqw / 1200px))`; `check-preview.ts:62` |
| C5 | **No physical-unit coordinates anywhere**; only mm use is a fudge inside a viewport calc | `CheckPrinter.vue:1520,1547,1573` |
| C6 | **No paper size declared** | `CheckPrinter.vue:1459` `@page { margin: 0 }` only |
| C7 | **Printing implemented as a large Vue component** mutating the live DOM | `CheckPrinter.vue:1443-1595` (`document.head.appendChild(style)` → `window.print()` → `style.remove()`) |
| C8 | **No template engine** — cosmetic styling only, no geometry | `types/customization.ts:76-124`; `stores/customization.ts:503-552` (2 aesthetic presets) |
| C9 | **No MICR engine or profile**; MICR treated as ordinary text | `CheckPrinter.vue:2146-2148` |
| C10 | **3 of 4 MICR renderers emit glyphs absent from the bundled font** (U+2446/U+2448 → gid 0) | `CheckRenderer.vue:269-270`; `check-preview.ts:328`; `printable-check-page.ts:776`; font `cmap` parsed |
| C11 | **Published packages have no MICR font at all**; request undefined `'MICR'` family, fall back to Courier | `printable-check-page.ts:474`; `check-preview.ts:61`; no `@font-face` in `packages/` |
| C12 | **MICR pitch ≈30% outside ANSI X9.27**; font height:pitch ratio 0.93 vs spec 0.667 | computed from `hmtx`/`glyf`; §9.5 — *physical confirmation* **UNKNOWN** |
| C13 | **Cheque numbering is global, not per cheque book** | `CheckService.ts:288-304` `Math.max` over all cheques |
| C14 | **No `ChequeBook` entity** — nowhere to scope a sequence or bind stock | 0 hits |
| C15 | **0 of 16 target domain entities exist** | §3.1 |
| C16 | **Two divergent, incompatible domain models**; app does not depend on core | §3.1; zero `@printchecks/core` references in `printchecks/` |
| C17 | **No printer profile, no calibration, no test page** | 0 hits |
| C18 | **Whole-collection persistence**; O(n) reads/writes, no transactions or indexes | `CheckService.ts:11,81-85,330-340` |
| C19 | **Silent data loss** on save failure | `stores/history.ts:216-224` |
| C20 | **Two disjoint storage key namespaces** → plaintext leak hazard on integration | §10.5 |
| C21 | **Float money**; `amount: string \| number` | `models/Check.ts:26`; 62 `parseFloat` sites |
| C22 | **No audit trail** (declared, never written); **no users, roles or permissions** | `types/receipt.ts:150,157`; 0 `AuditEvent`/`User`/`Role` |

### High

| # | Conflict | Evidence |
|---|---|---|
| H1 | Two disagreeing cheque-number generators | `CheckService.ts:288` vs `CheckPrinter.vue:1083-1097` |
| H2 | No cheque-number uniqueness enforcement | `CheckService.createCheck():41-73` |
| H3 | `startingCheckNumber` exists but is ignored by the generator | `types/bankAccount.ts:13` |
| H4 | IDs are time-derived, not UUIDs; `.substr` deprecated; collision-prone | `models/Check.ts:298`; `stores/history.ts:165` |
| H5 | Status is a mutable field — prior states lost | `models/Check.ts:186,197` |
| H6 | `'ready'` only in dead code; `'cancelled'` never assigned | `stores/check.ts:199`; `models/Check.ts:8` |
| H7 | 4,509 untested lines in the two largest components | `CheckPrinter.vue`, `CustomizationPanel.vue` |
| H8 | **Zero tests on the print path** | §14.1 |
| H9 | **CI runs no tests**; no root `test` script though `CLAUDE.md:29` requires it | `.github/workflows/verify.yml`; root `package.json` |
| H10 | **Cold-checkout type-check and vue tests fail** (build order not encoded) | §14.2 |
| H11 | God components mixing UI, domain, persistence and print | `CheckPrinter.vue` 2,215 lines; `CustomizationPanel.vue` 2,294 lines |
| H12 | Business logic in Vue components; views call storage directly | `CheckPrinter.vue:1881-1887` |
| H13 | 5 divergent amount-to-words implementations, one returning HTML | §13.2 REFACTOR |
| H14 | Import bypasses all validation | `ImportExportView.vue:535-539` |
| H15 | Encryption password stored plaintext in `sessionStorage` | `App.vue:39` |
| H16 | Encryption opt-in and off by default; auto-disabled on missing test key | `services/secureStorage.ts:33`; `App.vue:20-24` |
| H17 | "No network / 100% local" claim contradicted by CDN dependencies | `index.html:9,14-16,22` vs `README.md` |
| H18 | No Bank entity; bank and account conflated in one model | `BankAccountModal.vue:20`; `models/Check.ts:19` |
| H19 | Template bound to bank account as a cosmetic preset | `types/bankAccount.ts:17`; `CheckPrinter.vue:1726` |
| H20 | Hardcoded position tables duplicated 4× and hand-synchronised | `CheckRenderer.vue:388-401,459-471`; `CheckPrinter.vue:1110,1176` |
| H21 | Preview and print canvases disagree (1200×500 vs 1200×490, logo bounds vs 450) | `CheckPrinter.vue:2131-2133`; `CheckRenderer.vue:370-371,441-448` |
| H22 | No i18n/RTL foundation; `en-US` hardcoded; US-only validators | `CheckPrinter.vue:985`; `stores/check.ts:42`; `utils/validation.ts:31,190-247` |
| H23 | No API/ERP capability; zero HTTP in `src/` | §15.1 |
| H24 | `validateMICRLineLength` ignores its routing parameter; US-hardcoded | `utils/validation.ts:273-283` |
| H25 | Error state written but never rendered; `alert()`/`console` are the error UX | `stores/app.ts:52`; verified no `.vue` reads `errors` |
| H26 | No IndexedDB; ~5 MB localStorage ceiling; data-URL assets | §10.5 |
| H27 | Web-component tests mock core wholesale | `web-components/src/__tests__/mocks/core.ts` |

### Medium / Low

| # | Conflict | Evidence |
|---|---|---|
| M1 | Dead store shipped (365 lines), referenced only by its own test | `stores/check.ts` |
| M2 | Component backup committed (~1,500 lines) | `CheckPrinter.vue.backup` |
| M3 | Orphaned 631-line font file, eslint-ignored | `expanded_fonts.js`; `eslint.config.mjs:18` |
| M4 | 573 KB UTF-16LE CI artifact committed, leaking a Windows user path | `lint_results.json` |
| M5 | `main.css` is 0 bytes yet imported | `assets/main.css`; `main.ts:1` |
| M6 | Unused assets (58 KB + 4.7 KB) | `check_bg.jpg`, `pmc.png` |
| M7 | Unused + duplicated deps | `print-js`, `printjs`, root `globals` |
| M8 | Four conflicting `package-lock.json` alongside `pnpm-lock.yaml` | §13.2 DELETE |
| M9 | Two Prettier configs disagree (`trailingComma` es5 vs none) | `.prettierrc` vs `printchecks/.prettierrc.json` |
| M10 | Dev asset path leaks into production bundle → 404 | `CheckRenderer.vue:374`; verified in `dist/assets/CustomizationView-*.js` |
| M11 | `v-html` still in the print path, fed by a catch returning `` `${e}` `` | `CheckPrinter.vue:461,1007` |
| M12 | Stringly-typed global events for cross-component state | `App.vue:43-44`; `CheckPrinter.vue:1897`; `history.ts:265` |
| M13 | Async init race documented as a caller footgun | `PrintChecksCore.ts:110-127,138-142` |
| M14 | `amountToWords` constructs a new `ToWords` per call | `utils/formatting.ts:130` |
| M15 | No 404 route, guards, `meta` or scroll behaviour | `router/index.ts` |
| M16 | Docs contradict the code | `docs/ARCHITECTURE.md` app-store shape; `changelog.md:19-20` MICR/XSS claims |
| M17 | No coverage thresholds; no e2e despite tsconfig globs | `vitest.config.ts` ×4; `tsconfig.node.json:4-10` |
| M18 | App vitest `environment: 'node'` with jsdom devDeps unused | `printchecks/vitest.config.ts` |
| M19 | Unlimited password verification attempts | `utils/encryption.ts:160` |
| M20 | `Math.random()` fallback for password generation | `core/utils/encryption.ts:213` |
| M21 | `window.location.reload()` and `alert()` as control flow | `App.vue:22`; `useSessionTimeout.ts:57-60` |
| M22 | Agent-local config committed | `.claude/settings.local.json` |
| M23 | Wrong MICR symbol in template sample text | `CustomizationPanel.vue:969` |
| M24 | Vite 5 CJS build deprecation warning | observed in build output |
| M25 | Bootstrap pinned at EOL 5.0.2; Google Fonts without SRI | `index.html:9,16,22` |

---

## Appendix B — Verification record

Inspection performed at commit `7c8b81e` on branch `arena/01a0a6d6-printchecks`.

**Read in full or in relevant part:** root `package.json`, `pnpm-workspace.yaml`, `eslint.config.mjs`,
`.prettierrc`, `.gitignore`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `QUEUE-PENDING.md`,
`QUEUE-COMPLETED.md`, `lint_results.json`; all three `.github/workflows/*`; `.changeset/config.json`;
`.claude/settings.local.json`; all of `packages/core/src/**` (models, services, storage, utils,
index, `PrintChecksCore.ts`), `packages/core/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}`;
all of `packages/vue/src/composables/**` + `package.json`;
`packages/web-components/src/components/{check-preview,printable-check-page}.ts` + `package.json`;
all of `printchecks/src/**` (`App.vue`, `main.ts`, `router/index.ts`, all 8 views, all 7 components,
all 5 stores, both services, all 6 type modules, both composables, `utilities.ts`,
`utils/checkFilters.ts`), `printchecks/{package.json,vite.config.ts,vitest.config.ts,index.html,tsconfig*.json}`,
`printchecks/expanded_fonts.js`, `printchecks/scripts/*`; `docs/.vitepress/config.ts`,
`docs/package.json`, `docs/ARCHITECTURE.md`, `docs/index.md`, `docs/reference/changelog.md`,
`docs/guide/*`, `docs/api/*`; `packages/PHASE3-PLAN.md`, `packages/PHASE4-PLAN.md`.

**Commands executed** (read-only with respect to tracked source):
`git log/branch/status/remote` · `find`/`wc` inventory · `grep` sweeps for MICR, physical units,
transform-scale, domain entities, `v-html`, `@font-face`, network calls, i18n/RTL, audit, dead-code
references · `pnpm install --frozen-lockfile` · `pnpm run type-check` (cold and after build) ·
`pnpm run build:core` · per-package `vitest run` × 4 · `npx eslint .` ·
`npm run build` in `printchecks/` · production-bundle inspection for leaked dev asset paths ·
**binary TTF parsing** of `micrenc.ttf` (`cmap` format 0 and format 4 glyph lookup, `hmtx` advance
widths, `glyf` contour counts and bounding boxes, `head` unitsPerEm, `maxp` numGlyphs, `post`
version) to establish the symbol mapping and geometry in §9.5.

**Repository state after inspection:** `git status --short` is **empty** — no tracked file was
modified during the inspection. Generated `node_modules/` and `dist/` are gitignored; the `dist/`
outputs produced during verification were removed.

**Unknowns requiring verification (carried forward):**
1. `micrenc.ttf` redistribution licence.
2. Whether `micrenc.ttf` produces reader-grade output on physical hardware (pitch/height, toner).
3. Whether real deployed instances hold user data requiring migration (§13.4).
4. Target countries, banks and stock specifications (drives MICR standard, coding schemes, dimensions).
5. Whether true MICR encoding is contractually required, or optical adequacy suffices.
6. Whether the `@printchecks/*` npm scope is owned by this project.
7. Physical print behaviour under specific browser/driver scaling (Safari `@page`, Firefox `100vh` in print).
8. Whether `packages/vue`'s `main: ./dist/index.cjs` matches its actual tsup output filenames.
