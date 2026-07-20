/**
 * Icon-only row actions for definition cards (reveal / edit / delete).
 */
import { IconButton } from '../ui/IconButton';

export interface DefinitionActionsProps {
  onReveal?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /**
   * Hide edit and delete (fully locked).
   * Prefer omitting `onDelete` when only delete should be blocked.
   */
  readOnly?: boolean;
}

export function DefinitionActions({
  onReveal,
  onEdit,
  onDelete,
  readOnly = false,
}: DefinitionActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onReveal && (
        <IconButton
          label="Reveal in folder"
          icon="folder"
          size="xs"
          iconSize={13}
          className="btn-square h-7 w-7 min-h-7"
          onClick={onReveal}
        />
      )}
      {!readOnly && onEdit && (
        <IconButton
          label="Edit"
          icon="edit"
          size="xs"
          iconSize={13}
          className="btn-square h-7 w-7 min-h-7"
          onClick={onEdit}
        />
      )}
      {!readOnly && onDelete && (
        <IconButton
          label="Delete"
          icon="trash"
          size="xs"
          /* Ghost + text-error: transparent button with error-colored icon on hover.
             variant="error" would render a filled error button, which is too heavy
             for a row action. IconButton has no "ghost-error" variant, so we pair
             variant="ghost" (transparent) with text-error/hover overrides. */
          variant="ghost"
          iconSize={13}
          className="btn-square h-7 w-7 min-h-7 text-error hover:bg-error/10"
          onClick={onDelete}
        />
      )}
    </div>
  );
}
