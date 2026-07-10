/**
 * Icon-only row actions for definition cards (reveal / edit / delete).
 */
import { Icon } from '../Icon';

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
        <button
          type="button"
          className="btn btn-ghost btn-square btn-xs h-7 w-7 min-h-7"
          onClick={onReveal}
          title="Reveal in folder"
          aria-label="Reveal in folder"
        >
          <Icon name="folder" size={13} />
        </button>
      )}
      {!readOnly && onEdit && (
        <button
          type="button"
          className="btn btn-ghost btn-square btn-xs h-7 w-7 min-h-7"
          onClick={onEdit}
          title="Edit"
          aria-label="Edit"
        >
          <Icon name="edit" size={13} />
        </button>
      )}
      {!readOnly && onDelete && (
        <button
          type="button"
          className="btn btn-ghost btn-square btn-xs h-7 w-7 min-h-7 text-error hover:bg-error/10"
          onClick={onDelete}
          title="Delete"
          aria-label="Delete"
        >
          <Icon name="trash" size={13} />
        </button>
      )}
    </div>
  );
}
