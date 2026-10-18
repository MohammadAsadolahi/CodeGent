import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  arr,
  bool,
  int,
  lit,
  obj,
  oneOf,
  opt,
  parseJson,
  str,
  union,
  ValidationError
} from '../src/schema'

describe('primitive schemas', () => {
  it('str enforces type and length bounds and reports the path', () => {
    const s = str(5, 2)
    expect(s('abc', '$.x')).toBe('abc')
    expect(() => s('a', '$.x')).toThrow(/\$\.x: must be at least 2/)
    expect(() => s('abcdef', '$.x')).toThrow(/at most 5/)
    expect(() => s(12, '$.x')).toThrow(/expected a string/)
  })

  it('int rejects floats, NaN, Infinity, strings and out-of-range values', () => {
    const i = int(0, 10)
    expect(i(7, '$')).toBe(7)
    for (const bad of [1.5, NaN, Infinity, '3', -1, 11, null, undefined]) {
      expect(() => i(bad, '$')).toThrow(ValidationError)
    }
  })

  it('bool, lit and oneOf are strict', () => {
    expect(bool(true, '$')).toBe(true)
    expect(() => bool('true', '$')).toThrow()
    expect(lit('a')('a', '$')).toBe('a')
    expect(() => lit('a')('b', '$')).toThrow(/expected "a"/)
    expect(oneOf('x', 'y')('y', '$')).toBe('y')
    expect(() => oneOf('x', 'y')('z', '$')).toThrow(/expected one of x, y/)
  })

  it('opt maps undefined and null to undefined and validates anything else', () => {
    const o = opt(int(0, 5))
    expect(o(undefined, '$')).toBeUndefined()
    expect(o(null, '$')).toBeUndefined()
    expect(o(3, '$')).toBe(3)
    expect(() => o(9, '$')).toThrow()
  })

  it('arr enforces item schema and maximum length', () => {
    const a = arr(int(0, 9), 2)
    expect(a([1, 2], '$')).toEqual([1, 2])
    expect(() => a([1, 2, 3], '$')).toThrow(/at most 2 items/)
    expect(() => a([1, 'x'], '$')).toThrow(/\$\[1\]/)
    expect(() => a('nope', '$')).toThrow(/expected an array/)
  })
})

describe('obj', () => {
  const schema = obj({ a: str(10), b: opt(int(0, 5)), nested: obj({ c: bool }) })

  it('returns only known keys (unknown keys are stripped)', () => {
    const value = schema({ a: 'x', nested: { c: true, evil: 1 }, extra: 'y' }, '$')
    expect(value).toEqual({ a: 'x', nested: { c: true } })
    expect(Object.keys(value)).toEqual(['a', 'nested'])
  })

  it('reports nested paths', () => {
    expect(() => schema({ a: 'x', nested: { c: 1 } }, '$')).toThrow(/\$\.nested\.c/)
  })

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 1, 'x', [], true]) {
      expect(() => schema(bad, '$')).toThrow(/expected an object/)
    }
  })

  it('is not fooled by prototype pollution keys', () => {
    const value = schema(
      JSON.parse('{"a":"x","nested":{"c":true},"__proto__":{"a":"hacked"}}'),
      '$'
    )
    expect(value.a).toBe('x')
    expect(({} as Record<string, unknown>).a).toBeUndefined()
  })

  it('infers static types (optional keys are optional)', () => {
    type Value = ReturnType<typeof schema>
    expectTypeOf<Value>().toEqualTypeOf<{
      a: string
      b?: number
      nested: { c: boolean }
    }>()
  })
})

describe('union', () => {
  const schema = union('kind', {
    one: obj({ kind: lit('one'), n: int(0, 9) }),
    two: obj({ kind: lit('two'), s: str(3) })
  })

  it('selects the variant by discriminator', () => {
    expect(schema({ kind: 'one', n: 4 }, '$')).toEqual({ kind: 'one', n: 4 })
    expect(schema({ kind: 'two', s: 'ab' }, '$')).toEqual({ kind: 'two', s: 'ab' })
  })

  it('rejects unknown, missing or inherited discriminators', () => {
    expect(() => schema({ kind: 'three' }, '$')).toThrow(/discriminator/)
    expect(() => schema({}, '$')).toThrow(/discriminator/)
    expect(() => schema({ kind: 'toString' }, '$')).toThrow(/discriminator/)
    expect(() => schema({ kind: 'constructor' }, '$')).toThrow(/discriminator/)
  })

  it('validates the selected variant', () => {
    expect(() => schema({ kind: 'one', n: 99 }, '$')).toThrow(/\$\.n/)
  })

  it('infers a discriminated union type', () => {
    type Value = ReturnType<typeof schema>
    expectTypeOf<Value>().toEqualTypeOf<
      { kind: 'one'; n: number } | { kind: 'two'; s: string }
    >()
  })
})

describe('parseJson', () => {
  const schema = obj({ n: int(0, 9) })

  it('parses strings and bytes', () => {
    expect(parseJson(schema, '{"n":3}')).toEqual({ ok: true, value: { n: 3 } })
    expect(parseJson(schema, new TextEncoder().encode('{"n":4}'))).toEqual({
      ok: true,
      value: { n: 4 }
    })
  })

  it('returns errors instead of throwing', () => {
    expect(parseJson(schema, '{nope')).toEqual({ ok: false, error: 'invalid JSON' })
    const bad = parseJson(schema, '{"n":"x"}')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/\$\.n/)
  })
})
