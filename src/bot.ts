// 공부 추천 텔레그램 봇: 오늘 꼭 해야 할 일정을 보내면 남는 시간에 공부 계획을 추천한다
// 실행: TELEGRAM_BOT_TOKEN=... npm start (롱 폴링이라 웹훅·공개 주소가 필요 없다)
import type { ServerResponse } from 'node:http';
import { Telegraf } from 'telegraf';
import {
    buildPlan,
    dayNames,
    daysLeft,
    dur,
    escapeHtml,
    fixedOn,
    fmt,
    keepTodos,
    mergeBusy,
    parseNums,
    parseDays,
    parseMinutes,
    parseSchedule,
    planText,
    streak,
    sumMin,
    totals,
    weekStart,
    type Done,
    type Fixed,
    type Goal,
    type Todo,
} from './plan.ts';
import { allChats, getChat, updateChat, type ChatData } from './store.ts';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN 환경 변수를 설정해주세요. (.env.example 참고)');
    process.exit(1);
}
const bot = new Telegraf(token);
const html = { parse_mode: 'HTML' as const };

// 단톡방에서도 사람별로 저장한다: 이름, 처음 쓴 방(아침 알림), 같이 쓰는 단톡방(/모두)을 기록
bot.use((ctx, next) => {
    const u = ctx.from, chat = ctx.chat;
    if (u && chat) {
        const c = getChat(u.id);
        const group = chat.type === 'private' ? null : chat.id;
        if (c.name !== u.first_name || !c.chat || (group && !c.groups?.includes(group)))
            updateChat(u.id, (x) => {
                x.name = u.first_name;
                x.chat ??= chat.id;
                if (group && !x.groups?.includes(group)) x.groups = [...(x.groups ?? []), group];
            });
    }
    return next();
});

// 단톡방에서는 누구 것인지 이름을 붙인다
const who = (ctx: any) => (ctx.chat.type === 'private' ? '' : `👤 <b>${escapeHtml(ctx.from.first_name)}</b>\n`);

// 한국 시간 오늘 날짜·시각 (min = 자정부터 분)
function nowKST() {
    const iso = new Date(Date.now() + 9 * 3_600_000).toISOString();
    const hm = iso.slice(11, 16);
    return { today: iso.slice(0, 10), hm, min: Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), year: Number(iso.slice(0, 4)) };
}
const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

// 오늘 목표 대비 공부한 시간 + 연속 공부일
function progress(c: ChatData, today: string) {
    const done = sumMin(c.log ?? [], today, today), goal = c.daily ?? DAILY;
    const s = streak(c.log ?? [], today);
    return `오늘 <b>${dur(done)}</b> / 목표 ${dur(goal)} (${Math.round((done / goal) * 100)}%)${s ? ` · 🔥 ${s}일 연속` : ''}`;
}

