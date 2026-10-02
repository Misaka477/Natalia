import { Show, createSignal, type JSX } from "solid-js";

type DialogRequest = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  mode?: "confirm" | "alert";
  resolve: (value: boolean) => void;
};

export function useConfirmDialog() {
  const [request, setRequest] = createSignal<DialogRequest | undefined>();
  const confirm = (input: {
    message: string;
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }) =>
    new Promise<boolean>((resolve) => {
      setRequest({ ...input, mode: "confirm", resolve });
    });

  const alert = (input: {
    message: string;
    title?: string;
    confirmLabel?: string;
    danger?: boolean;
  }) =>
    new Promise<void>((resolve) => {
      setRequest({
        ...input,
        mode: "alert",
        resolve: () => resolve(),
      });
    });

  const dialog: JSX.Element = (
    <Show when={request()}>
      {(current) => (
        <div
          class="neu-confirm-backdrop"
          onClick={() => {
            current().resolve(false);
            setRequest(undefined);
          }}
        >
          <div
            class="neu-confirm-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-confirm-title">{current().title ?? "提示"}</div>
            <div class="neu-confirm-message">{current().message}</div>
            <div class="neu-confirm-actions">
              <Show when={current().mode !== "alert"}>
                <button
                  type="button"
                  class="neu-confirm-cancel"
                  onClick={() => {
                    current().resolve(false);
                    setRequest(undefined);
                  }}
                >
                  {current().cancelLabel ?? "取消"}
                </button>
              </Show>
              <button
                type="button"
                class="neu-confirm-ok"
                data-danger={current().danger ? "true" : undefined}
                onClick={() => {
                  current().resolve(true);
                  setRequest(undefined);
                }}
              >
                {current().confirmLabel ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
  return { confirm, alert, dialog };
}
