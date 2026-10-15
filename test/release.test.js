import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
	addChangelogEntry,
	compareVersions,
	demoteHeadings,
	normalizeVersion,
	prepareRelease,
	setJsonVersion,
} from '../scripts/release.mjs';

describe('normalizeVersion', () => {
	it('accepts one to four numbers and strips a leading v', () => {
		assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
		assert.equal(normalizeVersion(' 2 '), '2');
		assert.equal(normalizeVersion('1.0.0.65535'), '1.0.0.65535');
	});

	it('rejects versions Chrome would refuse', () => {
		for (const bad of ['', 'v', '1.2.3-beta', '01.2', '1..2', '1.2.3.4.5', '1.65536', 'latest']) {
			assert.throws(() => normalizeVersion(bad), /not a valid extension version/, bad);
		}
	});
});

describe('compareVersions', () => {
	it('compares numerically and treats missing parts as zero', () => {
		assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
		assert.equal(compareVersions('1.0', '1.0.0'), 0);
		assert.equal(compareVersions('1.2', '1.2.1'), -1);
	});
});

describe('setJsonVersion', () => {
	it('changes only the top-level version and keeps formatting', () => {
		const manifest = '{\n\t"manifest_version": 3,\n\t"version": "0.1.0",\n\t"permissions": ["storage"]\n}\n';
		assert.equal(
			setJsonVersion(manifest, '0.2.0'),
			'{\n\t"manifest_version": 3,\n\t"version": "0.2.0",\n\t"permissions": ["storage"]\n}\n',
		);
	});

	it('fails when there is no version field', () => {
		assert.throws(() => setJsonVersion('{\n\t"name": "x"\n}\n', '1.0.0'), /No top-level "version"/);
	});
});

describe('demoteHeadings', () => {
	it('moves the shallowest heading to level three', () => {
		assert.equal(demoteHeadings("## What's Changed\n* a\n### New\n* b"), "### What's Changed\n* a\n#### New\n* b");
		assert.equal(demoteHeadings('* only a list'), '* only a list');
	});
});

describe('addChangelogEntry', () => {
	it('creates the file with a header on the first release', () => {
		const result = addChangelogEntry('', '0.1.0', '2026-10-15', "## What's Changed\n* First release");
		assert.match(result, /^# Changelog\n/);
		assert.match(result, /\n## \[0\.1\.0\] - 2026-10-15\n\n### What's Changed\n\* First release\n$/);
	});

	it('puts the newest entry above older ones', () => {
		const first = addChangelogEntry('', '0.1.0', '2026-10-15', '* one');
		const second = addChangelogEntry(first, '0.2.0', '2026-11-01', '* two');
		assert.ok(second.indexOf('## [0.2.0]') < second.indexOf('## [0.1.0]'));
		assert.ok(second.startsWith('# Changelog\n'));
		assert.match(second, /\* two\n\n## \[0\.1\.0\]/);
	});

	it('refuses a version that is already listed', () => {
		const first = addChangelogEntry('', '0.1.0', '2026-10-15', '* one');
		assert.throws(() => addChangelogEntry(first, '0.1.0', '2026-10-16', '* again'), /already has an entry/);
	});

	it('notes an empty release', () => {
		assert.match(addChangelogEntry('', '0.1.0', '2026-10-15', '  \n'), /_No notable changes\._/);
	});
});

describe('prepareRelease', () => {
	async function fixture(version) {
		const root = await mkdtemp(join(tmpdir(), 'release-test-'));
		await mkdir(join(root, 'extension'));
		await writeFile(
			join(root, 'extension', 'manifest.json'),
			`{\n\t"manifest_version": 3,\n\t"version": "${version}"\n}\n`,
		);
		await writeFile(join(root, 'package.json'), `{\n\t"name": "x",\n\t"version": "${version}"\n}\n`);
		return root;
	}

	it('bumps both files and writes the changelog', async () => {
		const root = await fixture('0.1.0');
		try {
			assert.equal(await prepareRelease(root, 'v0.2.0', '2026-10-15', '* change'), '0.2.0');
			assert.equal(JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8')).version, '0.2.0');
			assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.2.0');
			assert.match(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.2\.0\] - 2026-10-15\n\n\* change/);
		} finally {
			await rm(root, { recursive: true });
		}
	});

	it('allows releasing the current version once, for the first release', async () => {
		const root = await fixture('0.1.0');
		try {
			assert.equal(await prepareRelease(root, '0.1.0', '2026-10-15', '* first'), '0.1.0');
			await assert.rejects(prepareRelease(root, '0.1.0', '2026-10-15', '* again'), /already has an entry/);
		} finally {
			await rm(root, { recursive: true });
		}
	});

	it('refuses to go backwards and leaves files untouched', async () => {
		const root = await fixture('0.3.0');
		try {
			await assert.rejects(prepareRelease(root, '0.2.0', '2026-10-15', '* x'), /lower than the current/);
			assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '0.3.0');
		} finally {
			await rm(root, { recursive: true });
		}
	});
});