const HELP = [
    '📚 <b>공부 관리 봇</b>',
    '',
    '📅 <b>오늘 계획</b>',
    '꼭 해야 할 일정을 한 줄에 하나씩 보내면 남는 시간에 공부 계획을 짜 드려요.',
    '<code>9-12 수업',
    '14:00~16:00 알바</code>',
    '• 1~6시는 오후로 읽어요. 아침이면 <code>오전 6:30-11:30</code> 또는 <code>06:30-11:30</code>',
    '• 일정이 없으면 <code>없음</code> 또는 <code>/추천</code>',
    '• 내일 미리 짜기: <code>/내일</code> 다음 줄부터 내일 일정 (없으면 <code>/내일</code>만)',
    '• <code>/공부시간 4시간</code> 하루에 공부할 시간 (기본 4시간)',
    '',
    '🔁 <b>고정 일정</b> (알바·학원처럼 매주 같은 것)',
    '• <code>/고정 월수금 18-22 알바</code> 한 번 등록하면 그 요일 계획에 자동으로 빠져요',
    '  요일: <code>월수금</code> · <code>월-금</code> · <code>평일</code> · <code>주말</code> · <code>매일</code>',
    '• <code>/고정</code> 목록 보기 · <code>/고정삭제 1</code> 번호로 지우기',
    '',
    '🎯 <b>과목</b>',
    '• <code>/목표 수학 12/10</code> 과목 등록 (시험일은 없어도 돼요)',
    '• <code>/목표</code> 내 과목 보기 · <code>/목표삭제 수학</code>',
    '',
    '✏️ <b>공부 기록</b>',
    '• <code>/기록 수학 50분</code> 공부한 시간 남기기 (<code>1시간 30분</code>, <code>90</code>도 돼요)',
    '• <code>/시작 수학</code> 타이머 켜기 → <code>/끝</code> 하면 걸린 시간이 자동으로 기록돼요 (과목을 안 적으면 계획의 지금 과목)',
    '• <code>/기록취소</code> 오늘 마지막 기록 지우기',
    '• <code>/오늘</code> · <code>/이번주</code> 공부한 시간 (오늘은 목표 달성률·🔥 연속 공부일도)',
    '',
    '📝 <b>할 일</b>',
    '• <code>/할일 수학 문제집 3장</code> 추가 (여러 줄로 한꺼번에도 돼요) · <code>/할일</code> 목록',
    '• <code>/완료 1 3</code> 체크 (다시 하면 풀려요) · <code>/할일삭제 2</code>',
    '• 못 끝낸 건 다음 날로 넘어가고, 끝낸 건 다음 날 사라져요',
    '',
    '⏰ <b>알림</b>',
    '• <code>/알림 07:30</code> 매일 아침 일정 묻기 (기본 07:30) · <code>/알림 끄기</code>',
    '• 오늘 계획을 짜면 공부 칸이 시작할 때마다 알려 드려요 · <code>/시간알림 끄기</code>',
    '',
    '👥 <b>같이 쓰기</b>',
    '단톡방에 저를 초대하면 과목·기록은 사람마다 따로 저장되고, 결과는 방에서 같이 봐요.',
    '• <code>/모두</code> 같이 쓰는 사람들의 공부 시간·과목·D-day',
    '',
    '<i>계획은 08:00~23:00, 50분 공부 · 10분 쉬기. 시험이 가까운 과목이 더 자주 들어가요.</i>',
].join('\n');

bot.start((ctx) => {
    updateChat(ctx.from.id, (c) => (c.chat = ctx.chat.id)); // 아침 알림은 /start 한 방으로 보낸다
    return ctx.reply(HELP, html);
});
bot.hears(/^[/!](도움말|help)$/i, (ctx) => ctx.reply(HELP, html));

// 시험일: 2026-12-10 / 12/10 / 12.10 (연도가 없으면 올해, 이미 지났으면 내년)
function parseExamDate(raw: string | undefined): string | undefined | null {
    if (!raw) return undefined;
    const full = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    const short = raw.match(/^(\d{1,2})[-./](\d{1,2})$/);
    const { today, year } = nowKST();
    const make = (y: number, m: string, d: string) => {
        const s = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        return Number.isNaN(Date.parse(s)) ? null : s;
    };
    if (full) return make(Number(full[1]), full[2], full[3]);
    if (short) {
        const d = make(year, short[1], short[2]);
        return d && d < today ? make(year + 1, short[1], short[2]) : d;
    }
    return null;
}

const goalLines = (goals: Goal[], today: string) =>
    goals
        .map((g) => {
            const d = daysLeft(g.exam, today);
            return `• ${escapeHtml(g.subject)}${g.exam ? ` (${g.exam}, ${d! >= 0 ? `D-${d}` : '지남'})` : ''}`;
        })
        .join('\n');

