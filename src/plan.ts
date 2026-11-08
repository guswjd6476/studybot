// 공부 계획 규칙: 꼭 해야 할 일정을 빼고 남는 시간에 과목과 공부 방법을 배치한다 (텔레그램과 분리해 테스트)

export interface Busy {
    start: number; // 자정부터 분
    end: number;
    label: string;
}

export interface Goal {
    subject: string;
    exam?: string; // 'YYYY-MM-DD' (시험·마감일, 없으면 꾸준히)
}

export interface Session {
    start: number;
    end: number;
    subject: string;
    method: string;
}

export const DAY_START = 8 * 60; // 하루 공부 가능 시간 08:00 ~ 23:00
export const DAY_END = 23 * 60;
const MIN_BLOCK = 30; // 이보다 짧은 빈 시간은 쉬는 시간으로 둔다
const STUDY = 50; // 50분 공부 + 10분 쉬기
const BREAK = 10;

export const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// '9-12 수업', '14:00~16:30 알바', '오후 2시부터 4시 병원' 같은 줄에서 일정을 읽는다
// 오전·오후를 안 쓴 1~6시는 오후로 본다 (새벽 일정은 드묾)
const RANGE =
    /(오전|오후)?\s*(\d{1,2})(?:[:시]\s*(\d{2})?\s*분?)?\s*(?:[-~]|부터)\s*(오전|오후)?\s*(\d{1,2})(?:[:시]\s*(\d{2})?\s*분?)?\s*(?:시|까지)*/;

export function parseSchedule(text: string): Busy[] {
    const busy: Busy[] = [];
    for (const line of text.normalize('NFKC').split('\n')) {
        const m = line.match(RANGE);
        if (!m) continue;
        const hour = (h: string, ampm: string | undefined) => {
            let v = Number(h);
            if (ampm === '오후' && v < 12) v += 12;
            else if (!ampm && v >= 1 && v <= 6) v += 12;
            return v;
        };
        const start = hour(m[2], m[1]) * 60 + Number(m[3] ?? 0);
        let end = hour(m[5], m[4] ?? m[1]) * 60 + Number(m[6] ?? 0);
        if (end <= start && end + 12 * 60 > start) end += 12 * 60; // '11-1' = 11시~13시
        if (end <= start || end > 24 * 60) continue;
        const label = line.replace(m[0], '').replace(/^[\s,:\-·•*]+|[\s,]+$/g, '') || '일정';
        busy.push({ start, end, label });
    }
    return busy.sort((a, b) => a.start - b.start);
}

// 일정 사이 빈 시간 (MIN_BLOCK분 이상만)
export function freeBlocks(busy: Busy[], dayStart = DAY_START, dayEnd = DAY_END): [number, number][] {
    const blocks: [number, number][] = [];
    let cursor = dayStart;
    for (const b of busy) {
        if (b.start - cursor >= MIN_BLOCK) blocks.push([cursor, Math.min(b.start, dayEnd)]);
        cursor = Math.max(cursor, b.end);
    }
    if (dayEnd - cursor >= MIN_BLOCK) blocks.push([cursor, dayEnd]);
    return blocks.filter(([s, e]) => e - s >= MIN_BLOCK);
}

export const daysLeft = (exam: string | undefined, today: string) =>
    exam ? Math.round((Date.parse(exam) - Date.parse(today)) / 86_400_000) : null;

// 시험이 가까운 과목을 더 자주: 7일 안 3번, 30일 안 2번, 그 밖 1번씩 돌아가며
function subjectQueue(goals: Goal[], today: string): Goal[] {
    const weight = (g: Goal) => {
        const d = daysLeft(g.exam, today);
        return d === null || d > 30 ? 1 : d >= 0 && d <= 7 ? 3 : d >= 0 ? 2 : 1;
    };
    const active = goals.filter((g) => (daysLeft(g.exam, today) ?? 0) >= 0); // 지난 시험은 뺀다
    const sorted = [...active].sort((a, b) => weight(b) - weight(a));
    const queue: Goal[] = [];
    for (let round = 0; round < 3; round++) for (const g of sorted) if (weight(g) > round) queue.push(g);
    return queue;
}

