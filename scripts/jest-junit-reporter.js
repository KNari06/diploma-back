// ─────────────────────────────────────────────────────────────────────────────
// A JUnit XML reporter for Jest, written here instead of installed.
//
// Why not `jest-junit`: the merge gate only needs GitLab's Test summary widget
// to name the broken test instead of making someone read 7000 lines of job log.
// That is a formatting concern, and paying for it with a dependency (plus its
// transitives) in the tree of a service that ships to prod is the trade this
// repo's supply-chain rule tells us not to make — see
// ../.claude/rules/supply-chain.md. The three sibling repos get the same widget
// for free because vitest has the reporter built in; jest does not, so the
// ~130 lines below are the whole difference.
//
// Wired in from the CI job only (`--reporters=default --reporters=<this file>`),
// so a local `npm test` is unchanged and writes nothing.
//
// Jest requires reporters directly — no ts-jest transform runs on this file —
// so it is CommonJS JavaScript, not TypeScript, deliberately.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

/** GitLab renders the failure body verbatim; a full jest diff can be enormous. */
const MAX_FAILURE_CHARS = 8000;

/** Jest colourises failure output even under --ci; those codes are not XML. */
const ANSI = /\x1b\[[0-9;]*m/g;

/** Control chars that are simply not representable in XML 1.0. */
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const SKIPPED_STATUSES = new Set(['pending', 'todo', 'skipped', 'disabled']);

function clean(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(ANSI, '')
    .replace(INVALID_XML_CHARS, '');
}

function escapeXml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value) {
  const text = clean(value);
  return text.length <= MAX_FAILURE_CHARS
    ? text
    : `${text.slice(0, MAX_FAILURE_CHARS)}\n… truncated, see the job log for the full output`;
}

/** Jest reports milliseconds; JUnit `time` is seconds. */
function seconds(ms) {
  return ((ms || 0) / 1000).toFixed(3);
}

class JUnitReporter {
  constructor(globalConfig, options) {
    this._rootDir = (globalConfig && globalConfig.rootDir) || process.cwd();
    this._outputFile =
      (options && options.outputFile) || process.env.JUNIT_OUTPUT_FILE || 'junit.xml';
  }

  onRunComplete(_contexts, results) {
    const suites = results.testResults.map((suite) => this._renderSuite(suite));

    // Totalled from what was actually emitted, NOT from `results.numTotalTests`:
    // a suite that failed to load contributes a synthetic case below but counts
    // zero in jest's aggregate, so the two disagree exactly when it matters.
    const totals = suites.reduce(
      (acc, s) => ({
        tests: acc.tests + s.tests,
        failures: acc.failures + s.failures,
        skipped: acc.skipped + s.skipped,
      }),
      { tests: 0, failures: 0, skipped: 0 }
    );

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="jest" tests="${totals.tests}" failures="${totals.failures}" errors="0" skipped="${
        totals.skipped
      }" time="${seconds(Date.now() - results.startTime)}">`,
      ...suites.map((s) => s.xml),
      '</testsuites>',
      '',
    ].join('\n');

    const target = path.resolve(this._rootDir, this._outputFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, xml, 'utf8');
  }

  _renderSuite(suite) {
    const name = path.relative(this._rootDir, suite.testFilePath) || suite.testFilePath;
    const cases = suite.testResults.map((test) => this._renderCase(name, test));
    let failures = suite.testResults.filter((t) => t.status === 'failed').length;
    const skipped = suite.testResults.filter((t) => SKIPPED_STATUSES.has(t.status)).length;

    // A suite that dies while loading (bad import, syntax error, a mock that
    // throws at module scope) reports ZERO assertions — with nothing emitted
    // here the widget would show an empty green suite, which is exactly
    // backwards, and this is the failure mode a merge gate exists to catch.
    if (cases.length === 0 && (suite.testExecError || suite.failureMessage)) {
      const detail = suite.failureMessage || String(suite.testExecError);
      cases.push(
        [
          `    <testcase classname="${escapeXml(name)}" name="Test suite failed to run" file="${escapeXml(
            name
          )}" time="0.000">`,
          `      <failure message="Test suite failed to run">${escapeXml(
            truncate(detail)
          )}</failure>`,
          '    </testcase>',
        ].join('\n')
      );
      failures += 1;
    }

    const startedAt = new Date(
      (suite.perfStats && suite.perfStats.start) || Date.now()
    ).toISOString();

    return {
      tests: cases.length,
      failures,
      skipped,
      xml: [
        `  <testsuite name="${escapeXml(name)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(
          suite.perfStats && suite.perfStats.runtime
        )}" timestamp="${startedAt}">`,
        ...cases,
        '  </testsuite>',
      ].join('\n'),
    };
  }

  _renderCase(suiteName, test) {
    // GitLab keys a test by classname + name, so the file path has to be part of
    // the classname: `describe('handles errors')` is not unique across 534 files.
    const classname = [suiteName, ...test.ancestorTitles].join(' › ');
    const open = `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(
      test.title
    )}" file="${escapeXml(suiteName)}" time="${seconds(test.duration)}">`;

    if (test.status === 'failed') {
      const messages = test.failureMessages && test.failureMessages.length
        ? test.failureMessages
        : ['Test failed'];
      // `message` is the one line the widget lists; the body carries the diff.
      const summary = clean(messages[0]).split('\n')[0] || 'Test failed';
      return [
        open,
        `      <failure message="${escapeXml(summary)}">${escapeXml(
          truncate(messages.join('\n\n'))
        )}</failure>`,
        '    </testcase>',
      ].join('\n');
    }

    if (SKIPPED_STATUSES.has(test.status)) {
      return [open, '      <skipped/>', '    </testcase>'].join('\n');
    }

    return `${open}</testcase>`;
  }
}

module.exports = JUnitReporter;