bot.hears(/^[/!]목표(?:\s+(\S+)(?:\s+(\S+))?)?$/, (ctx) => {
    const [, subject, rawDate] = ctx.match;
    const { today } = nowKST();
    if (!subject) {
        const goals = getChat(ctx.from.id).goals;
        if (!goals.length) return ctx.reply(`${who(ctx)}등록한 과목이 없어요. 예) <code>/목표 수학 2026-12-10</code>`, html);
        return ctx.reply(`${who(ctx)}🎯 <b>내 과목</b>\n${goalLines(goals, today)}`, html);
    }
    const exam = parseExamDate(rawDate);
    if (exam === null) return ctx.reply('⚠️ 날짜는 <code>2026-12-10</code> 또는 <code>12/10</code> 처럼 적어주세요.', html);
    updateChat(ctx.from.id, (c) => {
        c.goals = [...c.goals.filter((g) => g.subject !== subject), { subject, ...(exam ? { exam } : {}) }];
    });
    return ctx.reply(`${who(ctx)}✅ <b>${escapeHtml(subject)}</b> 등록${exam ? ` (시험 ${exam}, D-${daysLeft(exam, today)})` : ''}`, html);
});

bot.hears(/^[/!]목표삭제\s+(\S+)$/, (ctx) => {
    const subject = ctx.match[1];
    if (!getChat(ctx.from.id).goals.some((g) => g.subject === subject))
        return ctx.reply(`'${escapeHtml(subject)}' 과목이 없어요. <code>/목표</code> 로 목록을 확인하세요.`, html);
    updateChat(ctx.from.id, (c) => (c.goals = c.goals.filter((g) => g.subject !== subject)));
    return ctx.reply(`${who(ctx)}🗑 ${escapeHtml(subject)} 삭제했어요.`, html);
});

bot.hears(/^[/!]알림(?:\s+(\S+))?$/, (ctx) => {
    const arg = ctx.match[1];
    if (arg === '끄기') {
        updateChat(ctx.from.id, (c) => (c.morning = null));
        return ctx.reply(`${who(ctx)}🔕 아침 알림을 껐어요. 다시 켜려면 <code>/알림 07:30</code>`, html);
    }
    const m = arg?.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
        const cur = getChat(ctx.from.id).morning;
        return ctx.reply(`${who(ctx)}⏰ 지금 아침 알림: ${cur ?? '꺼짐'}\n바꾸기: <code>/알림 07:30</code> · 끄기: <code>/알림 끄기</code>`, html);
    }
    const hm = `${m[1].padStart(2, '0')}:${m[2]}`;
    updateChat(ctx.from.id, (c) => ((c.morning = hm), (c.chat = ctx.chat.id))); // 알림은 설정한 방으로 보낸다
    return ctx.reply(`${who(ctx)}⏰ 매일 ${hm}에 이 방에서 오늘 일정을 물어볼게요.`, html);
});

const fixedLine = (f: Fixed) => `${dayNames(f.days)} ${fmt(f.start)}–${fmt(f.end)} ${escapeHtml(f.label)}`;
const FIXED_USAGE = '🔁 이렇게 적어 주세요: <code>/고정 월수금 18-22 알바</code>\n요일: <code>월수금</code> · <code>월-금</code> · <code>평일</code> · <code>주말</code> · <code>매일</code>';

// 고정 일정: /고정 월수금 18-22 알바
bot.hears(/^[/!]고정(?:\s+(\S+)(?:\s+(.+))?)?$/, (ctx) => {
    const [, rawDays, rest] = ctx.match;
    if (!rawDays) {
        const list = getChat(ctx.from.id).fixed ?? [];
        if (!list.length) return ctx.reply(`${who(ctx)}등록한 고정 일정이 없어요.\n${FIXED_USAGE}`, html);
        return ctx.reply(`${who(ctx)}🔁 <b>고정 일정</b>\n${list.map((f, i) => `${i + 1}. ${fixedLine(f)}`).join('\n')}\n\n지우기: <code>/고정삭제 1</code>`, html);
    }
    const days = parseDays(rawDays);
    const busy = rest ? parseSchedule(rest) : [];
    if (!days || busy.length !== 1) return ctx.reply(FIXED_USAGE, html);
    const f = { days, ...busy[0] };
    updateChat(ctx.from.id, (c) => (c.fixed = [...(c.fixed ?? []), f]));
    return ctx.reply(`${who(ctx)}✅ 고정 일정 등록: ${fixedLine(f)}\n이 요일엔 계획에서 자동으로 빼고 짤게요.`, html);
});

