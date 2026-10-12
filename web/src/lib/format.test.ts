/**
 * Tests for the pure formatting helpers.
 *
 * ## Why these run in `node` and not in a browser
 *
 * `cleanTitle` is a regular expression against strings that arrive from a server
 * we do not control, and it has already been wrong twice in ways no type check
 * could see:
 *
 * 1. A pattern that stripped only the *last* trailing group left `[Hindi]` on
 *    `Drishyam: The Conclusion [Hindi][CAM]` -- the most common title shape
 *    upstream has.
 * 2. The fix for that, a single `(?:...)+$` run pattern, could not also keep a
 *    year: `The Matrix (1999) [Hindi][CAM]` lost the `(1999)` as well.
 *
 * Both were only visible by looking at rendered output, and neither would ever
 * have been caught by a type check. Tests that need no DOM are the cheapest
 * possible place to pin behaviour like this.
 *
 * ## Why `node:test` and not a test framework
 *
 * The helpers under test are pure functions with no JSX and no imports, so
 * `tsc` plus `node --test` covers them outright. Pulling in vitest would add a
 * runner, a config file and a transform pipeline to test code that needs none of
 * it. If the suite later needs to cover components, that is the moment to add a
 * framework -- not before.
 *
 * ## Running
 *
 * `npm test`, which compiles this file and runs it. Kept out of `npm run build`
 * deliberately: a failing test should not block a working build.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `.ts` rather than `.js`: node runs this file with type stripping, which does no
// specifier rewriting, so it has to resolve a file that exists on disk. Allowed
// by `allowImportingTsExtensions` in tsconfig, and the same specifier Vite wants.
import { cleanTitle, describeTitle } from './format.ts';

describe('cleanTitle', () => {
  /**
   * The ordinary case, and the reason this function exists: MovieBox appends
   * delivery metadata to nearly every title, and a poster grid full of
   * `[Hindi][CAM]` reads like a search-results page.
   */
  it('strips a single trailing release group', () => {
    assert.equal(cleanTitle('Chernobyl [Hindi]'), 'Chernobyl');
  });

  /**
   * The bug that motivated a rewrite. A pattern anchored to the end and matching
   * one group stops after `[CAM]`, leaving `[Hindi]` behind -- on the single most
   * common title shape upstream produces.
   */
  it('strips a whole run of trailing groups, not just the last', () => {
    assert.equal(
      cleanTitle('Drishyam: The Conclusion [Hindi][CAM]'),
      'Drishyam: The Conclusion',
    );
    assert.equal(cleanTitle('KGF: Chapter 2 [Hindi][CAM][1080p]'), 'KGF: Chapter 2');
    assert.equal(cleanTitle('F1: The Movie [Hindi][CAM][WEB-DL]'), 'F1: The Movie');
  });

  /**
   * A run whose groups are separated by spaces. `[18+]` is a real MovieBox rating
   * tag and appears alongside the language tag on the Midnight tab.
   */
  it('strips a spaced run of trailing groups', () => {
    assert.equal(cleanTitle('Midnight [18+] [Hindi]'), 'Midnight');
  });

  /**
   * A year is part of the title, not release noise.
   */
  it('keeps a trailing year', () => {
    assert.equal(cleanTitle('Aliens (1986)'), 'Aliens (1986)');
    assert.equal(cleanTitle('Black Mirror (2011)'), 'Black Mirror (2011)');
    assert.equal(cleanTitle('Dune: Part Two (2024)'), 'Dune: Part Two (2024)');
    assert.equal(cleanTitle('5 Centimeters per Second (2007)'), '5 Centimeters per Second (2007)');
  });

  /**
   * The hard case, and the reason a single run pattern is not enough: noise goes,
   * the year stays. A `(?:...)+$` regex cannot express this, because it would
   * have to span the run and then decline to span part of it.
   */
  it('keeps a year that sits before a run of release groups', () => {
    assert.equal(cleanTitle('The Matrix (1999) [Hindi][CAM]'), 'The Matrix (1999)');
    assert.equal(cleanTitle('Oppenheimer (2023) [Hindi]'), 'Oppenheimer (2023)');
    assert.equal(
      cleanTitle('Distant Horizon (2007) [Hindi][CAM][720p]'),
      'Distant Horizon (2007)',
    );
    assert.equal(
      cleanTitle('Dune: Part Two (2024) [Hindi][CAM][1080p][WEBRip]'),
      'Dune: Part Two (2024)',
    );
  });

  /**
   * Only the suffix is ever examined, so a bracketed word in the middle of a
   * real title is part of the name.
   */
  it('leaves a bracketed group in the middle of a title alone', () => {
    assert.equal(cleanTitle('The [Hindi] Avengers'), 'The [Hindi] Avengers');
  });

  /**
   * `(Se7en)` is a stylisation of the number, not a year, so it is treated as
   * noise. Listed because it is the nearest miss to the year rule and the one
   * case where the heuristic is visibly wrong -- and removing it is not worth a
   * title table.
   */
  it('treats a parenthesised number that is not a year as noise', () => {
    assert.equal(cleanTitle('Se7en (Se7en)'), 'Se7en');
  });

  it('leaves a title with no trailing group untouched', () => {
    assert.equal(cleanTitle('Sardar 2'), 'Sardar 2');
    assert.equal(cleanTitle('The Bear'), 'The Bear');
    assert.equal(cleanTitle('Breaking Bad [Complete Series]'), 'Breaking Bad');
  });

  /**
   * Upstream titles are not consistently trimmed, and the year suffix often
   * carries trailing whitespace with it.
   */
  it('collapses runs of whitespace and trims the ends', () => {
    assert.equal(cleanTitle('  Drishyam   2  '), 'Drishyam 2');
    assert.equal(cleanTitle('Dune (2021) '), 'Dune (2021)');
  });

  /**
   * A title that was *only* metadata, or nothing at all, has to render as
   * something. An empty `<h3>` is a worse outcome than a placeholder.
   */
  it('falls back to Untitled when there is no name left', () => {
    assert.equal(cleanTitle('[CAM]'), 'Untitled');
    assert.equal(cleanTitle('[18+]'), 'Untitled');
    assert.equal(cleanTitle(''), 'Untitled');
    assert.equal(cleanTitle('   '), 'Untitled');
    assert.equal(cleanTitle(null), 'Untitled');
    assert.equal(cleanTitle(undefined), 'Untitled');
  });

  /**
   * Guards the loop against a trailing year that is the whole title.
   */
  it('does not strip a title that is only a year', () => {
    assert.equal(cleanTitle('(2011)'), '(2011)');
  });
});

describe('describeTitle', () => {
  it('appends the year to a cleaned title', () => {
    assert.equal(describeTitle('Chernobyl [Hindi][CAM]', '2019'), 'Chernobyl (2019)');
    assert.equal(describeTitle('Midnight [18+]', null), 'Midnight');
    assert.equal(describeTitle('Dune', '2021'), 'Dune (2021)');
  });

  /**
   * Every caller used to inline this as
   * `` `${title}${year ? ` (${year})` : ''}` ``, which skipped `cleanTitle`
   * entirely -- so resume and favourite rows showed
   * `Chernobyl [Hindi][CAM] (2019)` while poster cards showed `Chernobyl`. These
   * two cases are the regression guard for that split.
   */
  it('cleans the title even when a year is appended', () => {
    assert.equal(describeTitle('Aliens (1986)', null), 'Aliens (1986)');
    assert.equal(describeTitle('Distant Horizon (2007) [Hindi][CAM]', '2007'), 'Distant Horizon (2007) (2007)');
  });

  it('still names an untitled item', () => {
    assert.equal(describeTitle(null, '2021'), 'Untitled (2021)');
  });
});
