// 공부 추천 텔레그램 봇: 오늘 꼭 해야 할 일정을 보내면 남는 시간에 공부 계획을 추천한다
// 실행: TELEGRAM_BOT_TOKEN=... npm start (롱 폴링이라 웹훅·공개 주소가 필요 없다)
import { Telegraf } from 'telegraf';
import {
    dayNames,
    daysLeft,
    dur,
    escapeHtml,
    fixedOn,
    fmt,
    mergeBusy,
    parseDays,
    parseMinutes,
    parseSchedule,
    planText,
    sumMin,
    totals,
    weekStart,
    type Done,
    type Fixed,
    type Goal,
} from './plan.ts';
import { allChats, getChat, updateChat } from './store.ts';

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

// 한국 시간 오늘 날짜·시각
function nowKST() {
    const iso = new Date(Date.now() + 9 * 3_600_000).toISOString();
    return { today: iso.slice(0, 10), hm: iso.slice(11, 16), year: Number(iso.slice(0, 4)) };
}

const HELP = [
    '📚 <b>공부 관리 봇</b>',
    '',
    '📅 <b>오늘 계획</b>',
    '꼭 해야 할 일정을 한 줄에 하나씩 보내면 남는 시간에 공부 계획을 짜 드려요.',
    '<code>9-12 수업',
    '14:00~16:00 알바</code>',
    '• 일정이 없으면 <code>없음</code> · 하루 전체로 짜기 <code>/추천</code>',
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
    '• <code>/기록취소</code> 오늘 마지막 기록 지우기',
    '• <code>/오늘</code> · <code>/이번주</code> 공부한 시간 보기',
    '',
    '⏰ <b>알림</b>',
    '• <code>/알림 07:30</code> 매일 아침 일정 묻기 (기본 07:30) · <code>/알림 끄기</code>',
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
    const sum = sumMin(getChat(ctx.from.id).log!, today, today);
    return ctx.reply(`${who(ctx)}✅ ${escapeHtml(subject)} ${dur(min)} 기록 · 오늘 총 <b>${dur(sum)}</b>`, html);
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
    return ctx.reply(who(ctx) + statText(getChat(ctx.from.id).log, today, today, '📊 <b>오늘 공부</b>'), html);
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
        return `👤 <b>${escapeHtml(c.name ?? '?')}</b> · 오늘 ${dur(sumMin(log, today, today))} · 이번 주 ${dur(sumMin(log, week, today))}\n${goalLines(c.goals, today) || '(과목 없음)'}`;
    });
    return ctx.reply(`👥 <b>같이 공부하는 사람</b>\n\n${text.join('\n\n')}`, html);
});

// /추천 (일정을 같은 메시지 아랫줄에 적어도 됨)
bot.hears(/^[/!]추천/, (ctx) => reply(ctx, ctx.message.text.replace(/^[/!]추천/, '')));

// 보낸 일정에 오늘 요일의 고정 일정을 더해서 계획을 짠다
const reply = (ctx: any, text: string) => {
    const { today } = nowKST();
    const c = getChat(ctx.from.id);
    return ctx.reply(who(ctx) + planText(mergeBusy(parseSchedule(text), fixedOn(c.fixed ?? [], today)), c.goals, today), html);
};

bot.on('text', (ctx) => {
    const text = ctx.message.text.trim();
    if (/^(없음|일정\s*없음|오늘\s*없음|없어|없어요)$/.test(text) || parseSchedule(text).length) return reply(ctx, text);
    if (text.startsWith('/')) return ctx.reply('모르는 명령어예요. <code>/도움말</code> 을 보세요.', html);
    if (ctx.chat.type === 'private')
        return ctx.reply('일정은 <code>9-12 수업</code> 처럼 시간을 넣어 보내 주세요. 없으면 <code>없음</code>', html);
});

// 아침 알림: 30초마다 보고, 정한 시각이 지났고 오늘 아직 안 보냈으면 보낸다 (봇을 늦게 켜도 2시간 안이면 보냄)
async function morningCheck() {
    const { today, hm } = nowKST();
    for (const [userId, c] of allChats()) {
        if (!c.morning || c.lastMorning === today || hm < c.morning) continue;
        const [h, m] = c.morning.split(':').map(Number);
        const late = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) - (h * 60 + m);
        updateChat(userId, (x) => (x.lastMorning = today)); // 실패해도 하루 한 번만 시도
        if (late > 120) continue;
        const exams = c.goals
            .map((g) => ({ g, d: daysLeft(g.exam, today) }))
            .filter((x) => x.d !== null && x.d >= 0)
            .map(({ g, d }) => `${escapeHtml(g.subject)} D-${d}`);
        const fixed = fixedOn(c.fixed ?? [], today).map((f) => `• ${fmt(f.start)}–${fmt(f.end)} ${escapeHtml(f.label)}`);
        const fixedText = fixed.length ? `\n\n🔁 오늘 고정 일정 (자동으로 넣어요)\n${fixed.join('\n')}` : '';
        const chatId = c.chat ?? userId;
        const name = String(chatId) !== userId && c.name ? `${escapeHtml(c.name)}님, ` : ''; // 단톡방이면 누구에게 묻는지
        await bot.telegram
            .sendMessage(
                chatId,
                `☀️ <b>${name}좋은 아침이에요!</b>${exams.length ? `\n⏳ ${exams.join(' · ')}` : ''}${fixedText}\n\n${fixed.length ? '그 밖에 ' : '오늘 '}꼭 해야 할 일정을 한 줄에 하나씩 보내 주세요.\n<code>9-12 수업\n14-16 알바</code>\n없으면 <code>없음</code>`,
                html,
            )
            .catch((err) => console.error(`[아침 알림 실패] ${chatId}:`, err.message));
    }
}
setInterval(() => void morningCheck().catch((err) => console.error('[아침 알림]', err)), 30_000);

bot.catch((err, ctx) => console.error(`[오류] ${ctx.updateType}:`, err));
bot.launch(() => console.log('✅ 공부 추천 봇 시작'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