bot.hears(/^[/!]고정삭제(?:\s+(\d+))?$/, (ctx) => {
    const list = getChat(ctx.from.id).fixed ?? [];
    const i = Number(ctx.match[1]) - 1;
    if (!(i >= 0 && i < list.length)) return ctx.reply(`${who(ctx)}지울 번호를 적어 주세요. <code>/고정</code> 으로 번호를 확인할 수 있어요.`, html);
    const f = list[i]; // list는 저장된 배열 그 자체라 지우기 전에 꺼내 둔다
    updateChat(ctx.from.id, (c) => c.fixed!.splice(i, 1));
    return ctx.reply(`${who(ctx)}🗑 ${fixedLine(f)} 지웠어요.`, html);
});

// 공부 기록: /기록 수학 50분
bot.hears(/^[/!]기록(?:\s+(\S+)(?:\s+(.+))?)?$/, (ctx) => {
    const [, subject, raw] = ctx.match;
    const min = raw ? parseMinutes(raw) : null;
    if (!subject || !min)
        return ctx.reply('✏️ 이렇게 적어 주세요: <code>/기록 수학 50분</code> (<code>1시간 30분</code>, <code>90</code>도 돼요)', html);
    const { today } = nowKST();
    updateChat(ctx.from.id, (c) => (c.log = [...(c.log ?? []), { date: today, subject, min }]));
    return ctx.reply(`${who(ctx)}✅ ${escapeHtml(subject)} ${dur(min)} 기록\n${progress(getChat(ctx.from.id), today)}`, html);
});

// 공부 타이머: /시작 수학 → /끝 하면 걸린 시간을 기록한다
const elapsed = (t: { start: number }) => Math.floor((Date.now() - t.start) / 60_000);
const MAX_TIMER = 5 * 60; // 이보다 길면 끄는 걸 잊은 걸로 보고 기록하지 않는다

bot.hears(/^[/!]시작(?:\s+(\S+))?$/, (ctx) => {
    const c = getChat(ctx.from.id);
    if (c.timer)
        return ctx.reply(`${who(ctx)}⏱ 이미 <b>${escapeHtml(c.timer.subject)}</b> 공부 중이에요 (${dur(elapsed(c.timer))}째). 마치려면 <code>/끝</code>`, html);
    const { today, min } = nowKST();
    const planned = c.plan?.date === today ? c.plan.sessions.find((s) => s.end > min) : undefined; // 지금(또는 다음) 계획 칸
    const subject = ctx.match[1] ?? planned?.subject ?? '공부';
    updateChat(ctx.from.id, (x) => (x.timer = { subject, start: Date.now() }));
    return ctx.reply(`${who(ctx)}⏱ <b>${escapeHtml(subject)}</b> 시작! 끝나면 <code>/끝</code> 보내 주세요. 걸린 시간을 자동으로 기록해요.`, html);
});

bot.hears(/^[/!](끝|종료)$/, (ctx) => {
    const t = getChat(ctx.from.id).timer;
    if (!t) return ctx.reply(`${who(ctx)}켜진 타이머가 없어요. <code>/시작 수학</code> 으로 켜세요.`, html);
    const min = elapsed(t);
    const ok = min >= 1 && min <= MAX_TIMER;
    updateChat(ctx.from.id, (c) => {
        delete c.timer;
        if (ok) c.log = [...(c.log ?? []), { date: kstDate(t.start), subject: t.subject, min }]; // 자정을 넘겨도 시작한 날로
    });
    if (min < 1) return ctx.reply(`${who(ctx)}1분이 안 돼서 기록하지 않았어요.`, html);
    if (!ok)
        return ctx.reply(`${who(ctx)}⚠️ 타이머가 ${dur(min)} 켜져 있었어요. 끄는 걸 잊은 것 같아 기록하지 않았어요.\n공부한 만큼 직접 적어 주세요: <code>/기록 ${escapeHtml(t.subject)} 2시간</code>`, html);
    return ctx.reply(`${who(ctx)}✅ ${escapeHtml(t.subject)} ${dur(min)} 기록\n${progress(getChat(ctx.from.id), nowKST().today)}`, html);
});

