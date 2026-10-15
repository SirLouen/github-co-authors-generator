// Release helpers used by .github/workflows/release.yml.
//
//   node scripts/release.mjs version <version>
//
// Prints <version> without a leading "v", or fails if Chrome would reject it.
//
//   node scripts/release.mjs prepare <version> <date> <notes-file>
//
// Sets <version> in extension/manifest.json and package.json and adds a <date> section with the
// contents of <notes-file> to the top of CHANGELOG.md. Prints the normalized version.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANGELOG_HEADER = `# Changelog

Every release is listed here, newest first. Each one has a matching \`v\` tag, a GitHub release with the
Chrome Web Store ZIP attached, and the same version in \`extension/manifest.json\`.
`;

// Chrome accepts one to four dot-separated integers from 0 to 65535, without leading zeros.
export function normalizeVersion(input) {
	const version = String(input ?? '').trim().replace(/^v/, '');
	const parts = version.split('.');
	const valid =
		parts.length >= 1 &&
		parts.length <= 4 &&
		parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535);
	if (!valid) {
		throw new Error(
			`"${input}" is not a valid extension version. Use one to four numbers separated by dots, such as 1.2.0.`,
		);
	}
	return version;
}

export function compareVersions(a, b) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) {
			return Math.sign(diff);
		}
	}
	return 0;
}

// Rewrites the top-level "version" value without reformatting the rest of the file.
export function setJsonVersion(text, version) {
	const pattern = /^(\t| {2})"version":\s*"[^"]*"/m;
	if (!pattern.test(text)) {
		throw new Error('No top-level "version" field found.');
	}
	return text.replace(pattern, (match, indent) => `${indent}"version": "${version}"`);
}

// Shifts the notes' headings down so the shallowest one sits just below the version heading.
export function demoteHeadings(notes) {
	const levels = [...notes.matchAll(/^(#{1,6}) /gm)].map((match) => match[1].length);
	if (levels.length === 0) {
		return notes;
	}
	const shift = Math.max(0, 3 - Math.min(...levels));
	return notes.replace(/^(#{1,6}) /gm, (match, hashes) => `${'#'.repeat(Math.min(6, hashes.length + shift))} `);
}

export function hasChangelogEntry(changelog, version) {
	return changelog.split('\n').some((line) => line.startsWith(`## [${version}]`));
}

export function addChangelogEntry(changelog, version, date, notes) {
	const existing = changelog.trim() ? changelog : CHANGELOG_HEADER;
	if (hasChangelogEntry(existing, version)) {
		throw new Error(`CHANGELOG.md already has an entry for ${version}.`);
	}
	const body = demoteHeadings(notes.trim()) || '_No notable changes._';
	const entry = `## [${version}] - ${date}\n\n${body}\n`;
	const firstEntry = existing.search(/^## /m);
	if (firstEntry === -1) {
		return `${existing.trimEnd()}\n\n${entry}`;
	}
	return `${existing.slice(0, firstEntry)}${entry}\n${existing.slice(firstEntry)}`;
}

async function readOptional(path) {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return '';
		}
		throw error;
	}
}

export async function prepareRelease(root, input, date, notes) {
	const version = normalizeVersion(input);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`"${date}" is not a YYYY-MM-DD date.`);
	}

	const manifestPath = join(root, 'extension', 'manifest.json');
	const packagePath = join(root, 'package.json');
	const changelogPath = join(root, 'CHANGELOG.md');

	const manifest = await readFile(manifestPath, 'utf8');
	const current = JSON.parse(manifest).version;
	if (compareVersions(version, current) < 0) {
		throw new Error(`Version ${version} is lower than the current manifest version ${current}.`);
	}

	const changelog = await readOptional(changelogPath);
	const updatedChangelog = addChangelogEntry(changelog, version, date, notes);

	await writeFile(manifestPath, setJsonVersion(manifest, version));
	await writeFile(packagePath, setJsonVersion(await readFile(packagePath, 'utf8'), version));
	await writeFile(changelogPath, updatedChangelog);
	return version;
}

async function main(args) {
	const [command, version, date, notesFile] = args;
	if (command === 'version' && version !== undefined) {
		console.log(normalizeVersion(version));
		return;
	}
	if (command !== 'prepare' || !version || !date || !notesFile) {
		throw new Error(
			'Usage: node scripts/release.mjs version <version>\n' +
				'       node scripts/release.mjs prepare <version> <YYYY-MM-DD> <notes-file>',
		);
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const notes = await readFile(notesFile, 'utf8');
	console.log(await prepareRelease(root, version, date, notes));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
