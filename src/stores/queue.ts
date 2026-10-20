import { create } from "zustand";
import { api, onEvent } from "@/lib/api";
import type { Job, JobStatus } from "@/lib/types";

interface QueueState {
   jobs: Job[];
   loaded: boolean;
   refresh: () => Promise<void>;
   upsert: (job: Job) => void;
   remove: (id: string) => void;
   cancel: (id: string) => Promise<void>;
   retry: (id: string) => Promise<void>;
   removeJob: (id: string) => Promise<void>;
   clearCompleted: () => Promise<void>;
   activeCount: () => number;
}

export const useQueueStore = create<QueueState>((set, get) => ({
   jobs: [],
   loaded: false,

   refresh: async () => {
      try {
         const jobs = await api.listJobs();
         set({ jobs, loaded: true });
      } catch {
         /* non-fatal */
      }
   },

   upsert: (job) => {
      const jobs = get().jobs;
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx >= 0) {
         const next = [...jobs];
         next[idx] = job;
         set({ jobs: next });
      } else {
         set({ jobs: [job, ...jobs] });
      }
   },

   remove: (id) => set({ jobs: get().jobs.filter((j) => j.id !== id) }),

   // These four used to swallow backend errors, so the UI toasted
   // "Cancelled" / "Re-queued" / "Cleared" for actions that never happened.
   // They now rethrow (after re-syncing the queue) and callers report the
   // real reason.
   cancel: async (id) => {
      try {
         await api.cancelDownload(id);
      } finally {
         await get().refresh();
      }
   },

   retry: async (id) => {
      try {
         await api.retryDownload(id);
      } finally {
         await get().refresh();
      }
   },

   removeJob: async (id) => {
      await api.removeJob(id);
      get().remove(id);
   },

   clearCompleted: async () => {
      try {
         await api.clearCompletedJobs();
      } finally {
         await get().refresh();
      }
   },

   activeCount: () => {
      const active: JobStatus[] = [
         "pending",
         "fetching",
         "downloading",
         "processing",
      ];
      return get().jobs.filter((j) => active.includes(j.status)).length;
   },
}));

/** Wire Tauri events into the queue store. Called once at startup. */
export function initQueueEvents() {
   onEvent("download-updated", (job) => useQueueStore.getState().upsert(job));
   onEvent("download-finished", (job) => {
      useQueueStore.getState().upsert(job);
      // keep history fresh
      useHistoryRefresh();
   });
   onEvent("download-failed", (payload) => {
      useQueueStore.getState().upsert(payload.job);
      useHistoryRefresh();
   });
}

// history store import (avoid circular import at module top)
import { useHistoryStore } from "./history";
function useHistoryRefresh() {
   useHistoryStore.getState().refresh();
}
