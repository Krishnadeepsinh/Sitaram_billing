import { useId, useRef, useState } from "react";
import {
  formatRupees,
  paymentAmountAfterDiscount,
  paymentEntryBreakdown,
} from "../lib/money";

type PaymentAmountFieldsProps = {
  duePaise: number;
  holdAsCredit?: boolean;
};

export function PaymentAmountFields({
  duePaise,
  holdAsCredit = false,
}: PaymentAmountFieldsProps) {
  const [amount, setAmount] = useState(
    duePaise > 0 ? (duePaise / 100).toFixed(2) : "",
  );
  const [discount, setDiscount] = useState("0");
  const amountInput = useRef<HTMLInputElement>(null);
  const discountInput = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const errorId = useId();
  const breakdown = paymentEntryBreakdown(duePaise, amount, discount);
  const discountError = breakdown.discountExcessPaise
    ? `Discount cannot exceed ${formatRupees(breakdown.maxDiscountPaise)} after this payment.`
    : "";

  function updateValidity(nextAmount: string, nextDiscount: string) {
    const next = paymentEntryBreakdown(duePaise, nextAmount, nextDiscount);
    const message = next.discountExcessPaise
      ? `Discount cannot exceed ${formatRupees(next.maxDiscountPaise)} after this payment.`
      : "";
    discountInput.current?.setCustomValidity(message);
  }

  function settleFullBalance() {
    const nextAmount = paymentAmountAfterDiscount(duePaise, discount);
    setAmount(nextAmount);
    updateValidity(nextAmount, discount);
    amountInput.current?.focus();
  }

  return (
    <section className="payment-settlement full-field" aria-label="Payment amounts">
      <div className="payment-settlement-heading">
        <div>
          <strong>Payment and discount</strong>
          <span>Enter what was actually received. These values stay independent.</span>
        </div>
        {!holdAsCredit && duePaise > 0 ? (
          <button
            type="button"
            className="secondary payment-settle-button"
            disabled={breakdown.discountGivenPaise > duePaise}
            onClick={settleFullBalance}
          >
            Settle Full Balance
          </button>
        ) : null}
      </div>

      <div className="payment-settlement-fields">
        <label>
          Actual Cash/UPI Received (₹) *
          <input
            ref={amountInput}
            name="amount"
            autoComplete="off"
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            value={amount}
            aria-describedby={helpId}
            onChange={(event) => {
              const nextAmount = event.currentTarget.value;
              setAmount(nextAmount);
              updateValidity(nextAmount, discount);
            }}
            required
          />
        </label>
        <label>
          Discount Approved (₹)
          <input
            ref={discountInput}
            name="discount"
            autoComplete="off"
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            value={discount}
            disabled={holdAsCredit}
            aria-invalid={Boolean(discountError)}
            aria-describedby={`${helpId}${discountError ? ` ${errorId}` : ""}`}
            onChange={(event) => {
              const nextDiscount = event.currentTarget.value;
              setDiscount(nextDiscount);
              updateValidity(amount, nextDiscount);
            }}
            required
          />
        </label>
      </div>

      <p id={helpId} className="form-help payment-settlement-help">
        {holdAsCredit
          ? "Discount is unavailable until the opening due is attached to an invoice. This payment will be held as advance credit."
          : "A discount settles invoice dues only and never creates advance credit. Use “Settle Full Balance” only when the customer is clearing the account."}
      </p>
      {discountError ? (
        <p id={errorId} className="field-error" role="alert">
          {discountError}
        </p>
      ) : null}

      <dl className="payment-settlement-summary" aria-live="polite">
        <div>
          <dt>Payment received</dt>
          <dd>{formatRupees(breakdown.amountReceivedPaise)}</dd>
        </div>
        <div>
          <dt>Discount entered</dt>
          <dd>{formatRupees(breakdown.discountGivenPaise)}</dd>
        </div>
        <div>
          <dt>{holdAsCredit ? "Advance credit to add" : "Total applied to due"}</dt>
          <dd>
            {formatRupees(
              holdAsCredit
                ? breakdown.amountReceivedPaise
                : breakdown.coveredPaise,
            )}
          </dd>
        </div>
        <div>
          <dt>Account after entry</dt>
          <dd
            className={
              discountError
                ? "amount-due"
                : holdAsCredit || breakdown.advanceCreditPaise
                ? "amount-credit"
                : breakdown.remainingDuePaise
                  ? "amount-due"
                  : ""
            }
          >
            {discountError
              ? "Fix discount to continue"
              : holdAsCredit
              ? `${formatRupees(duePaise)} opening due remains`
              : breakdown.advanceCreditPaise
                ? `${formatRupees(breakdown.advanceCreditPaise)} advance`
                : breakdown.remainingDuePaise
                  ? `${formatRupees(breakdown.remainingDuePaise)} due`
                  : "Settled"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
