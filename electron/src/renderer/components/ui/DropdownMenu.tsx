import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { buildDropdownClassName, isOutsidePopoverRoot } from './popover-listbox-logic';
import { usePopoverListbox, type PopoverAlign } from './usePopoverListbox';

export type DropdownMenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
export type DropdownMenuAlign = 'start' | 'end';

export interface DropdownMenuProps {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  /** Accessible label for the menu. */
  readonly label: string;
  readonly placement?: DropdownMenuPlacement;
  readonly align?: DropdownMenuAlign;
  readonly className?: string;
  readonly menuClassName?: string;
  readonly disabled?: boolean;
  /** Controlled open state; defaults to uncontrolled. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * General-purpose dropdown menu primitive built on the shared popover listbox
 * infrastructure. Renders arbitrary children inside a toggleable menu panel
 * anchored to a trigger button.
 *
 * For value-picking use cases prefer `PopoverList`; `DropdownMenu` is intended
 * for menus, action lists, and other free-form popover content.
 */
export function DropdownMenu({
  trigger,
  children,
  label,
  placement = 'bottom-start',
  align = 'start',
  className = '',
  menuClassName = '',
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: DropdownMenuProps) {
  const { pickerRef, triggerRef, menuId, open, toggleOpen } = usePopoverListbox();

  const isControlled = controlledOpen !== undefined;
  const isOpen = controlledOpen ?? open;

  const handleToggle = () => {
    if (disabled) return;
    if (isControlled) {
      // In controlled mode, only notify the parent — don't mutate internal state.
      onOpenChange?.(!isOpen);
    } else {
      const next = !isOpen;
      toggleOpen();
      onOpenChange?.(next);
    }
  };

  // In controlled mode the hook's own outside-click listener is gated on internal
  // `open` (always false), so we handle outside clicks here.
  useEffect(() => {
    if (!isControlled || !isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (isOutsidePopoverRoot(pickerRef.current, event.target as Node)) {
        onOpenChange?.(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isControlled, isOpen, onOpenChange, pickerRef]);

  const popoverPlacement = placement.startsWith('top') ? 'top' : 'bottom';
  const popoverAlign: PopoverAlign = align;

  return (
    <div
      ref={pickerRef}
      className={buildDropdownClassName(isOpen, popoverAlign, popoverPlacement, className)}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={handleToggle}
      >
        {trigger}
      </button>
      {isOpen && (
        <div
          id={menuId}
          className={`dropdown-content z-50 ${menuClassName}`.trim()}
          role="menu"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </div>
  );
}
