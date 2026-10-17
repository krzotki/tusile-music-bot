/**
 * The stations, fetched before anybody asks for them.
 *
 * Measured, cold: thirty seven seconds from /radio to the first sound, nearly all of it a
 * single Openverse search. Anonymous Openverse is that slow for a query it has not seen,
 * and the bot was making that query while somebody sat in an empty voice channel waiting
 * for music.
 *
 * The station list is fixed and known at startup, so the batch somebody waits on does not
 * have to be fetched while they wait. The refills after it still go to the network, where
 * nobody is watching the clock.
 *
 * Nothing here is clever about staleness. A batch is served once and then refetched in the
 * background, which is both the freshness policy and the variety policy: two people asking
 * for jazz in one evening should not get the same five tracks.
 */

/** How long after a take to fetch the next batch. Enough that a burst does not queue up. */
const REFETCH_DELAY_MS = 2000;

/**
 * @param {object} deps
 * @param {string[]} deps.stations  which stations to keep warm
 * @param {(query: string) => Promise<object[]>} deps.search
 * @param {(line: string) => void} [deps.log]
 */
function createStationCache({ stations, search, log = () => {}, setTimer = setTimeout }) {
  /** station -> a batch waiting to be served, or undefined. */
  const held = new Map();
  /** station -> a fetch already in flight, so a burst does not start several. */
  const inFlight = new Map();

  async function fetchInto(station) {
    if (inFlight.has(station)) return inFlight.get(station);
    const run = (async () => {
      try {
        const tracks = await search(station);
        if (Array.isArray(tracks) && tracks.length > 0) held.set(station, tracks);
        return tracks ?? [];
      } catch (err) {
        // A station that would not warm is not a station that is broken: the next take
        // falls through to the network and tries again. Poisoning it here would turn one
        // bad minute at Openverse into a station that never works again.
        log(`could not warm ${station}: ${err.message}`);
        return [];
      } finally {
        inFlight.delete(station);
      }
    })();
    inFlight.set(station, run);
    return run;
  }

  return {
    /**
     * Fetch every station once, one at a time.
     *
     * Eighteen at once is eighteen simultaneous requests at a service that is already
     * slow, from a process that has just started. Serial costs minutes of wall clock and
     * nobody is waiting on any of it.
     */
    async warm() {
      let warmed = 0;
      for (const station of stations) {
        const tracks = await fetchInto(station);
        if (tracks.length > 0) warmed += 1;
      }
      log(`stations warmed: ${warmed} of ${stations.length}`);
      return warmed;
    },

    /**
     * A batch for this station, from the pocket when there is one.
     *
     * Taking empties it and starts the next fetch, so the following ask is warm again and
     * gets different tracks. A station nobody warmed is fetched here, slowly, which is
     * still better than refusing.
     */
    async take(station) {
      const ready = held.get(station);
      if (ready && ready.length > 0) {
        held.delete(station);
        setTimer(() => { fetchInto(station).catch(() => {}); }, REFETCH_DELAY_MS).unref?.();
        return ready;
      }
      return fetchInto(station);
    },

    /** What is in the pocket, for a log line or a test. */
    get size() {
      return held.size;
    },
  };
}

export { createStationCache, REFETCH_DELAY_MS };
