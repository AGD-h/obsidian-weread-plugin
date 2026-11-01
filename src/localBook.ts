import {
	App,
	editorInfoField,
	MarkdownPostProcessorContext,
	MarkdownView,
	TFile,
	WorkspaceLeaf
} from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { get } from 'svelte/store';
import { settingsStore } from './settings';

/**
 * 本地原文：把微信读书的划线对到 Epub Importer 导入的原文笔记上。
 * - 点笔记里的划线 → 打开本地原文并定位到那一句（没有本地原文时返回 null，由调用方打开微信读书）
 * - 打开原文时，按样式标出划过的句子，有想法的句子悬停显示想法（只在显示时标，不改原文文件）
 */

export interface LocalHighlight {
	text: string;
	label?: string; // 观点 / 金句 / 疑问
	review?: string;
}

interface NormalizedText {
	norm: string;
	map: number[]; // norm 下标 → 原文下标
}

const STYLE_CLASS: Record<string, string> = {
	观点: 'wr-local-hl-view',
	金句: 'wr-local-hl-quote',
	疑问: 'wr-local-hl-question'
};

const MIN_MATCH = 4;

/**
 * 只保留文字和数字（汉字、字母、数字，全角转半角，字母转小写），标点、空白、Markdown 符号、表情都去掉。
 * 微信读书版本和电子书版本常有标点、引号、个别字的差别，所以后面用模糊匹配。
 */
const keepChar = (ch: string): string => {
	const c = ch.charCodeAt(0);
	if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) return ch;
	if (c >= 0x30 && c <= 0x39) return ch;
	if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return ch.toLowerCase();
	if ((c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a)) {
		return String.fromCharCode(c - 0xfee0).toLowerCase();
	}
	return '';
};

export const normalizeText = (text: string): NormalizedText => {
	let norm = '';
	const map: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = keepChar(text[i]);
		if (!ch) continue;
		norm += ch;
		map.push(i);
	}
	return { norm, map };
};

const normOnly = (text: string): string => normalizeText(text).norm;

const GRAM = 3;
const MIN_SCORE = 0.45;

export interface TextMatch {
	start: number; // 原文下标
	end: number;
	score: number; // 0~1，1 为完全一致
}

/** 在 content 里找 markText：先精确找，找不到再按三字片段投票做模糊匹配（容忍版本间的字词差异） */
export const findInText = (content: NormalizedText, markText: string): TextMatch | null => {
	const needle = normOnly(markText);
	if (needle.length < MIN_MATCH) return null;
	const toOriginal = (from: number, to: number, score: number): TextMatch => ({
		start: content.map[from],
		end: content.map[to - 1] + 1,
		score
	});
	const exact = content.norm.indexOf(needle);
	if (exact >= 0) return toOriginal(exact, exact + needle.length, 1);
	if (needle.length < 8) return null;

	// 收集所有三字片段在原文中的命中位置，用一个比划线略长的滑动窗口找命中片段最多的一段
	const hay = content.norm;
	const grams = needle.length - GRAM + 1;
	const hits: { p: number; i: number }[] = [];
	for (let i = 0; i < grams; i++) {
		const g = needle.substr(i, GRAM);
		let p = hay.indexOf(g);
		while (p >= 0) {
			hits.push({ p, i });
			p = hay.indexOf(g, p + 1);
		}
	}
	if (hits.length === 0) return null;
	hits.sort((x, y) => x.p - y.p);
	const width = Math.ceil(needle.length * 1.5);
	const counts = new Map<number, number>();
	let distinct = 0;
	let bestDistinct = 0;
	let bestFrom = 0;
	let bestTo = 0;
	let left = 0;
	for (let right = 0; right < hits.length; right++) {
		const ri = hits[right].i;
		counts.set(ri, (counts.get(ri) ?? 0) + 1);
		if (counts.get(ri) === 1) distinct++;
		while (hits[right].p - hits[left].p > width) {
			const li = hits[left].i;
			counts.set(li, (counts.get(li) ?? 0) - 1);
			if (counts.get(li) === 0) distinct--;
			left++;
		}
		if (distinct > bestDistinct) {
			bestDistinct = distinct;
			bestFrom = hits[left].p;
			bestTo = hits[right].p + GRAM;
		}
	}
	const score = bestDistinct / grams;
	const minScore = needle.length >= 20 ? 0.3 : MIN_SCORE;
	if (score < minScore) return null;
	return toOriginal(bestFrom, Math.min(hay.length, bestTo), score);
};

export default class LocalBookService {
	private app: App;
	private highlightCache = new Map<string, LocalHighlight[]>(); // 原文书文件夹路径 → 划线
	private textCache = new Map<string, { mtime: number; text: NormalizedText }>();
	private localLeaf: WorkspaceLeaf | null = null;

