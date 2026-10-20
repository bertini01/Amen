import { useCallback } from "react";
import { Plus, Trash2, Play } from "lucide-react";
import type { StudioSource } from "../lib/studioTypes";
import { formatTime } from "../lib/studioTime";
import { colorForSource } from "../lib/studioColors";
import { open } from "../lib/dialog";
import { errorMessage } from "../lib/utils";
import { toast } from "../stores/toast";

interface SourcePanelProps {
   sources: StudioSource[];
   selectedSourceId?: string | null;
   onAddSource?: (path: string) => Promise<void>;
   onRemoveSource?: (id: string) => void;
   onSelectSource?: (id: string) => Promise<void>;
   onPlayPreview?: (path: string) => void;
}

export function SourcePanel({
   sources,
   selectedSourceId,
   onAddSource,
   onRemoveSource,
   onSelectSource,
   onPlayPreview,
}: SourcePanelProps) {
   const handleAddSource = useCallback(async () => {
      try {
         const selected = await open({
            directory: false,
            multiple: false,
            filters: [
               {
                  name: "Audio",
                  extensions: ["mp3", "wav", "flac", "m4a", "aac", "ogg"],
               },
               { name: "All", extensions: ["*"] },
            ],
         });
         if (selected && typeof selected === "string") {
            await onAddSource?.(selected);
         }
      } catch (e) {
         // onAddSource reports its own import failures; this is the picker
         // itself failing, which used to reach only the console.
         toast("Couldn't open the file picker", errorMessage(e), "destructive");
      }
   }, [onAddSource]);

   return (
      <div className="flex flex-col gap-2">
         <div className="flex items-center justify-between">
            <h3 className="font-semibold text-[12px] text-studio-text uppercase tracking-wide">Sources</h3>
            <button
               onClick={handleAddSource}
               className="rounded-md bg-studio-accent p-1 hover:brightness-110 transition text-white"
               title="Add audio file"
            >
               <Plus size={14} />
            </button>
         </div>

         <div className="space-y-1 max-h-48 overflow-y-auto -mx-1 px-1">
            {sources.length === 0 ? (
               <div className="text-[12px] text-studio-text-faint p-2">No sources yet</div>
            ) : (
               sources.map((src) => {
                  const color = colorForSource(src.id);
                  return (
                     <div
                        key={src.id}
                        data-testid="source-item"
                        onClick={() => onSelectSource?.(src.id)}
                        className={`group p-2 rounded-lg cursor-pointer transition ${
                           selectedSourceId === src.id
                              ? "bg-studio-accent/20 ring-1 ring-studio-accent/50"
                              : "hover:bg-studio-raised"
                        }`}
                     >
                        <div className="flex items-start gap-2">
                           <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${color.dot}`} />
                           <div className="flex-1 min-w-0">
                              <div className="text-[12px] truncate font-medium text-studio-text">
                                 {src.name}
                              </div>
                              <div className="text-[11px] text-studio-text-muted tabular-nums">
                                 {formatTime(src.duration)}
                                 {src.sampleRate ? ` @ ${src.sampleRate / 1000}kHz` : ""}
                              </div>
                              {src.bpm && (
                                 <div className="text-[11px] text-studio-snap">{src.bpm.toFixed(1)} BPM</div>
                              )}
                           </div>
                           <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition">
                              <button
                                 onClick={(e) => {
                                    e.stopPropagation();
                                    onPlayPreview?.(src.path);
                                 }}
                                 className="p-1 hover:bg-white/10 rounded text-studio-text-muted hover:text-studio-text transition"
                                 title="Preview"
                              >
                                 <Play size={11} />
                              </button>
                              <button
                                 onClick={(e) => {
                                    e.stopPropagation();
                                    onRemoveSource?.(src.id);
                                 }}
                                 className="p-1 hover:bg-studio-danger/15 rounded text-studio-text-muted hover:text-studio-danger transition"
                                 title="Remove"
                              >
                                 <Trash2 size={11} />
                              </button>
                           </div>
                        </div>
                     </div>
                  );
               })
            )}
         </div>
      </div>
   );
}
