import { useRef, useState } from "react";
import { ClipboardPaste, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clipboard } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isHttpUrl, normalizeUrl } from "@/lib/url";
import { toast } from "@/stores/toast";

interface UrlBarProps {
   onAnalyze: (url: string) => void;
   analyzing: boolean;
   disabled?: boolean;
}

export function UrlBar({ onAnalyze, analyzing, disabled }: UrlBarProps) {
   const [value, setValue] = useState("");
   const inputRef = useRef<HTMLInputElement>(null);
   const [dragging, setDragging] = useState(false);

   const valid = isHttpUrl(value.trim());

   const handleAnalyze = () => {
      if (!valid || analyzing) return;
      onAnalyze(normalizeUrl(value));
   };

   const handlePaste = async () => {
      const text = (await clipboard.readText()).trim();
      if (!text) {
         toast(
            "Clipboard is empty",
            "Copy a media URL first, then try again.",
            "info",
         );
         return;
      }
      setValue(text);
      if (isHttpUrl(text)) {
         onAnalyze(normalizeUrl(text));
      }
      inputRef.current?.focus();
   };

   const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dt = e.dataTransfer;
      const text = dt.getData("text/plain")?.trim();
      const urls = (
         dt.types.includes("text/uri-list")
            ? dt.getData("text/uri-list")
            : (text ?? "")
      )
         .split(/\r?\n/)
         .map((s) => s.trim())
         .filter((s) => isHttpUrl(s));
      if (urls.length > 0) {
         setValue(urls[0]);
         onAnalyze(normalizeUrl(urls[0]));
      } else {
         toast(
            "No supported URL found",
            "Drop a media link here to analyze it.",
            "info",
         );
      }
   };

   return (
      <div
         onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
         }}
         onDragLeave={() => setDragging(false)}
         onDrop={handleDrop}
         className={cn(
            "group relative rounded-2xl border bg-card shadow-sm transition-all duration-200",
            dragging
               ? "border-primary ring-2 ring-primary/30"
               : "border-border focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/20",
         )}
      >
         <div className="flex items-center gap-2 p-2 pl-4">
            <Search className="h-4.5 w-4.5 shrink-0 text-muted-foreground" />
            <input
               ref={inputRef}
               value={value}
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
               placeholder="Paste a link to music or video you have the right to save…"
               spellCheck={false}
               disabled={disabled || analyzing}
               className="h-10 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-60"
               aria-label="Media URL"
            />
            {value && (
               <button
                  onClick={() => setValue("")}
                  className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-focus-within:opacity-100 data-[visible=true]:opacity-100"
                  data-visible={value.length > 0 || undefined}
                  aria-label="Clear"
               >
                  <X className="h-4 w-4" />
               </button>
            )}
            <Button
               variant="outline"
               size="sm"
               onClick={handlePaste}
               disabled={disabled || analyzing}
            >
               <ClipboardPaste className="h-3.5 w-3.5" />
               Paste
            </Button>
            <Button
               onClick={handleAnalyze}
               size="lg"
               className="h-10"
               disabled={!valid || analyzing}
            >
               {analyzing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
               ) : (
                  "Analyze"
               )}
            </Button>
         </div>
         <div className="pointer-events-none px-4 pb-1.5 text-[11px] text-muted-foreground/70">
            or drag &amp; drop a link here · works with most URLs yt-dlp
            supports
         </div>
      </div>
   );
}
