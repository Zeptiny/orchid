import type { ReactNode } from 'react';
import { buildDropdownClassName } from './popover-listbox-logic';
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

  const isOpen = controlledOpen ?? open;

  const handleToggle = () => {
    if (disabled) return;
    const next = !isOpen;
    toggleOpen();
    onOpenChange?.(next);
  };

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
