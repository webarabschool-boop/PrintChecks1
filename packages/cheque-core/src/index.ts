/**
 * @printchecks/cheque-core
 *
 * Framework-agnostic core for cheque management.
 *
 * Layering (each layer may import only from the layers below it):
 *
 *     application/    use cases + composition root
 *     domain/         entities, value objects, sequence engine, lifecycle, errors
 *     ports/          repository / clock / id-generator INTERFACES
 *     infrastructure/ concrete adapters (crypto ids, record stores, persistence)
 *
 * The domain layer is built with `lib: ["ES2022"]` and NO DOM, so it is structurally
 * impossible for a business rule to reach for `window`, `document` or `localStorage`.
 * Printing, templates and UI live outside this package.
 */

export * from './domain/index'
export * from './ports/index'
export * from './application/index'
export * from './infrastructure/index'
