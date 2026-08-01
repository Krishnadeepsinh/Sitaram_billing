import { describe, expect, it } from 'vitest'
import { paymentAmountAfterDiscount, paymentEntryBreakdown } from './money'

describe('payment discount entry', () => {
  it('calculates the amount only when full settlement is explicitly requested', () => {
    expect(paymentAmountAfterDiscount(40000, '50')).toBe('350.00')
    expect(paymentAmountAfterDiscount(40000, '500')).toBe('0.00')
  })

  it('keeps a manually entered partial payment independent from its discount', () => {
    expect(paymentEntryBreakdown(35000, '100', '10')).toEqual({
      amountReceivedPaise: 10000,
      discountGivenPaise: 1000,
      maxDiscountPaise: 25000,
      discountExcessPaise: 0,
      coveredPaise: 11000,
      remainingDuePaise: 24000,
      advanceCreditPaise: 0,
    })
  })

  it('separates advance credit and rejects excess discount in the preview', () => {
    expect(paymentEntryBreakdown(35000, '400', '0').advanceCreditPaise).toBe(5000)
    expect(paymentEntryBreakdown(35000, '300', '100')).toMatchObject({
      maxDiscountPaise: 5000,
      discountExcessPaise: 5000,
      remainingDuePaise: 0,
      advanceCreditPaise: 0,
    })
  })
})
