/**
 * /play with nothing to say.
 *
 * Asked for directly: there should be a way to just have music on. The catalogue here is
 * openly licensed music rather than a station somebody else is programming, so the radio
 * is a shuffle over it that keeps itself topped up.
 *
 * Nothing in here talks to anything. It decides what to ask for next; `search` does the
 * asking and the player does the playing.
 */

/**
 * What the radio asks for, in rotation.
 *
 * Genres rather than moods or artists, because the index answers genres well and a mood is
 * a word a tagger may not have used. Ten of them, so an evening is not one taste: the
 * failure this guards against is a radio that is recognisably a playlist.
 */
const SEEDS = [
  'lofi',
  'ambient',
  'chillhop',
  'jazz',
  'electronic',
  'acoustic guitar',
  'piano',
  'synthwave',
  'folk',
  'downtempo',
  'techno',
  'rock',
  'classical',
  'hip hop',
  'blues',
  'funk',
  'reggae',
  'metal',
];

/**
 * The stations, as the command picker wants them.
 *
 * Fixed choices rather than free text. The picker then shows the list, which is the only
 * way somebody learns that "chillhop" is a station and "the beatles" is not: this is an
 * openly licensed catalogue, so a station has to be something it actually has. Every one
 * of these was counted against Openverse before it went on the list, and the thinnest
 * (lofi) still has well over a hundred tracks.
 *
 * Built from SEEDS rather than listed twice, so a station cannot exist that the mixed
 * shuffle has never heard of.
 */
function stationChoices() {
  return SEEDS.map((value) => ({
    name: value.charAt(0).toUpperCase() + value.slice(1),
    value,
  }));
}

/**
 * The next seed, never the one just used.
 *
 * Two in a row from the same seed is a station playing the same artist twice, which is the
 * most noticeable way a shuffle looks broken. `previous` is null before anything has
 * played.
 */
function nextSeed(previous, random = Math.random) {
  const choices = SEEDS.filter((s) => s !== previous);
  return choices[Math.floor(random() * choices.length)];
}

/**
 * Which page of the results to ask for.
 *
 * Openverse has no "random", so variety comes from asking for a different page. Without
 * this the radio is the first few results of ten queries, forever: the same forty tracks
 * in the same order every evening, which is worse than a short playlist because it
 * pretends to be more.
 *
 * Capped at what the index actually has, and at a page the API will serve: asking past the
 * end is an error rather than an empty page, and a deep page of a thin result set is both.
 */
function pickPage(resultCount, pageSize, random = Math.random) {
  const pages = Math.max(1, Math.min(MAX_PAGE, Math.ceil((resultCount || 0) / pageSize)));
  return 1 + Math.floor(random() * pages);
}

/**
 * How deep into the results to go.
 *
 * Far enough that an evening does not repeat, shallow enough that it is still the sort of
 * thing the query asked for: page forty of "jazz" is not more jazz, it is whatever the
 * index ran out of ideas about.
 */
const MAX_PAGE = 10;

export { SEEDS, stationChoices, nextSeed, pickPage, MAX_PAGE };
