import { Modal } from "./Modal";
import { Button } from "./Button";

// New — built on the existing Modal primitive (design-system pass, agreed
// with the user). No consequential action anywhere in APS Platform today
// asks for confirmation before firing (delete order, delete operator,
// clear all data all execute immediately on click) — this is the first
// real confirm-before-you-commit step, available for the redesign to use
// wherever a destructive action needs one.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-2 text-sm text-muted">{description}</p>}
      <div className="mt-5 flex gap-2">
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </Modal>
  );
}
