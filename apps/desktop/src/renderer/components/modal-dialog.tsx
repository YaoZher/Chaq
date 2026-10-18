import { useLayoutEffect, useRef, type ReactNode } from "react";
import "./modal-dialog.css";

type ModalDialogProps = {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
  className?: string;
  dismissible?: boolean;
  active?: boolean;
};

/** Native modality keeps retained pages and lower dialogs out of keyboard navigation. */
export function ModalDialog({ children, labelledBy, onClose, className = "", dismissible = true, active = true }: ModalDialogProps) {
  const element = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef<number | null>(null);

  useLayoutEffect(() => {
    const dialog = element.current;
    if (!dialog || !active) return;
    let disposed = false;
    let opener: HTMLElement | null = null;
    let closedAncestors = 0;
    for (let ancestor = dialog.parentElement?.closest("dialog"); ancestor; ancestor = ancestor.parentElement?.closest("dialog")) {
      if (!ancestor.open) closedAncestors += 1;
    }
    function openAfterAncestors(remaining: number) {
      if (disposed || !dialog?.isConnected) return;
      // Layout effects run inside-out. On page reactivation, open the parent first
      // so its retained child remains the topmost modal and receives focus last.
      if (remaining > 0) {
        queueMicrotask(() => openAfterAncestors(remaining - 1));
        return;
      }
      if (dialog.parentElement?.closest("dialog:not([open])")) return;
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    openAfterAncestors(closedAncestors);
    return () => {
      disposed = true;
      backdropPointer.current = null;
      if (dialog.open) dialog.close();
      // The browser restores focus itself. Defer a fallback until nested dialogs also
      // finish closing, without replacing focus already moved to another page or dialog.
      queueMicrotask(() => {
        if (document.activeElement !== document.body || !opener?.isConnected || opener === document.body) return;
        if (opener.closest('[inert], [hidden], dialog:not([open])') || !opener.getClientRects().length) return;
        opener.focus({ preventScroll: true });
      });
    };
  }, [active]);

  return (
    <dialog ref={element} className={`chaq-modal ${className}`.trim()} aria-labelledby={labelledBy}
      aria-modal="true" aria-hidden={active ? undefined : true} tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        backdropPointer.current = null;
        if (dismissible) onClose();
      }}
      onPointerDown={(event) => {
        backdropPointer.current = event.target === event.currentTarget && event.button === 0 ? event.pointerId : null;
      }}
      onPointerUp={(event) => {
        const startedOnBackdrop = backdropPointer.current === event.pointerId;
        backdropPointer.current = null;
        // Touch and pen can implicitly capture a pointer on the backdrop. Its event
        // target then stays the dialog even after the pointer moves over the form.
        const releasedOnBackdrop = event.target === event.currentTarget
          && document.elementFromPoint(event.clientX, event.clientY) === event.currentTarget;
        if (startedOnBackdrop && releasedOnBackdrop && event.button === 0 && dismissible) onClose();
      }}
      onPointerCancel={() => { backdropPointer.current = null; }}>
      {children}
    </dialog>
  );
}
