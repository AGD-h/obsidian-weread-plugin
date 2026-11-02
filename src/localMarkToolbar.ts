import { App, MarkdownView, Modal, Notice, setIcon, TFile } from 'obsidian';
import type LocalBookService from './localBook';
import type { LocalMarkStyle } from './localBook';
import type { EditorView } from '@codemirror/view';

/**
 * 本地原文的划线工具条：在原文里选中文字（或点一条自己画的划线）时，在文字上方弹出，
 * 和微信读书一样：复制 / 马克笔 / 波浪线 / 直线 / 写想法 / AI问书，下面一排选颜色。
 */

const COLORS = [1, 2, 3, 4, 5];
const COLOR_KEY = 'weread-local-mark-color';

interface Target {
	file: TFile;
	text: string;
	rect: DOMRect;
	/** 点到的是自己画的划线 */
	markId?: string;
}

interface ReadingAssistant {
	quoteText?: (text: string, file: TFile | null) => Promise<void>;
}

export default class LocalMarkToolbar {
	private el: HTMLElement | null = null;
	private target: Target | null = null;

	constructor(private app: App, private service: LocalBookService) {}

	private get color(): number {
		try {
			const v = Number(window.localStorage.getItem(COLOR_KEY));
			return COLORS.includes(v) ? v : 1;
		} catch {
			return 1;
		}
	}

	private set color(v: number) {
		try {
			window.localStorage.setItem(COLOR_KEY, String(v));
		} catch {
			// 存不了就只在这次生效
		}
	}

	/** 鼠标松开：有选中文字或点到本地划线就弹出工具条 */
	onMouseUp(event: MouseEvent) {
		if (this.el?.contains(event.target as Node)) return;
		window.setTimeout(() => this.update(event), 10);
	}

	onMouseDown(event: MouseEvent) {
		if (this.el && !this.el.contains(event.target as Node)) this.hide();
	}

	private update(event: MouseEvent) {
		const view = this.viewOf(event.target as Node);
		if (!view?.file || !this.service.isLocalBookFile(view.file)) {
			this.hide();
			return;
		}
		const sel = this.selectionIn(view);
		if (sel) {
			this.show({ file: view.file, ...sel });
			return;
		}
		const mark = (event.target as HTMLElement).closest?.('[data-wr-id]') as HTMLElement | null;
		if (mark) {
			this.show({
				file: view.file,
				text: mark.textContent ?? '',
				rect: mark.getBoundingClientRect(),
				markId: mark.getAttribute('data-wr-id') ?? undefined
			});
			return;
		}
		this.hide();
	}

