// 공부 추천 텔레그램 봇: 오늘 꼭 해야 할 일정을 보내면 남는 시간에 공부 계획을 추천한다
// 실행: TELEGRAM_BOT_TOKEN=... npm start (롱 폴링이라 웹훅·공개 주소가 필요 없다)
import { Telegraf } from 'telegraf';
import { daysLeft, escapeHtml, parseSchedule, planText, type Goal } from './plan.ts';
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
    '📚 <b>공부 추천 봇</b>',
    '',
    '오늘 <b>꼭 해야 할 일정</b>을 한 줄에 하나씩 보내면, 남는 시간에 무엇을 어떻게 공부할지 짜 드려요.',
    '<code>9-12 수업',
    '14:00~16:00 알바',
    '오후 7시부터 8시 저녁 약속</code>',
    '일정이 없으면 <code>없음</code> 이라고 보내세요.',
    '',
    '<b>명령어</b>',
    '• <code>/목표 수학 2026-12-10</code> 과목 등록 (시험일은 없어도 됨, <code>12/10</code>도 가능)',
    '• <code>/목표</code> 등록한 과목 보기 · <code>/목표삭제 수학</code>',
    '• <code>/추천</code> 일정 없이 하루 전체로 추천',
    '• <code>/알림 07:30</code> 매일 아침 일정 묻기 (기본 07:30) · <code>/알림 끄기</code>',
    '• <code>/모두</code> 단톡방에서 같이 쓰는 사람들의 과목·D-day 보기',
    '',
    '<i>단톡방에 초대하면 과목·알림은 사람마다 따로 저장되고, 추천은 방에 올라와 서로 볼 수 있어요.</i>',
    '<i>공부 시간은 08:00~23:00, 50분 공부 · 10분 쉬기로 나눕니다. 시험이 가까운 과목이 더 자주 들어가요.</i>',
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

bot.hears(/^[/!]모두$/, (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('단톡방에서 쓰는 명령어예요. 같이 공부할 사람과 단톡방에 저를 초대해 주세요.');
    const { today } = nowKST();
    const members = allChats().filter(([, c]) => c.groups?.includes(ctx.chat.id));
    const text = members.map(([, c]) => `👤 <b>${escapeHtml(c.name ?? '?')}</b>\n${goalLines(c.goals, today) || '(과목 없음)'}`);
    return ctx.reply(`👥 <b>같이 공부하는 사람</b>\n\n${text.join('\n\n')}`, html);
});

// /추천 (일정을 같은 메시지 아랫줄에 적어도 됨)
bot.hears(/^[/!]추천/, (ctx) => reply(ctx, ctx.message.text.replace(/^[/!]추천/, '')));

const reply = (ctx: any, text: string) =>
    ctx.reply(who(ctx) + planText(parseSchedule(text), getChat(ctx.from.id).goals, nowKST().today), html);

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
        const chatId = c.chat ?? userId;
        const name = String(chatId) !== userId && c.name ? `${escapeHtml(c.name)}님, ` : ''; // 단톡방이면 누구에게 묻는지
        await bot.telegram
            .sendMessage(
                chatId,
                `☀️ <b>${name}좋은 아침이에요!</b>${exams.length ? `\n⏳ ${exams.join(' · ')}` : ''}\n\n오늘 꼭 해야 할 일정을 한 줄에 하나씩 보내 주세요.\n<code>9-12 수업\n14-16 알바</code>\n없으면 <code>없음</code>`,
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