bot.hears(/^[/!]기록취소$/, (ctx) => {
    const last = getChat(ctx.from.id).log?.at(-1);
    if (!last || last.date !== nowKST().today) return ctx.reply(`${who(ctx)}오늘 지울 기록이 없어요.`, html);
    updateChat(ctx.from.id, (c) => c.log!.pop());
    return ctx.reply(`${who(ctx)}🗑 ${escapeHtml(last.subject)} ${dur(last.min)} 기록을 지웠어요.`, html);
});

function statText(log: Done[] = [], from: string, to: string, title: string) {
    const rows = totals(log, from, to);
    if (!rows.length) return `${title}\n아직 기록이 없어요. 예) <code>/기록 수학 50분</code>`;
    const sum = rows.reduce((a, [, m]) => a + m, 0);
    return `${title} · 총 <b>${dur(sum)}</b>\n${rows.map(([s, m]) => `• ${escapeHtml(s)} ${dur(m)}`).join('\n')}`;
}

bot.hears(/^[/!]오늘$/, (ctx) => {
    const { today } = nowKST();
    const c = getChat(ctx.from.id);
    const todos = keepTodos(c.todos ?? [], today);
    const todoText = todos.length ? ` · 📝 할 일 ${todos.filter((t) => t.done).length}/${todos.length}` : '';
    return ctx.reply(`${who(ctx)}${statText(c.log, today, today, '📊 <b>오늘 공부</b>')}\n\n${progress(c, today)}${todoText}`, html);
});

bot.hears(/^[/!]이번주$/, (ctx) => {
    const { today } = nowKST();
    return ctx.reply(who(ctx) + statText(getChat(ctx.from.id).log, weekStart(today), today, '📊 <b>이번 주 공부</b> (월요일부터)'), html);
});

bot.hears(/^[/!]모두$/, (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('단톡방에서 쓰는 명령어예요. 같이 공부할 사람과 단톡방에 저를 초대해 주세요.');
    const { today } = nowKST();
    const week = weekStart(today);
    const members = allChats().filter(([, c]) => c.groups?.includes(ctx.chat.id));
    const text = members.map(([, c]) => {
        const log = c.log ?? [];
        const s = streak(log, today);
        return `👤 <b>${escapeHtml(c.name ?? '?')}</b> · 오늘 ${dur(sumMin(log, today, today))} · 이번 주 ${dur(sumMin(log, week, today))}${s ? ` · 🔥 ${s}일` : ''}${c.timer ? ' · ⏱ 공부 중' : ''}\n${goalLines(c.goals, today) || '(과목 없음)'}`;
    });
    return ctx.reply(`👥 <b>같이 공부하는 사람</b>\n\n${text.join('\n\n')}`, html);
});

// /추천 (일정을 같은 메시지 아랫줄에 적어도 됨)
bot.hears(/^[/!]추천/, (ctx) => reply(ctx, ctx.message.text.replace(/^[/!]추천/, '')));
// /내일 (내일 일정을 같은 메시지에 적어도 됨): 내일 요일의 고정 일정·D-day로 짠다
bot.hears(/^[/!]내일/, (ctx) => reply(ctx, ctx.message.text.replace(/^[/!]내일/, ''), 1));

