/**
 * @printchecks/cheque-printing — the template and printing engine (Phase 2).
 *
 * For real, pre-printed bank cheque stock. The app's job is to put *variable data* in the right
 * place on somebody else's form; everything in this package serves that, and nothing in it renders
 * a cheque "design":
 *
 *     geometry/      millimetres as the source of truth; mm ⇄ pt ⇄ px conversion in one place
 *     canonical/     canonical JSON + content hashing (template and layout identity)
 *     template/      bank cheque templates: physical geometry, fields, mapping, validation,
 *                    immutable versioning, built-in bank stock definitions
 *     printdata/     the print payload + RTL/LTR/mixed-direction resolution + format directives
 *     layout/        deterministic, pure layout engine and preview geometry (derived, never fed back)
 *     printer/       printer profiles, independent calibration, the transform, registration test page
 *     printing/      print-job lifecycle, data-only document rendering, safety gate, audit chain
 *     ports/         what the host must supply: record store, print transport, amount-in-words
 *     application/   ChequePrintingService — the facade that wires the above into use cases
 *     infrastructure/ reference adapters (in-memory store, record repositories)
 *     browser/       the isolated-iframe print transport — the only DOM-touching module
 *
 * Explicitly NOT here (docs/ARCHITECTURE.md §9, §16.5): MICR encoding, driver-level spooling,
 * overlay/artwork printing, and any cheque-domain model — Bank/BankAccount/ChequeBook/Cheque/Money
 * stay in `@printchecks/cheque-core`, which this package does not import.
 *
 * The framework-agnostic core never touches the DOM, `window`, `localStorage` or a stylesheet; the
 * package's own layer test enforces that, and `window.print()` on a live document is a build failure.
 */

export * from './geometry/index'
export * from './canonical/index'
export * from './template/index'
export * from './printdata/index'
export * from './layout/index'
export * from './printer/index'
export * from './printing/index'
export * from './ports/index'
export * from './application/index'
export * from './infrastructure/index'
export * from './errors'
