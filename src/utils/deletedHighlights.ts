/**
 * 微信读书里删掉的划线不直接从笔记里消失：同步时把旧笔记里有、新内容里没有的自己的划线（📌 开头的引用块）
 * 留下来，加一行“🗑 已删除”，放回原来的章节下面。
 */

export const DELETED_MARK = '> 🗑 已删除';

const HIGHLIGHT_SECTION = '# 高亮划线';

interface OldBlock {
	heading: string | null; // 所在章节标题行，如 "### 2.2 PSF..."
	lines: string[];
	id: string;
}

const blockIdOf = (lines: string[]): string | null => {
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i].match(/\^([\w-]+)\s*$/);
		if (m) return m[1];
	}
	return null;
};

/** 取出“高亮划线”这一节的起止行号（不含下一个一级标题） */
const sectionRange = (lines: string[]): [number, number] | null => {
	const start = lines.findIndex((l) => l.trim() === HIGHLIGHT_SECTION);
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^# /.test(lines[i])) {
			end = i;
			break;
		}
	}
	return [start, end];
};

const parseOldBlocks = (content: string): OldBlock[] => {
	const lines = content.split('\n');
	const range = sectionRange(lines);
	if (!range) return [];
	const blocks: OldBlock[] = [];
	let heading: string | null = null;
	let current: string[] = [];
	const flush = () => {
		if (current.length > 0 && /^>\s*📌/.test(current[0])) {
			const id = blockIdOf(current);
			if (id) blocks.push({ heading, lines: current, id });
		}
		current = [];
	};
	for (let i = range[0] + 1; i < range[1]; i++) {
		const line = lines[i];
		if (/^#{2,6} /.test(line)) {
			flush();
			heading = line.trim();
		} else if (line.startsWith('>')) {
			if (/^>\s*📌/.test(line)) flush();
			current.push(line);
		} else {
			flush();
		}
	}
	flush();
	return blocks;
};

export const keepDeletedHighlights = (oldContent: string, freshContent: string): string => {
	const oldBlocks = parseOldBlocks(oldContent);
	if (oldBlocks.length === 0) return freshContent;
	const presentIds = new Set(Array.from(freshContent.matchAll(/\^([\w-]+)/g), (m) => m[1]));
	const deleted = oldBlocks.filter((b) => !presentIds.has(b.id));
	if (deleted.length === 0) return freshContent;

	const lines = freshContent.split('\n');
	const range = sectionRange(lines);
	if (!range) return freshContent;

	const markBlock = (b: OldBlock): string[] => {
		if (b.lines.some((l) => l.trim() === DELETED_MARK)) return b.lines;
		return [b.lines[0], DELETED_MARK, ...b.lines.slice(1)];
	};

	// 按章节分组，找到新内容里同名章节的末尾插入；找不到章节就在本节末尾补上章节标题
	const byHeading = new Map<string, OldBlock[]>();
	for (const b of deleted) {
		const key = b.heading ?? '';
		byHeading.set(key, [...(byHeading.get(key) ?? []), b]);
	}

	const inserts: { at: number; text: string[] }[] = [];
	const appendAtEnd: string[] = [];
	byHeading.forEach((blocks, heading) => {
		const body = blocks.flatMap((b) => ['', ...markBlock(b), '']);
		const headingIdx = heading
			? lines.findIndex((l, i) => i > range[0] && i < range[1] && l.trim() === heading)
			: -1;
		if (headingIdx >= 0) {
			let end = range[1];
			for (let i = headingIdx + 1; i < range[1]; i++) {
				if (/^#{2,6} /.test(lines[i])) {
					end = i;
					break;
				}
			}
			inserts.push({ at: end, text: body });
		} else {
			appendAtEnd.push(...(heading ? [heading] : []), ...body);
		}
	});
	if (appendAtEnd.length > 0) inserts.push({ at: range[1], text: appendAtEnd });

	inserts.sort((a, b) => b.at - a.at);
	for (const ins of inserts) lines.splice(ins.at, 0, ...ins.text);
	return lines.join('\n');
};
