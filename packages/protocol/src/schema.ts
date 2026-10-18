/**
 * A tiny runtime-validation toolkit. Every schema is a function that returns the validated value
 * (unknown object keys are stripped) or throws a {@link ValidationError} naming the failing path.
 * Static types are inferred from the schemas, so a type and its validator can never drift apart.
 */

export class ValidationError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.name = 'ValidationError'
    this.path = path
    this.reason = reason
  }
}

export type Schema<T> = (value: unknown, path: string) => T

type Out<S> = S extends Schema<infer T> ? T : never
type Shape = Record<string, Schema<unknown>>
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Out<S[K]> ? K : never
}[keyof S]
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type ObjectOut<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Out<S[K]> } & { [K in OptionalKeys<S>]?: Out<S[K]> }
>

const fail = (path: string, reason: string): never => {
  throw new ValidationError(path, reason)
}

export const str =
  (max: number, min = 0): Schema<string> =>
  (value, path) => {
    if (typeof value !== 'string') return fail(path, 'expected a string')
    if (value.length < min) return fail(path, `must be at least ${min} character(s)`)
    if (value.length > max) return fail(path, `must be at most ${max} characters`)
    return value
  }

export const int =
  (min: number, max: number): Schema<number> =>
  (value, path) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return fail(path, 'expected an integer')
    }
    if (value < min || value > max) return fail(path, `must be between ${min} and ${max}`)
    return value
  }

export const bool: Schema<boolean> = (value, path) =>
  typeof value === 'boolean' ? value : fail(path, 'expected a boolean')

export const lit =
  <T extends string | number | boolean>(expected: T): Schema<T> =>
  (value, path) =>
    value === expected ? expected : fail(path, `expected ${JSON.stringify(expected)}`)

export const oneOf =
  <T extends string>(...allowed: readonly T[]): Schema<T> =>
  (value, path) => {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T
    }
    return fail(path, `expected one of ${allowed.join(', ')}`)
  }

export const opt =
  <T>(inner: Schema<T>): Schema<T | undefined> =>
  (value, path) =>
    value === undefined || value === null ? undefined : inner(value, path)

export const arr =
  <T>(item: Schema<T>, max: number): Schema<T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) return fail(path, 'expected an array')
    if (value.length > max) return fail(path, `must have at most ${max} items`)
    return value.map((entry, index) => item(entry, `${path}[${index}]`))
  }

export const obj =
  <S extends Shape>(shape: S): Schema<ObjectOut<S>> =>
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'expected an object')
    }
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) {
      const checked = shape[key]!(record[key], `${path}.${key}`)
      if (checked !== undefined) out[key] = checked
    }
    return out as ObjectOut<S>
  }

/** Discriminated union: picks the variant schema by the string stored under `key`. */
export const union =
  <V extends Record<string, Schema<unknown>>>(
    key: string,
    variants: V
  ): Schema<Out<V[keyof V]>> =>
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'expected an object')
    }
    const tag = (value as Record<string, unknown>)[key]
    if (typeof tag !== 'string' || !Object.hasOwn(variants, tag)) {
      return fail(`${path}.${key}`, 'unknown or missing discriminator')
    }
    return variants[tag]!(value, path) as Out<V[keyof V]>
  }

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Parses a raw WebSocket/HTTP payload (string or bytes) and validates it against `schema`. */
export const parseJson = <T>(
  schema: Schema<T>,
  raw: string | Uint8Array | ArrayBuffer
): ParseResult<T> => {
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else {
    text = new TextDecoder().decode(raw)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  try {
    return { ok: true, value: schema(data, '$') }
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.message }
    throw error
  }
}