// 보낸 일정에 오늘 요일의 고정 일정을 더해서, 하루 공부 상한만큼 계획을 짠다
const DAILY = 4 * 60;
const reply = (ctx: any, text: string, after = 0) => {
    const day = new Date(Date.parse(nowKST().today) + after * 86_400_000).toISOString().slice(0, 10);
    const c = getChat(ctx.from.id);
    const busy = mergeBusy(parseSchedule(text), fixedOn(c.fixed ?? [], day));
    let note = '';
    if (!after) {
        // 오늘 계획을 저장해 두고 칸이 시작할 때 알린다 (shortcut: 계획은 하나만, /내일 계획은 알리지 않음)
        const sessions = buildPlan(busy, c.goals, day, c.daily ?? DAILY);
        const next = sessions.filter((s) => s.start < nowKST().min).length;
        updateChat(ctx.from.id, (x) => (x.plan = { date: day, chat: ctx.chat.id, sessions, next }));
        if (c.nudge !== false && next < sessions.length) note = '\n\n⏰ 공부 칸이 시작할 때마다 알려 드릴게요 · <code>/시간알림 끄기</code>';
    }
    const left = keepTodos(c.todos ?? [], day).filter((t) => !t.done);
    if (left.length) note = `\n\n📝 <b>남은 할 일</b>\n${left.map((t) => `⬜ ${escapeHtml(t.text)}`).join('\n')}` + note;
    return ctx.reply(who(ctx) + planText(busy, c.goals, day, c.daily ?? DAILY, after ? '내일' : '오늘') + note, html);
};

// ── 할 일 체크리스트 ──
// 어제까지 끝낸 걸 정리한 목록 (정리된 게 있으면 저장)
function todosOf(userId: number, today: string): Todo[] {
    const all = getChat(userId).todos ?? [];
    const kept = keepTodos(all, today);
    if (kept.length !== all.length) updateChat(userId, (c) => (c.todos = kept));
    return kept;
}

function todoReply(ctx: any, head = '') {
    const todos = todosOf(ctx.from.id, nowKST().today);
    if (!todos.length) return ctx.reply(`${who(ctx)}${head}할 일이 없어요. 예) <code>/할일 수학 문제집 3장</code>`, html);
    const done = todos.filter((t) => t.done).length;
    const list = todos.map((t, i) => `${t.done ? '✅' : '⬜'} ${i + 1}. ${escapeHtml(t.text)}`).join('\n');
    return ctx.reply(`${who(ctx)}${head}📝 <b>할 일</b> ${done}/${todos.length}\n${list}\n\n체크: <code>/완료 1</code> · 지우기: <code>/할일삭제 1</code>`, html);
}

// /할일 수학 3장 (다음 줄에 더 적으면 여러 개)
bot.hears(/^[/!]할일(?:\s+([\s\S]+))?$/, (ctx) => {
    const items = (ctx.match[1] ?? '').split('\n').map((s) => s.replace(/^[\s\-·•*]+/, '').trim()).filter(Boolean);
    if (!items.length) return todoReply(ctx);
    const today = nowKST().today;
    const todos = todosOf(ctx.from.id, today);
    updateChat(ctx.from.id, (c) => (c.todos = [...todos, ...items.map((text) => ({ text }))]));
    return todoReply(ctx, `✅ ${items.length}개 추가\n\n`);
});

bot.hears(/^[/!](완료|할일삭제)(?:\s+(.+))?$/, (ctx) => {
    const [, cmd, raw] = ctx.match;
    const today = nowKST().today;
    const todos = todosOf(ctx.from.id, today);
    const nums = parseNums(raw ?? '', todos.length);
    if (!nums) return ctx.reply(`${who(ctx)}번호를 적어 주세요. 예) <code>/${cmd} 1</code> · 번호는 <code>/할일</code> 에서 확인`, html);
    updateChat(ctx.from.id, (c) => {
        c.todos =
            cmd === '완료'
                ? todos.map((t, i) => (!nums.includes(i) ? t : t.done ? { text: t.text } : { ...t, done: today }))
                : todos.filter((_, i) => !nums.includes(i));
    });
    const allDone = cmd === '완료' && (getChat(ctx.from.id).todos ?? []).every((t) => t.done);
    return todoReply(ctx, allDone ? '🎉 오늘 할 일을 다 끝냈어요!\n\n' : '');
});


