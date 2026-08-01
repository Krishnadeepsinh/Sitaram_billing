import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, a[href], [tabindex]:not([tabindex="-1"])';

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
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const focusable = () =>
    [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
      (item) => !item.hidden && item.getClientRects().length > 0,
    );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    focusable()[0]?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
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
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
