# GitHub Co-Authors Generator

A Chrome extension that helps you generate co-author information for your GitHub commits.

It adds an <kbd>Add co-authors</kbd> button under the commit message in the merge box of GitHub pull
requests. Pressing it collects the people who took part in the pull request and appends
`Co-authored-by:` trailers for them to the extended description, so they get credit in the merge commit.

Unlike extensions that call the GitHub API anonymously (60 requests per hour, shared by everyone on your
IP address), this one signs in with **your own GitHub account**. Requests go straight from your browser
to `api.github.com` with your token, so you get 5,000 requests per hour and do not depend on a third-party
server.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the [`extension/`](extension) folder.

The settings page opens right after installing. You can reopen it at any time by clicking the extension's
toolbar icon.

## Sign in

Pick one of the two options on the settings page.

### Option A: Sign in with GitHub (device flow)

GitHub's device flow needs the client ID of an OAuth App. You create it once, and it is not a secret.

1. Go to [**Settings → Developer settings → OAuth Apps → New OAuth App**](https://github.com/settings/applications/new).
2. Fill in any name, and any URL for **Homepage URL** and **Authorization callback URL**
   (for example `https://github.com`). The callback is not used.
3. Tick **Enable Device Flow** and click **Register application**.
4. Copy the **Client ID**. Either paste it under **Advanced** on the extension's settings page, or set it as
   `DEFAULT_OAUTH_CLIENT_ID` in [`extension/config.js`](extension/config.js) so every install of your copy has it.
5. Click **Sign in with GitHub**, then **Copy code and open GitHub**, paste the code, and approve.

By default the token has no scopes, which gives read-only access to public data. That is enough for public
repositories. To use the button on private repositories, tick **Also request access to private
repositories** before signing in. GitHub only offers the broad `repo` scope for that. Option B is the
least-privilege alternative.

### Option B: Personal access token

Create a token and paste it into the settings page:

- **Fine-grained token** ([create one](https://github.com/settings/personal-access-tokens/new)): choose
  *Public repositories* for public projects. For private ones, select the repositories and grant
  **Pull requests: Read-only**.
- **Classic token** ([create one](https://github.com/settings/tokens/new?description=GitHub%20Co-Authors%20Generator)):
  no scopes for public repositories, `repo` for private ones.

If an organization enforces SAML single sign-on, authorize the token for that organization as well.

## Use

1. On a pull request, click **Merge pull request** or **Squash and merge** so the commit form appears.
2. Click **Add co-authors**. The trailers are appended to **Extended description**, and a status line shows
   how many people were added and how many API requests you have left.
3. Review the description and confirm the merge.

Clicking again adds nothing new, so it is safe to press more than once.

## Who gets credited

Choose the groups on the settings page:

| Setting | Default |
| --- | --- |
| Commit authors, plus the `Co-authored-by` trailers already in their commits | on |
| Reviewers and review commenters | on |
| Conversation commenters | on |
| The pull request author | off: GitHub already makes them the author of a squash merge |
| Names from GitHub profiles, instead of logins (needs sign-in) | on |

Some rules always apply:

- Bots (Dependabot, GitHub Actions, Copilot, …) and deleted accounts are skipped.
- People already listed as co-authors in the description are not added again. This includes the trailers
  GitHub pre-fills when you squash and merge. The email in *"This commit will be authored by …"* is never
  added either.
- When a bot opened the pull request, GitHub makes the person merging the commit author, so you are not
  added as a co-author of your own commit.
- Emails: commit authors keep the email from their commits, the same one GitHub uses in its own trailers.
  Everyone else gets their GitHub no-reply address (`ID+login@users.noreply.github.com`), which GitHub
  always attributes to their account without exposing a private email.

Each click makes about five REST requests: the pull request, its commits, reviews, review comments and
conversation comments. Lists of more than 100 items need extra requests. Signed in, it also makes one
GraphQL request for profile names.

## Privacy and permissions

- The token is stored in `chrome.storage.local` in your browser profile. Storage access is restricted to the
  extension's own pages and service worker. The script running on github.com never sees the token. It asks
  the service worker to make the API calls.
- The token is only sent to `api.github.com`. During sign-in, the extension also contacts `github.com/login/*`.
- Permissions: `storage` for settings, plus host access to `api.github.com` and `github.com/login/*`. The
  content script runs on `github.com` pages to add the button.
- **Sign out** removes the token from the browser. To revoke it on GitHub as well, go to
  [Settings → Applications](https://github.com/settings/applications) for device-flow sign-ins, or delete the
  personal access token.

## Development

```
extension/
├── manifest.json        Manifest V3
├── background.js        Service worker: authenticated GitHub API calls
├── config.js            Default OAuth App client ID
├── content/content.js   Adds the button to the merge box
├── options/             Settings page (sign-in, preferences)
├── lib/
│   ├── coauthors.js     Collects participants and writes the trailers (pure functions)
│   ├── device-flow.js   GitHub OAuth device flow
│   ├── github.js        REST/GraphQL client with pagination and rate-limit errors
│   └── settings.js      chrome.storage helpers
└── icons/               icon.svg and the PNG sizes rendered from it
```

Run the unit tests (Node.js 20 or newer, no dependencies):

```sh
npm test
```

After changing files, click the reload button on the extension's card in `chrome://extensions`, then reload
the GitHub tab.

## Credits

Inspired by [Better GitHub Co-Authors](https://github.com/delucis/better-github-coauthors) by Chris Swithinbank.