	constructor(app: App) {
		this.app = app;
	}

	clearCache() {
		this.highlightCache.clear();
	}

	private get root(): string {
		return (get(settingsStore).localBookFolder || '读书/原文').replace(/^\/+|\/+$/g, '');
	}

	isLocalBookFile(file: TFile | null): boolean {
		return !!file && file.extension === 'md' && file.path.startsWith(this.root + '/');
	}

	/** 原文根目录下与书名最接近的文件夹（按去掉空白标点后的公共前缀长度） */
	findBookFolder(title: string): string | null {
		// 直接从文件列表里取原文根目录下的第一级文件夹名，不依赖文件夹对象
		const prefix = this.root + '/';
		const names = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			const rest = f.path.slice(prefix.length);
			if (rest.includes('/')) names.add(rest.split('/')[0]);
		}
		const target = normOnly(title);
		let best: string | null = null;
		let bestScore = 0;
		names.forEach((name) => {
			if (name.startsWith('_')) return;
			const score = commonPrefix(normOnly(name), target);
			if (score > bestScore) {
				best = name;
				bestScore = score;
			}
		});
		return best && bestScore >= MIN_MATCH ? prefix + best : null;
	}

	/** 原文文件所在的书文件夹（原文根目录下的第一级） */
	private bookFolderOf(file: TFile): string | null {
		const rest = file.path.slice(this.root.length + 1);
		const first = rest.split('/')[0];
		return rest.includes('/') ? `${this.root}/${first}` : null;
	}

	private async readNormalized(file: TFile): Promise<NormalizedText> {
		const cached = this.textCache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) return cached.text;
		const text = normalizeText(await this.app.vault.cachedRead(file));
		this.textCache.set(file.path, { mtime: file.stat.mtime, text });
		return text;
	}

	/** 点划线：在本地原文里找到最像的那一句并打开；找不到返回 false */
	async openHighlight(
		bookTitle: string,
		markText: string
	): Promise<'ok' | 'no-folder' | 'no-match'> {
		const folder = this.findBookFolder(bookTitle);
		if (!folder) return 'no-folder';
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(folder + '/'))
			.sort((x, y) => x.path.localeCompare(y.path, 'zh'));
		let best: { file: TFile; match: TextMatch } | null = null;
		for (const file of files) {
			const match = findInText(await this.readNormalized(file), markText);
			if (match && (!best || match.score > best.match.score)) best = { file, match };
			if (best?.match.score === 1) break;
		}
		if (!best) return 'no-match';
		await this.openAt(best.file, best.match.start, best.match.end);
		return 'ok';
	}

	private async openAt(file: TFile, start: number, end: number) {
		const { workspace } = this.app;
		const leafAlive =
			this.localLeaf && workspace.getLeavesOfType('markdown').includes(this.localLeaf);
		if (!leafAlive) {
			this.localLeaf = workspace.getLeaf('split', 'vertical');
		}
		const leaf = this.localLeaf as WorkspaceLeaf;
		const text = await this.app.vault.cachedRead(file);
		const line = text.slice(0, start).split('\n').length - 1;
		await leaf.openFile(file, { active: true, eState: { line } });
		const view = leaf.view;
		if (view instanceof MarkdownView && view.getMode() === 'source') {
			const editor = view.editor;
			const from = editor.offsetToPos(start);
			const to = editor.offsetToPos(end);
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
		}
	}

	/** 这本原文对应的划线：从同步下来的书籍笔记里读 */
	async highlightsFor(file: TFile): Promise<LocalHighlight[]> {
		const folderPath = this.bookFolderOf(file);
		if (!folderPath) return [];
		const cached = this.highlightCache.get(folderPath);
		if (cached) return cached;
		const folderName = folderPath.slice(this.root.length + 1);
		const note = this.findSyncedNote(folderName);
		const list = note ? parseHighlightsFromNote(await this.app.vault.cachedRead(note)) : [];
		this.highlightCache.set(folderPath, list);
		return list;
	}

	private findSyncedNote(folderName: string): TFile | null {
		const target = normOnly(folderName);
		let best: TFile | null = null;
		let bestScore = 0;
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (!fm || !fm.bookId || !fm.title) continue;
			const score = commonPrefix(normOnly(String(fm.title)), target);
			if (score > bestScore) {
				best = f;
				bestScore = score;
			}
		}
		return bestScore >= MIN_MATCH ? best : null;
	}

	/** 阅读模式：给段落里划过的句子加标记 */
	postProcessor() {
		return async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile) || !this.isLocalBookFile(file)) return;
			const highlights = await this.highlightsFor(file);
			if (highlights.length === 0) return;
			el.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6, td').forEach((block) => {
				for (const h of highlights) markInElement(block as HTMLElement, h);
			});
		};
	}

	/** 编辑/实时预览模式：用 CodeMirror 装饰标记 */
	editorExtension() {
		const service = this;
		return ViewPlugin.fromClass(
			class {
				decorations: DecorationSet = Decoration.none;
				private version = 0;
				constructor(private view: EditorView) {
					this.refresh();
				}
				update(update: ViewUpdate) {
					if (update.docChanged) this.refresh();
				}
				private async refresh() {
					const version = ++this.version;
					const file = this.view.state.field(editorInfoField, false)?.file ?? null;
					if (!file || !service.isLocalBookFile(file)) {
						this.decorations = Decoration.none;
						return;
					}
					const highlights = await service.highlightsFor(file);
					if (version !== this.version) return;
					const docText = this.view.state.doc.toString();
					const content = normalizeText(docText);
					const ranges: { from: number; to: number; h: LocalHighlight }[] = [];
					for (const h of highlights) {
						const pos = findInText(content, h.text);
						if (pos) ranges.push({ from: pos.start, to: pos.end, h });
					}
					ranges.sort((a, b) => a.from - b.from);
					const builder = new RangeSetBuilder<Decoration>();
					let last = -1;
					for (const r of ranges) {
						if (r.from < last) continue;
						builder.add(
							r.from,
							r.to,
							Decoration.mark({
								class: highlightClass(r.h),
								attributes: r.h.review ? { title: `💭 ${r.h.review}` } : {}
							})
						);
						last = r.to;
					}
					this.decorations = builder.finish();
					this.view.dispatch({}); // 触发重绘
				}
			},
			{ decorations: (v) => v.decorations }
		);
	}
}

