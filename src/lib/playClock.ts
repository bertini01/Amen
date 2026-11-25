// The audio clock at full frame rate, kept OUTSIDE React.
//
// During playback the Studio store's playhead is only updated ~20 times a
// second: writing it every frame re-rendered the whole Studio 60 times a
// second and cost close to a full CPU core. Anything that must move smoothly
// (the waveform and timeline playhead lines) subscribes here and updates its
// own DOM; anything that must be exact (split, markers) reads `precisePlayhead`.

type Listener = (time: number) => void;

let current = 0;
let running = false;
const listeners = new Set<Listener>();

export const playClock = {
   /** Called by the player every animation frame while audio plays. */
   tick(time: number) {
      current = time;
      running = true;
      listeners.forEach((l) => l(time));
   },
   /** Playback stopped: fall back to the store's playhead. */
   stop() {
      running = false;
   },
   get running() {
      return running;
   },
   subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
         listeners.delete(listener);
      };
   },
};

/** The exact playhead: the live clock while playing, the store's value otherwise. */
export function precisePlayhead(storeValue: number): number {
   return running ? current : storeValue;
}
