import { useId, useRef, useState } from "react";
import { formatRupees, paymentAmountAfterDiscount, paymentEntryBreakdown } from "../lib/money";

type PaymentAmountFieldsProps = { duePaise: number; holdAsCredit?: boolean };

export function PaymentAmountFields({ duePaise, holdAsCredit = false }: PaymentAmountFieldsProps) {
  const [amount, setAmount] = useState(duePaise > 0 ? (duePaise / 100).toFixed(2) : "");
  const [discount, setDiscount] = useState("0");
  const amountInput = useRef<HTMLInputElement>(null);
  const discountInput = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const errorId = useId();
  const breakdown = paymentEntryBreakdown(duePaise, amount, discount);
  const discountError = breakdown.discountExcessPaise ? `Discount cannot exceed ${formatRupees(breakdown.maxDiscountPaise)} after this payment.` : "";

  function updateValidity(nextAmount: string, nextDiscount: string) {
    const next = paymentEntryBreakdown(duePaise, nextAmount, nextDiscount);
    discountInput.current?.setCustomValidity(next.discountExcessPaise ? `Discount cannot exceed ${formatRupees(next.maxDiscountPaise)} after this payment.` : "");
  }

  function settleFullBalance() {
    const nextAmount = paymentAmountAfterDiscount(duePaise, discount);
    setAmount(nextAmount);
    updateValidity(nextAmount, discount);
    amountInput.current?.focus();
  }

  return <section className="payment-settlement full-field" aria-label="Payment amounts">
    <div className="payment-settlement-heading">
      <div><strong>Amount Received</strong><span>Enter the cash or UPI amount actually received.</span></div>
      {!holdAsCredit && duePaise > 0 ? <button type="button" className="secondary payment-settle-button" disabled={breakdown.discountGivenPaise > duePaise} onClick={settleFullBalance}>Pay Full Balance</button> : null}
    </div>

    <div className="payment-settlement-fields payment-primary-amount"><label>Amount Received (₹) *<input ref={amountInput} name="amount" autoComplete="off" inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={amount} aria-describedby={helpId} onChange={(event) => { const nextAmount = event.currentTarget.value; setAmount(nextAmount); updateValidity(nextAmount, discount); }} required /></label></div>

    <details className="advanced-options payment-advanced" open={holdAsCredit || undefined}>
      <summary>Discount & Balance Details</summary>
      <label>Discount Approved (₹)<input ref={discountInput} name="discount" autoComplete="off" inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={discount} disabled={holdAsCredit} aria-invalid={Boolean(discountError)} aria-describedby={`${helpId}${discountError ? ` ${errorId}` : ""}`} onChange={(event) => { const nextDiscount = event.currentTarget.value; setDiscount(nextDiscount); updateValidity(amount, nextDiscount); }} required /></label>
      <p id={helpId} className="form-help payment-settlement-help">{holdAsCredit ? "This payment will be saved as customer credit. Create the first bill before applying a discount." : "A discount reduces an invoiced balance only; it never creates customer credit."}</p>
      {discountError ? <p id={errorId} className="field-error" role="alert">{discountError}</p> : null}
      <dl className="payment-settlement-summary" aria-live="polite">
        <div><dt>Payment Received</dt><dd>{formatRupees(breakdown.amountReceivedPaise)}</dd></div>
        <div><dt>Discount</dt><dd>{formatRupees(breakdown.discountGivenPaise)}</dd></div>
        <div><dt>{holdAsCredit ? "Credit to Add" : "Applied to Balance"}</dt><dd>{formatRupees(holdAsCredit ? breakdown.amountReceivedPaise : breakdown.coveredPaise)}</dd></div>
        <div><dt>Balance After Entry</dt><dd className={discountError ? "amount-due" : holdAsCredit || breakdown.advanceCreditPaise ? "amount-credit" : breakdown.remainingDuePaise ? "amount-due" : ""}>{discountError ? "Fix discount" : holdAsCredit ? `${formatRupees(duePaise)} opening due remains` : breakdown.advanceCreditPaise ? `${formatRupees(breakdown.advanceCreditPaise)} credit` : breakdown.remainingDuePaise ? `${formatRupees(breakdown.remainingDuePaise)} due` : "Paid in full"}</dd></div>
      </dl>
    </details>
  </section>;
}