const highlightClass = (h: LocalHighlight): string =>
	`wr-local-hl ${(h.label && STYLE_CLASS[h.label]) || ''}${h.review ? ' wr-local-hl-review' : ''}`;

const commonPrefix = (a: string, b: string): number => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
};

/** 解析同步笔记里的划线：📌 行是划线，后面的 🏷 行是样式，💭 行是想法 */
export const parseHighlightsFromNote = (markdown: string): LocalHighlight[] => {
	const result = new Map<string, LocalHighlight>();
	let current: LocalHighlight | null = null;
	for (const raw of markdown.split('\n')) {
		const line = raw.replace(/^\s*>\s?/, '').trim();
		const mark = line.match(/^📌(?:🔥)?\s*(.*)$/);
		if (mark) {
			let text = mark[1];
			const link = text.match(/^\[(.*)\]\(<?[^)]*>?\)/);
			if (link) text = link[1];
			text = text.replace(/\s*\^[\w-]+\s*$/, '').trim();
			const key = normOnly(text);
			if (key.length < MIN_MATCH) {
				current = null;
				continue;
			}
			current = result.get(key) ?? { text };
			result.set(key, current);
			continue;
		}
		if (!current) continue;
		if (/^🗑/.test(line)) {
			// 微信读书里已删除的划线，不在原文上标
			result.delete(normOnly(current.text));
			current = null;
			continue;
		}
		const label = line.match(/^🏷\uFE0F?\s*(.+)$/);
		if (label) {
			current.label = label[1].trim();
			continue;
		}
		const review = line.match(/^💭\s*(.+)$/);
		if (review) {
			current.review = review[1].trim();
			continue;
		}
		if (line === '' || line.startsWith('#')) current = null;
	}
	return Array.from(result.values());
};

/** 在一个块元素里把匹配的文字包进 <mark>（可跨越粗体等内联元素） */
const markInElement = (block: HTMLElement, h: LocalHighlight) => {
	const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	let full = '';
	const starts: number[] = [];
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		if (node.parentElement?.closest('mark.wr-local-hl')) continue;
		nodes.push(node);
		starts.push(full.length);
		full += node.data;
	}
	if (nodes.length === 0) return;
	const pos = findInText(normalizeText(full), h.text);
	if (!pos) return;
	// 逐个文本节点切出要标记的部分
	for (let i = nodes.length - 1; i >= 0; i--) {
		const nodeStart = starts[i];
		const nodeEnd = nodeStart + nodes[i].data.length;
		const from = Math.max(pos.start, nodeStart);
		const to = Math.min(pos.end, nodeEnd);
		if (from >= to) continue;
		let node = nodes[i];
		if (to - nodeStart < node.data.length) node.splitText(to - nodeStart);
		if (from - nodeStart > 0) node = node.splitText(from - nodeStart);
		const markEl = document.createElement('mark');
		markEl.className = highlightClass(h);
		if (h.review) markEl.title = `💭 ${h.review}`;
		node.parentNode?.insertBefore(markEl, node);
		markEl.appendChild(node);
	}
};
