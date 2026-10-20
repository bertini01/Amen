import { create } from "zustand";
import { api } from "@/lib/api";
import type { HistoryItem } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

interface HistoryState {
   items: HistoryItem[];
   loaded: boolean;
   /** Why the last refresh failed, if it did. */
   error: string | null;
   query: string;
   formatFilter: string;
   statusFilter: string;
   sort: string;
   setQuery: (q: string) => void;
   setFormatFilter: (f: string) => void;
   setStatusFilter: (s: string) => void;
   setSort: (s: string) => void;
   refresh: () => Promise<void>;
   removeItem: (id: string) => Promise<void>;
   clearAll: () => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
   items: [],
   loaded: false,
   error: null,
   query: "",
   formatFilter: "all",
   statusFilter: "all",
   sort: "date",

   setQuery: (query) => set({ query }),
   setFormatFilter: (formatFilter) => set({ formatFilter }),
   setStatusFilter: (statusFilter) => set({ statusFilter }),
   setSort: (sort) => set({ sort }),

   refresh: async () => {
      const { query, formatFilter, statusFilter, sort } = get();
      try {
         const items = await api.getHistory({
            query: query || undefined,
            formatFilter: formatFilter === "all" ? undefined : formatFilter,
            statusFilter: statusFilter === "all" ? undefined : statusFilter,
            sort,
         });
         set({ items, loaded: true, error: null });
      } catch (e) {
         // Shown inline with a Retry; swallowing it left "Loading…" forever.
         set({ loaded: true, error: errorMessage(e) });
      }
   },

   // Rows are only dropped locally once the backend has actually removed
   // them; otherwise they silently reappear on the next refresh. Errors
   // propagate so the caller can say why.
   removeItem: async (id) => {
      await api.removeHistoryItem(id);
      set({ items: get().items.filter((i) => i.id !== id) });
   },

   clearAll: async () => {
      await api.clearHistory();
      set({ items: [] });
   },
}));
