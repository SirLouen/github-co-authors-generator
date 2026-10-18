# Changelog

Every release is listed here, newest first. Each one has a matching `v` tag, a GitHub release with the
Chrome Web Store ZIP attached, and the same version in `extension/manifest.json`.

## [0.1.2] - 2026-10-18

### What's Changed
* Optionally publish releases to the Chrome Web Store from the Release workflow by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/7


**Full Changelog**: https://github.com/SirLouen/github-co-authors-generator/compare/v0.1.1...v0.1.2

## [0.1.1] - 2026-10-18

Fixes "Sign in with GitHub" expiring every day: the extension now renews GitHub's eight-hour sign-in tokens on its own. Sign in once more after updating.

### What's Changed
* Pin the Release workflow's actions to Node 24 releases by commit SHA by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/5
* Keep "Sign in with GitHub" working past eight hours by renewing expiring tokens by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/6


**Full Changelog**: https://github.com/SirLouen/github-co-authors-generator/compare/v0.1.0...v0.1.1

## [0.1.0] - 2026-10-15

### What's Changed
* Add Chrome extension that generates co-authors with your own GitHub auth by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/1
* Fix missing reviewer credit, skip automation and service accounts, handle long PRs by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/2
* Add privacy policy for the Chrome Web Store listing by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/4
* Add a one-click Release workflow with tag, changelog, release page and ZIP by @SirLouen in https://github.com/SirLouen/github-co-authors-generator/pull/3

### New Contributors
* @SirLouen made their first contribution in https://github.com/SirLouen/github-co-authors-generator/pull/1

**Full Changelog**: https://github.com/SirLouen/github-co-authors-generator/commits/v0.1.0