function methodFor(s: { start: number; end: number }, goal: Goal | undefined, isLast: boolean, today: string) {
    const d = daysLeft(goal?.exam, today);
    if (isLast) return '오늘 공부한 것을 책 덮고 백지에 떠올려 쓰기 (인출 복습)';
    if (d !== null && d <= 7) return '기출·모의고사 풀고 틀린 문제만 다시 정리';
    if (s.end - s.start < 40) return '짧게 복습: 암기 카드·요약 노트 다시 보기';
    if (s.start < 12 * 60) return '새 개념 공부 (집중이 잘 되는 시간)';
    return '문제 풀이 → 채점 → 오답 정리';
}

// 식사 시간: 일정과 겹치지 않으면 비워 둔다 (겹치면 그 일정 중에 먹는다고 본다)
const MEALS: Busy[] = [
    { start: 12 * 60, end: 13 * 60, label: '점심' },
    { start: 18 * 60, end: 19 * 60, label: '저녁' },
];

export function buildPlan(busy: Busy[], goals: Goal[], today: string): Session[] {
    const meals = MEALS.filter((m) => !busy.some((b) => b.start < m.end && m.start < b.end));
    const slots: { start: number; end: number }[] = [];
    for (const [s, e] of freeBlocks([...busy, ...meals].sort((a, b) => a.start - b.start))) {
        let t = s;
        while (e - t >= MIN_BLOCK) {
            const len = Math.min(STUDY, e - t);
            slots.push({ start: t, end: t + len });
            t += len + BREAK;
        }
    }
    const queue = subjectQueue(goals, today);
    return slots.map((slot, i) => {
        const goal = queue.length ? queue[i % queue.length] : undefined;
        return { ...slot, subject: goal?.subject ?? '공부', method: methodFor(slot, goal, i === slots.length - 1 && i > 0, today) };
    });
}

export function planText(busy: Busy[], goals: Goal[], today: string): string {
    const sessions = buildPlan(busy, goals, today);
    const minutes = sessions.reduce((n, s) => n + s.end - s.start, 0);
    const lines = [`📅 <b>오늘 공부 추천</b> (${today})`, ''];
    if (busy.length) {
        lines.push('📌 <b>꼭 할 일</b>');
        for (const b of busy) lines.push(`• ${fmt(b.start)}–${fmt(b.end)} ${escapeHtml(b.label)}`);
        lines.push('');
    }
    if (!sessions.length) {
        lines.push('오늘은 30분 이상 빈 시간이 없어요. 이동 중에 암기 카드만 10분 보기를 추천해요.');
        return lines.join('\n');
    }
    lines.push(`📚 <b>공부 ${Math.floor(minutes / 60)}시간 ${minutes % 60}분</b> (50분 공부 · 10분 쉬기, 식사 시간은 비워 둠)`);
    for (const s of sessions) lines.push(`• ${fmt(s.start)}–${fmt(s.end)} <b>${escapeHtml(s.subject)}</b> · ${s.method}`);
    const exams = goals
        .map((g) => ({ g, d: daysLeft(g.exam, today) }))
        .filter((x) => x.d !== null && x.d >= 0)
        .sort((a, b) => a.d! - b.d!);
    if (exams.length) lines.push('', '⏳ ' + exams.map(({ g, d }) => `${escapeHtml(g.subject)} D-${d}`).join(' · '));
    if (!goals.length) lines.push('', '💡 <code>/목표 수학 2026-12-10</code> 처럼 과목을 등록하면 과목별로 나눠 드려요.');
    return lines.join('\n');
}

export function escapeHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