bot.hears(/^[/!]시간알림(?:\s+(켜기|끄기))?$/, (ctx) => {
    const arg = ctx.match[1];
    if (arg) updateChat(ctx.from.id, (c) => (c.nudge = arg === '켜기'));
    const on = getChat(ctx.from.id).nudge !== false;
    return ctx.reply(`${who(ctx)}⏰ 공부 시작 알림: <b>${on ? '켜짐' : '꺼짐'}</b> · ${on ? '<code>/시간알림 끄기</code>' : '<code>/시간알림 켜기</code>'}`, html);
});

// 하루 공부 시간: /공부시간 4시간
bot.hears(/^[/!]공부시간(?:\s+(.+))?$/, (ctx) => {
    const raw = ctx.match[1];
    const min = raw ? parseMinutes(raw) : null;
    if (!min || min < 30 || min > 15 * 60) {
        const cur = getChat(ctx.from.id).daily ?? DAILY;
        return ctx.reply(`${who(ctx)}⏱ 하루 공부 목표: <b>${dur(cur)}</b>\n바꾸기: <code>/공부시간 3시간</code> (30분~15시간)`, html);
    }
    updateChat(ctx.from.id, (c) => (c.daily = min));
    return ctx.reply(`${who(ctx)}⏱ 하루 공부 목표를 <b>${dur(min)}</b>으로 바꿨어요. 추천을 이만큼만 짤게요.`, html);
});

bot.on('text', (ctx) => {
    const text = ctx.message.text.trim();
    if (/^(없음|일정\s*없음|오늘\s*없음|없어|없어요)$/.test(text) || parseSchedule(text).length) return reply(ctx, text);
    if (text.startsWith('/')) return ctx.reply('모르는 명령어예요. <code>/도움말</code> 을 보세요.', html);
    if (ctx.chat.type === 'private')
        return ctx.reply('일정은 <code>9-12 수업</code> 처럼 시간을 넣어 보내 주세요. 없으면 <code>없음</code>', html);
});

// 단톡방이면 누구에게 보내는지 이름을 붙인다
const nameIn = (chatId: number | string, userId: string, c: ChatData) => (String(chatId) !== userId && c.name ? `${escapeHtml(c.name)}님, ` : '');

// 아침 알림: 30초마다 보고, 정한 시각이 지났고 오늘 아직 안 보냈으면 보낸다 (봇을 늦게 켜도 2시간 안이면 보냄)
async function morningCheck() {
    const { today, hm, min } = nowKST();
    for (const [userId, c] of allChats()) {
        if (!c.morning || c.lastMorning === today || hm < c.morning) continue;
        const [h, m] = c.morning.split(':').map(Number);
        const late = min - (h * 60 + m);
        updateChat(userId, (x) => (x.lastMorning = today)); // 실패해도 하루 한 번만 시도
        if (late > 120) continue;
        const exams = c.goals
            .map((g) => ({ g, d: daysLeft(g.exam, today) }))
            .filter((x) => x.d !== null && x.d >= 0)
            .map(({ g, d }) => `${escapeHtml(g.subject)} D-${d}`);
        const fixed = fixedOn(c.fixed ?? [], today).map((f) => `• ${fmt(f.start)}–${fmt(f.end)} ${escapeHtml(f.label)}`);
        const fixedText = fixed.length ? `\n\n🔁 오늘 고정 일정 (자동으로 넣어요)\n${fixed.join('\n')}` : '';
        const left = keepTodos(c.todos ?? [], today).filter((t) => !t.done);
        const todoText = left.length ? `\n\n📝 남은 할 일 ${left.length}개\n${left.map((t) => `⬜ ${escapeHtml(t.text)}`).join('\n')}` : '';
        const chatId = c.chat ?? userId;
        const name = nameIn(chatId, userId, c);
        await bot.telegram
            .sendMessage(
                chatId,
                `☀️ <b>${name}좋은 아침이에요!</b>${exams.length ? `\n⏳ ${exams.join(' · ')}` : ''}${fixedText}${todoText}\n\n${fixed.length ? '그 밖에 ' : '오늘 '}꼭 해야 할 일정을 한 줄에 하나씩 보내 주세요.\n<code>9-12 수업\n14-16 알바</code>\n없으면 <code>없음</code>`,
                html,
            )
            .catch((err) => console.error(`[아침 알림 실패] ${chatId}:`, err.message));
    }
}

