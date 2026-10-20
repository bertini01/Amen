import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { dismissRequest, useUiDialogStore } from "../stores/uiDialog";

/**
 * Renders the in-app replacement for window.confirm/alert/prompt (see
 * src/stores/uiDialog.ts for why native dialogs can't be used here). Mounted
 * ONCE at the app root, so it works from every view — and styled with the
 * app-wide tokens rather than the Studio-only ones, which only exist inside
 * `.studio-shell`.
 */
export function UiDialogHost() {
   const request = useUiDialogStore((s) => s.request);
   const clear = useUiDialogStore((s) => s.clear);
   const [value, setValue] = useState("");
   const inputRef = useRef<HTMLInputElement>(null);

   useEffect(() => {
      if (request?.kind === "prompt") {
         setValue(request.defaultValue);
         setTimeout(() => inputRef.current?.select(), 0);
      }
   }, [request]);

   if (!request) return null;

   const dismiss = () => {
      dismissRequest(request);
      clear();
   };
   const accept = () => {
      if (request.kind === "confirm") request.resolve(true);
      else if (request.kind === "alert") request.resolve();
      else if (request.kind === "prompt") request.resolve(value);
      clear();
   };
   const choose = (id: string) => {
      if (request.kind === "choice") request.resolve(id);
      clear();
   };

   const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
         e.stopPropagation();
         dismiss();
      } else if (e.key === "Enter" && request.kind === "prompt") {
         accept();
      }
   };

   const title = request.kind === "prompt" ? undefined : request.title;

   return (
      <div
         className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
         data-testid="ui-dialog-host"
         role="dialog"
         aria-modal="true"
         onKeyDown={handleKeyDown}
      >
         <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl animate-scale-in">
            {title && <h2 className="mb-1.5 text-[15px] font-semibold tracking-tight">{title}</h2>}
            <p
               className="mb-4 whitespace-pre-line break-words text-sm text-muted-foreground"
               data-testid="ui-dialog-message"
            >
               {request.message}
            </p>

            {request.kind === "prompt" && (
               <input
                  ref={inputRef}
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  data-testid="ui-dialog-input"
                  autoFocus
                  className="mb-4 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
               />
            )}

            <div className="flex flex-wrap justify-end gap-2">
               {request.kind === "alert" ? (
                  <Button size="sm" onClick={accept} autoFocus data-testid="ui-dialog-ok">
                     OK
                  </Button>
               ) : request.kind === "choice" ? (
                  <>
                     <Button size="sm" variant="ghost" onClick={dismiss} data-testid="ui-dialog-cancel">
                        {request.cancelLabel}
                     </Button>
                     {request.choices.map((c) => (
                        <Button
                           key={c.id}
                           size="sm"
                           variant={c.primary ? "default" : "outline"}
                           autoFocus={c.primary}
                           onClick={() => choose(c.id)}
                           data-testid={c.primary ? "ui-dialog-ok" : `ui-dialog-choice-${c.id}`}
                        >
                           {c.label}
                        </Button>
                     ))}
                  </>
               ) : (
                  <>
                     <Button size="sm" variant="outline" onClick={dismiss} data-testid="ui-dialog-cancel">
                        {request.kind === "confirm" ? (request.cancelLabel ?? "Cancel") : "Cancel"}
                     </Button>
                     <Button
                        size="sm"
                        variant={request.kind === "confirm" && request.destructive ? "destructive" : "default"}
                        onClick={accept}
                        autoFocus={request.kind !== "prompt"}
                        data-testid="ui-dialog-ok"
                     >
                        {request.kind === "confirm" ? (request.confirmLabel ?? "OK") : "OK"}
                     </Button>
                  </>
               )}
            </div>
         </div>
      </div>
   );
}
