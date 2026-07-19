import { describe, expect, it } from 'vitest'
import { paymentAmountAfterDiscount } from './money'

describe('payment discount entry', () => {
  it('reduces cash received without creating a negative amount', () => {
    expect(paymentAmountAfterDiscount(40000, '50')).toBe('350.00')
    expect(paymentAmountAfterDiscount(40000, '500')).toBe('0.00')
  })
})
