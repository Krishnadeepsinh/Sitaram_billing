import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, a[href], [tabindex]:not([tabindex="-1"])';
const nativePopupInputTypes = new Set(["date", "month", "time", "datetime-local"]);

export function Modal({
  title,
  onClose,
  wide,
  compact,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  compact?: boolean;
  children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const focusable = () =>
    [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
      (item) => !item.hidden && item.getClientRects().length > 0,
    );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const coveredDialogs = [...document.querySelectorAll<HTMLElement>(".modal-backdrop")]
      .filter((item) => item !== backdrop.current)
      .map((item) => ({
        item,
        inert: item.inert,
        ariaHidden: item.getAttribute("aria-hidden"),
      }));
    coveredDialogs.forEach(({ item }) => {
      item.inert = true;
      item.setAttribute("aria-hidden", "true");
    });
    focusable()[0]?.focus();
    return () => {
      coveredDialogs.forEach(({ item, inert, ariaHidden }) => {
        item.inert = inert;
        if (ariaHidden === null) item.removeAttribute("aria-hidden");
        else item.setAttribute("aria-hidden", ariaHidden);
      });
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      const target = event.target;
      if (
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement && nativePopupInputTypes.has(target.type))
      ) return;
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      ref={backdrop}
      className="modal-backdrop"
      role="presentation"
    >
      <section
        ref={dialog}
        className={`${wide ? "modal modal-wide" : "modal"}${compact ? " modal-compact" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKey}
      >
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