// 공부 시작 알림: 오늘 계획의 다음 칸 시각이 되면 알린다 (10분 넘게 늦었으면 조용히 건너뜀)
async function sessionCheck() {
    const { today, min } = nowKST();
    for (const [userId, c] of allChats()) {
        const p = c.plan;
        if (c.nudge === false || !p || p.date !== today || p.next >= p.sessions.length || p.sessions[p.next].start > min) continue;
        let i = p.next;
        while (i + 1 < p.sessions.length && p.sessions[i + 1].start <= min) i++; // 봇이 꺼져 있었으면 지난 칸은 건너뛴다
        const s = p.sessions[i];
        updateChat(userId, (x) => (x.plan!.next = i + 1));
        if (min - s.start > 10) continue;
        await bot.telegram
            .sendMessage(
                p.chat,
                `⏰ ${nameIn(p.chat, userId, c)}<b>${escapeHtml(s.subject)}</b> 시간이에요 (${fmt(s.start)}–${fmt(s.end)})\n${s.method}\n<code>/시작</code> 으로 타이머 켜기`,
                html,
            )
            .catch((err) => console.error(`[공부 알림 실패] ${p.chat}:`, err.message));
    }
}

setInterval(() => {
    void morningCheck().catch((err) => console.error('[아침 알림]', err));
    void sessionCheck().catch((err) => console.error('[공부 알림]', err));
}, 30_000);

bot.catch((err, ctx) => console.error(`[오류] ${ctx.updateType}:`, err));
// 무료 서버는 들어오는 요청이 없으면 잠들어서 폴링·알림이 멈춘다.
// 공개 주소가 있으면 웹훅으로 받고, 봇이 5분마다 자기 주소를 불러 깨어 있게 한다 (바깥 서비스 필요 없음)
const env = process.env;
const host =
    env.WEBHOOK_URL ||
    env.RENDER_EXTERNAL_URL || // Render
    env.KOYEB_PUBLIC_DOMAIN || // Koyeb
    env.RAILWAY_PUBLIC_DOMAIN || // Railway
    (env.FLY_APP_NAME && `${env.FLY_APP_NAME}.fly.dev`); // Fly.io
if (host) {
    const url = /^https?:\/\//.test(host) ? host : `https://${host}`;
    const port = Number(env.PORT) || 3000;
    const ok = (_req: unknown, res: ServerResponse) => res.end('ok'); // 웹훅이 아닌 주소 (깨우기용)
    bot.launch({ webhook: { domain: url, port, host: env.IP, cb: ok } }, // alwaysdata 사이트는 IP·PORT를 넣어 줌
        () => console.log(`✅ 공부 추천 봇 시작 (웹훅 ${url}, 포트 ${port})`));
    // 대부분 15분 넘게 조용하면 잠드니 5분마다 (한두 번 실패해도 안 잠듦). 서버 안이 아니라 공개 주소로 불러야 요청으로 쳐 준다
    const wake = () =>
        fetch(url)
            .then((r) => r.ok || console.error(`[깨우기] ${url} → ${r.status}`))
            .catch((err) => console.error('[깨우기 실패]', err.message));
    setInterval(wake, 5 * 60_000);
} else bot.launch(() => console.log('✅ 공부 추천 봇 시작 (폴링: 공개 주소가 없음)'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