	/** 选中的文字和位置：编辑模式从编辑器取（它自己画选区），阅读模式从页面选区取 */
	private selectionIn(view: MarkdownView): { text: string; rect: DOMRect } | null {
		if (view.getMode() === 'source') {
			const text = view.editor.getSelection();
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (!text.trim() || !cm) return null;
			const { from, to } = cm.state.selection.main;
			const a = cm.coordsAtPos(from);
			const b = cm.coordsAtPos(to, -1);
			if (!a || !b) return null;
			const top = Math.min(a.top, b.top);
			const bottom = Math.max(a.bottom, b.bottom);
			const left = a.top === b.top ? a.left : cm.contentDOM.getBoundingClientRect().left;
			const right = a.top === b.top ? b.right : cm.contentDOM.getBoundingClientRect().right;
			return { text, rect: new DOMRect(left, top, right - left, bottom - top) };
		}
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !view.containerEl.contains(sel.anchorNode)) return null;
		const text = sel.toString();
		if (!text.trim()) return null;
		return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
	}

	private viewOf(node: Node | null): MarkdownView | null {
		if (!node) return null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(node)) return view;
		}
		return null;
	}

	hide() {
		this.el?.remove();
		this.el = null;
		this.target = null;
	}

	private show(target: Target) {
		this.hide();
		this.target = target;
		const bar = document.body.createDiv({ cls: 'wr-mark-toolbar' });
		this.el = bar;
		const row = bar.createDiv({ cls: 'wr-mark-toolbar-row' });
		const button = (icon: string, label: string, onClick: () => void, cls = '') => {
			const b = row.createDiv({ cls: `wr-mark-btn ${cls}` });
			setIcon(b.createDiv({ cls: 'wr-mark-btn-icon' }), icon);
			b.createDiv({ cls: 'wr-mark-btn-label', text: label });
			b.addEventListener('mousedown', (e) => e.preventDefault()); // 不丢掉选区
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				onClick();
			});
		};
		button('copy', '复制', () => this.copy());
		button('highlighter', '马克笔', () => this.mark('金句'));
		button('waves', '波浪线', () => this.mark('疑问'));
		button('underline', '直线', () => this.mark('观点'));
		button('message-circle', '写想法', () => this.writeThought());
		button('search', 'AI问书', () => this.askAI());
		if (target.markId) button('trash-2', '删除划线', () => this.remove(), 'mod-warning');

		const colors = bar.createDiv({ cls: 'wr-mark-colors' });
		for (const c of COLORS) {
			const dot = colors.createDiv({ cls: `wr-mark-color wr-local-c${c}` });
			if (c === this.color) dot.addClass('is-active');
			dot.addEventListener('mousedown', (e) => e.preventDefault());
			dot.addEventListener('click', (e) => {
				e.stopPropagation();
				this.color = c;
				colors.querySelectorAll('.wr-mark-color').forEach((d) => d.removeClass('is-active'));
				dot.addClass('is-active');
				if (this.target?.markId) {
					void this.service.updateMark(this.target.file, this.target.markId, { color: c });
				}
			});
		}

		// 放在文字上方居中，放不下就放到下方
		const { rect } = target;
		const w = bar.offsetWidth;
		const h = bar.offsetHeight;
		const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
		const top = rect.top - h - 10 > 8 ? rect.top - h - 10 : rect.bottom + 10;
		bar.style.left = `${left}px`;
		bar.style.top = `${top}px`;
	}

	private copy() {
		if (!this.target) return;
		void navigator.clipboard.writeText(this.target.text);
		new Notice('已复制');
		this.hide();
	}

	private async mark(style: LocalMarkStyle) {
		const t = this.target;
		if (!t) return;
		this.hide();
		if (t.markId) {
			await this.service.updateMark(t.file, t.markId, { label: style, color: this.color });
		} else {
			const id = await this.service.addMark(t.file, t.text, style, this.color);
			if (!id) new Notice('无法确定这段原文属于哪本书');
		}
		window.getSelection()?.removeAllRanges();
	}

	private writeThought() {
		const t = this.target;
		if (!t) return;
		this.hide();
		new ThoughtModal(this.app, t.text, async (review) => {
			if (t.markId) await this.service.updateMark(t.file, t.markId, { review });
			else await this.service.addMark(t.file, t.text, '想法', this.color, review);
			window.getSelection()?.removeAllRanges();
		}).open();
	}

	private askAI() {
		const t = this.target;
		if (!t) return;
		this.hide();
		const plugins = (this.app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins
			.plugins;
		const assistant = plugins['reading-assistant'] as ReadingAssistant | undefined;
		if (!assistant?.quoteText) {
			new Notice('没有找到读书助手插件，请先启用它');
			return;
		}
		void assistant.quoteText(t.text, t.file);
	}

	private async remove() {
		const t = this.target;
		if (!t?.markId) return;
		this.hide();
		await this.service.updateMark(t.file, t.markId, null);
	}
}

class ThoughtModal extends Modal {
	constructor(app: App, private quote: string, private onSubmit: (text: string) => Promise<void>) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText('写想法');
		const { contentEl } = this;
		contentEl.createEl('blockquote', { cls: 'wr-thought-quote', text: this.quote });
		const input = contentEl.createEl('textarea', { cls: 'wr-thought-input' });
		input.placeholder = '写下你的想法';
		input.rows = 5;
		const actions = contentEl.createDiv({ cls: 'wr-thought-actions' });
		const cancel = actions.createEl('button', { text: '取消' });
		const ok = actions.createEl('button', { text: '发表', cls: 'mod-cta' });
		cancel.onclick = () => this.close();
		const submit = async () => {
			const text = input.value.trim();
			if (!text) return;
			this.close();
			await this.onSubmit(text);
		};
		ok.onclick = submit;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
		});
		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
