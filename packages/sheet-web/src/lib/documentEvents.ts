import { useEffect, type RefObject } from "react";

type DocumentEventType = "keydown" | "pointerdown";

const registerDocumentEventListeners = (
  listeners: ReadonlyArray<readonly [DocumentEventType, EventListener]>,
): (() => void) => {
  listeners.forEach(([type, listener]) => document.addEventListener(type, listener));

  return () =>
    listeners.forEach(([type, listener]) => document.removeEventListener(type, listener));
};

export const useDismissOnOutsideOrEscape = <Menu extends HTMLElement, Trigger extends HTMLElement>(
  isOpen: boolean,
  menuRef: RefObject<Menu | null>,
  triggerRef: RefObject<Trigger | null>,
  onClose: () => void,
) => {
  useEffect(() => {
    if (!isOpen) return;

    const closeOnPointerDown = (event: Event) => {
      const menu = menuRef.current;
      const target = event.target;
      if (menu !== null && target instanceof Node && menu.contains(target)) return;
      onClose();
    };
    const closeOnKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
      onClose();
      triggerRef.current?.focus();
    };

    return registerDocumentEventListeners([
      ["pointerdown", closeOnPointerDown],
      ["keydown", closeOnKeyDown],
    ]);
  }, [isOpen, menuRef, onClose, triggerRef]);
};
