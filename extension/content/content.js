// Adds an "Add co-authors" button to the commit form of GitHub's pull request merge box.
// All GitHub API work happens in the service worker; this script only touches the page.

(() => {
	const UI_ATTRIBUTE = 'data-gh-coauthors-generator';
	const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
	const FORM_CONTROL = '[data-component="FormControl"]';
	const DESCRIPTION_LABEL = /extended description|commit (?:body|description)/i;
	const TITLE_LABEL = /commit (?:message|header|title)/i;
	// "Confirm merge", "Confirm squash and merge", "Confirm auto-merge", …
	const CONFIRM_BUTTON_TEXT = /^\s*confirm\b/i;
	const SUCCESS_MESSAGE_MS = 10_000;

	let scanScheduled = false;
	new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
	scheduleScan();

	function scheduleScan() {
		if (scanScheduled) return;
		scanScheduled = true;
		requestAnimationFrame(() => {
			scanScheduled = false;
			scan();
		});
	}

	function scan() {
		if (!PR_PATH.test(location.pathname)) return;
		for (const field of findMergeMessageFields(document)) {
			if (field.container.querySelector(`:scope > [${UI_ATTRIBUTE}]`)) continue;
			field.anchor.insertAdjacentElement(field.position, createUI(field));
		}
	}

	/**
	 * Finds the commit description fields of merge forms below `root`.
	 * @returns {{ textarea: HTMLTextAreaElement, container: Element, anchor: Element, position: InsertPosition }[]}
	 */
	function findMergeMessageFields(root) {
		const fields = [];
		for (const textarea of root.querySelectorAll('textarea')) {
			const field = describeMergeField(textarea) ?? describeLegacyMergeField(textarea);
			if (field) fields.push(field);
		}
		return fields;
	}

	/** React merge box: a "Commit message" input followed by an "Extended description" textarea. */
	function describeMergeField(textarea) {
		const control = textarea.closest(FORM_CONTROL);
		if (!control?.parentElement) return null;
		const titleControl = previousFormControl(control);
		const hasTitleInput = Boolean(titleControl?.querySelector('input[type="text"], input:not([type])'));
		const looksLikeCommitForm =
			DESCRIPTION_LABEL.test(labelText(control)) || (hasTitleInput && TITLE_LABEL.test(labelText(titleControl)));
		if (!looksLikeCommitForm || !isInsideMergeForm(control)) return null;
		return {
			textarea,
			container: control.parentElement,
			anchor: hasTitleInput ? titleControl : control,
			position: hasTitleInput ? 'afterend' : 'beforebegin',
		};
	}

	/** Pre-React merge box. */
	function describeLegacyMergeField(textarea) {
		if (textarea.id !== 'merge_message_field') return null;
		const titleInput = textarea.form?.querySelector('input[name="commit_title"]');
		if (!titleInput?.parentElement) return null;
		return { textarea, container: titleInput.parentElement, anchor: titleInput, position: 'afterend' };
	}

	function previousFormControl(element) {
		for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
			if (sibling.matches(FORM_CONTROL)) return sibling;
		}
		return null;
	}

	function labelText(control) {
		return control?.querySelector('label')?.textContent ?? '';
	}

	/**
	 * Whether the form's own action buttons (the nearest ones around the field) include "Confirm …".
	 * Other commit forms on the page, such as "Commit suggestion", use different buttons.
	 */
	function isInsideMergeForm(control) {
		for (let ancestor = control.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
			const actions = [...ancestor.querySelectorAll('button')].filter(
				(button) => !control.contains(button) && !button.closest(`[${UI_ATTRIBUTE}]`),
			);
			if (actions.length > 0) return actions.some((button) => CONFIRM_BUTTON_TEXT.test(button.textContent));
		}
		return false;
	}

	function createUI(field) {
		const wrapper = document.createElement('div');
		wrapper.setAttribute(UI_ATTRIBUTE, '');
		wrapper.className = 'd-flex flex-items-center flex-wrap gap-2 mt-3';

		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'Button Button--secondary Button--small';
		button.textContent = 'Add co-authors';

		const status = document.createElement('div');
		status.setAttribute('aria-live', 'polite');
		status.className = 'f6';

		let textarea = field.textarea;
		button.addEventListener('click', async () => {
			if (!textarea.isConnected) {
				textarea = findMergeMessageFields(wrapper.parentElement ?? document)[0]?.textarea ?? textarea;
			}
			button.disabled = true;
			try {
				await addCoAuthors(textarea, wrapper, status);
			} finally {
				button.disabled = false;
			}
		});

		wrapper.append(button, status);
		return wrapper;
	}

	async function addCoAuthors(textarea, wrapper, status) {
		const match = location.pathname.match(PR_PATH);
		if (!match) return;
		const [, owner, repo, number] = match;
		showStatus(status, { text: 'Loading pull request participants…', tone: 'muted' });

		try {
			const result = await sendMessage({ type: 'coauthors:fetch', owner, repo, number: Number(number) });
			// Read the message only now, in case it was edited while participants were loading.
			const currentMessage = textarea.value;
			const { message, added, skipped } = await sendMessage({
				type: 'coauthors:compose',
				message: currentMessage,
				participants: result.participants,
				excludeEmails: findCommitAuthorEmails(wrapper.parentElement),
			});
			if (message !== currentMessage) setTextareaValue(textarea, message);
			showStatus(status, describeSuccess(added, skipped, result));
		} catch (error) {
			showStatus(status, describeError(error));
		}
	}

	async function sendMessage(message) {
		let response;
		try {
			response = await chrome.runtime.sendMessage(message);
		} catch (error) {
			if (/context invalidated/i.test(error?.message ?? '')) {
				throw { message: 'The extension was updated. Reload this page to use it.', code: 'reload' };
			}
			throw error;
		}
		if (!response?.ok) throw response?.error ?? { message: 'Something went wrong.' };
		return response;
	}

	/** Reads "This commit will be authored by someone@example.com." from the merge form. */
	function findCommitAuthorEmails(root) {
		if (!root) return [];
		const emails = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			// Skip the description itself: React mirrors a textarea's value into its text.
			if (!/authored by/i.test(node.data) || node.parentElement?.closest('textarea')) continue;
			const match = node.parentElement?.textContent.match(/authored by\s+([^\s<>()]+@[^\s<>()]*[A-Za-z0-9])/i);
			if (match) emails.push(match[1]);
		}
		return emails;
	}

	/** Updates the textarea so that React-controlled forms notice the new value. */
	function setTextareaValue(textarea, value) {
		const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
		setValue.call(textarea, value);
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		textarea.dispatchEvent(new Event('change', { bubbles: true }));
		textarea.scrollTop = textarea.scrollHeight;
	}

	function describeSuccess(added, skipped, { participants, commitCount, authenticated, rateLimit }) {
		let text;
		if (participants.length === 0) text = 'No participants to credit.';
		else if (added === 0) text = 'Everyone is already credited.';
		else text = `Added ${added} co-author${added === 1 ? '' : 's'}.`;
		if (added > 0 && skipped > 0) text += ` ${skipped} already credited.`;

		const incomplete = commitCount && commitCount.checked < commitCount.total;
		if (incomplete) {
			text += ` Only ${commitCount.checked} of ${commitCount.total} commits could be read; check the rest by hand.`;
			if (commitCount.incompleteReason === 'contents_access') {
				text += ' To read them all, a fine-grained token also needs read access to “Contents”.';
			}
		}
		const tone = incomplete ? 'attention' : added > 0 ? 'success' : 'muted';

		if (authenticated) {
			const remaining = rateLimit ? ` ${rateLimit.remaining.toLocaleString()} API requests left.` : '';
			return { text: text + remaining, tone, autoHide: !incomplete };
		}
		const remaining = rateLimit ? ` (${rateLimit.remaining} left this hour)` : '';
		return { text: `${text} Used anonymous API requests${remaining}.`, tone, link: 'Sign in to raise the limit' };
	}

	function describeError(error) {
		if (error?.code === 'rate_limited') {
			const resetAt = error.resetAt ? ` It resets at ${new Date(error.resetAt).toLocaleTimeString()}.` : '';
			return {
				text: `GitHub API rate limit reached.${resetAt}`,
				tone: 'danger',
				link: error.authenticated ? null : 'Sign in to raise the limit',
			};
		}
		const fixableInSettings = ['unauthorized', 'not_found', 'sso_required', 'forbidden'].includes(error?.code);
		return {
			text: error?.message || 'Something went wrong.',
			tone: 'danger',
			link: fixableInSettings ? 'Open settings' : null,
		};
	}

	/**
	 * @param {HTMLElement} status
	 * @param {{ text: string, tone?: 'muted' | 'success' | 'attention' | 'danger', link?: string | null, autoHide?: boolean }} details
	 */
	function showStatus(status, { text, tone = 'muted', link = null, autoHide = false }) {
		clearTimeout(Number(status.dataset.hideTimer));
		status.className = `f6 color-fg-${tone}`;
		status.replaceChildren(text);
		if (link) {
			const anchor = document.createElement('a');
			anchor.href = '#';
			anchor.className = 'Link--inTextBlock ml-1';
			anchor.textContent = link;
			anchor.addEventListener('click', (event) => {
				event.preventDefault();
				sendMessage({ type: 'options:open' }).catch(() => {});
			});
			status.append(anchor);
		}
		if (autoHide) {
			status.dataset.hideTimer = String(setTimeout(() => status.replaceChildren(), SUCCESS_MESSAGE_MS));
		}
	}
})();
