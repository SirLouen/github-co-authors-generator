# Privacy policy: GitHub Co-Authors Generator

_Last updated: 18 October 2026_

GitHub Co-Authors Generator is a Chrome extension that adds an "Add co-authors" button to the merge box of
GitHub pull requests. This policy explains what data it handles and where that data goes.

## What the extension handles

- **Your GitHub token.** If you sign in with GitHub or paste a personal access token, the token is stored in
  `chrome.storage.local` in your browser profile. When GitHub issues a sign-in token that expires, the refresh
  token that renews it is stored there too. Only the extension's settings page and service worker can read
  them. The script that runs on github.com never sees them.
- **Pull request data from GitHub.** When you click "Add co-authors", the extension requests the pull request's
  commits, reviews and comments from the GitHub API. From these it takes the names, logins and commit emails of
  the participants, and writes `Co-authored-by:` lines into the commit message box on the page. Your own
  GitHub login and avatar are shown on the settings page.
- **Your settings.** Which groups to credit and the accounts to leave out, stored in `chrome.storage`.

## Where data goes

- All requests go directly from your browser to GitHub: `api.github.com`, and `github.com/login/*` during
  sign-in and to renew an expiring sign-in. The token is only ever sent to GitHub.
- The extension has no server of its own. The developer does not collect, receive, log or store any of your
  data.
- No analytics, tracking, advertising or third-party services are used.
- Data is not sold or transferred to third parties, and is not used for any purpose other than adding
  co-author lines to your commit message.

## Keeping and deleting data

Pull request data is used in memory for one click and not stored. Your token stays in your browser until you
click **Sign out** on the settings page or remove the extension. To revoke a device-flow sign-in on GitHub,
go to [Settings → Applications](https://github.com/settings/applications). To revoke a personal access token,
delete it in your GitHub token settings.

## Contact

Questions about this policy: open an issue at
<https://github.com/SirLouen/github-co-authors-generator/issues>.
