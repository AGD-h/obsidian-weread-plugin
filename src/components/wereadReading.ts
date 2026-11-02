import { WorkspaceLeaf, ItemView } from 'obsidian';
import { get } from 'svelte/store';
import WereadPlugin from '../../main';
import { settingsStore } from '../settings';

const CLEAN_READER_CSS = `
.readerTopBar, .readerControls { opacity: 0; transition: opacity .2s ease; }
.readerTopBar:hover, .readerControls:hover { opacity: 1; }
`;

export const WEREAD_BROWSER_VIEW_ID = 'weread-reading-view';
export const WEREAD_BOOK_OPENED_EVENT = 'weread:book-opened';
const WEREAD_HOME_URL = 'https://weread.qq.com/web/shelf';
const WEREAD_PARTITION = 'persist:weread-plugin-browser';

type WereadViewState = {
	url?: string;
};

export class WereadReadingView extends ItemView {
	plugin: WereadPlugin;
	getViewType(): string {
		return WEREAD_BROWSER_VIEW_ID;
	}
	getDisplayText(): string {
		return '微信读书';
	}
	leaf: WorkspaceLeaf;
	private webviewEl: HTMLElement;
	private currentUrl = WEREAD_HOME_URL;
	private pendingUrl: string | null = null;
	private isBootstrapped = false;
	private lastBookHash = '';

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getIcon(): string {
		return 'book-open';
	}

	async onClose() {
		// Nothing to clean up.
	}

	async onOpen() {
		this.webviewEl = this.contentEl.doc.createElement('webview');
		this.webviewEl.setAttribute('partition', WEREAD_PARTITION);
		this.webviewEl.setAttribute('allowpopups', '');
		this.webviewEl.addClass('weread-frame');
		this.webviewEl.addEventListener('did-finish-load', () => {
			if (!this.isBootstrapped) {
				this.isBootstrapped = true;
				if (this.pendingUrl) {
					const nextUrl = this.pendingUrl;
					this.pendingUrl = null;
					this.webviewEl.setAttribute('src', nextUrl);
				}
			}
		});

		if (this.currentUrl === WEREAD_HOME_URL) {
			this.webviewEl.setAttribute('src', WEREAD_HOME_URL);
		} else {
			this.pendingUrl = this.currentUrl;
			this.webviewEl.setAttribute('src', WEREAD_HOME_URL);
		}

		// 简洁阅读：阅读页的顶栏和右侧工具栏平时隐藏，鼠标移上去再出现（功能都保留）
		this.webviewEl.addEventListener('dom-ready', () => {
			if (!get(settingsStore).cleanReader) return;
			(this.webviewEl as HTMLElement & { insertCSS: (css: string) => Promise<string> })
				.insertCSS(CLEAN_READER_CSS)
				.catch((e) => console.warn('[weread plugin] 注入简洁样式失败', e));
		});

		// 打开某本书时通知插件（用来自动在旁边打开这本书的笔记）
		const onNavigate = (event: Event) => {
			const url = (event as Event & { url?: string }).url ?? '';
			const m = url.match(/\/web\/reader\/([^/?#k]+)/);
			if (m && m[1] !== this.lastBookHash) {
				this.lastBookHash = m[1];
				this.app.workspace.trigger(WEREAD_BOOK_OPENED_EVENT, m[1], this.leaf);
			}
		};
		this.webviewEl.addEventListener('did-navigate', onNavigate);
		this.webviewEl.addEventListener('did-navigate-in-page', onNavigate);

		this.contentEl.appendChild(this.webviewEl);
		this.contentEl.addClass('weread-view-content');
	}

	getState(): WereadViewState {
		return {
			url: this.currentUrl
		};
	}

	async setState(state: WereadViewState): Promise<void> {
		this.currentUrl = state?.url || WEREAD_HOME_URL;
		if (!this.webviewEl) {
			return;
		}

		if (!this.isBootstrapped && this.currentUrl !== WEREAD_HOME_URL) {
			this.pendingUrl = this.currentUrl;
			this.webviewEl.setAttribute('src', WEREAD_HOME_URL);
			return;
		}

		this.pendingUrl = null;
		this.webviewEl.setAttribute('src', this.currentUrl);
	}

	navigate(url: string = WEREAD_HOME_URL) {
		this.currentUrl = url;
		if (!this.webviewEl) {
			return;
		}

		if (!this.isBootstrapped && url !== WEREAD_HOME_URL) {
			this.pendingUrl = url;
			this.webviewEl.setAttribute('src', WEREAD_HOME_URL);
			return;
		}

		this.pendingUrl = null;
		this.webviewEl.setAttribute('src', url);
	}
}
