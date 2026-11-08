// 사람(텔레그램 사용자 ID)별 목표·아침 알림 설정을 JSON 파일 하나에 저장한다
// 1:1 대화는 대화방 ID = 사용자 ID라 예전 데이터가 그대로 이어진다
// shortcut: 파일 하나라 봇 서버를 여러 대 띄우면 안 되고, 사용자가 수백 명을 넘으면 DB로 옮긴다
import fs from 'node:fs';
import path from 'node:path';
import type { Done, Goal } from './plan.ts';

export interface ChatData {
    goals: Goal[];
    morning: string | null; // 아침 알림 시각 'HH:MM' (null = 끔)
    lastMorning?: string; // 마지막으로 아침 알림을 보낸 날 (하루 한 번만)
    name?: string; // 단톡방에서 누구 것인지 보여줄 이름
    chat?: number; // 아침 알림을 보낼 대화방 (없으면 1:1)
    groups?: number[]; // 같이 쓰는 단톡방 (/모두 에 보이는 곳)
    log?: Done[]; // 공부 기록 (shortcut: 계속 쌓기만 한다, 하루 몇 건이라 몇 년은 괜찮고 느려지면 오래된 걸 지운다)
}

const FILE = process.env.STORE_FILE || path.resolve('data/store.json');

let cache: Record<string, ChatData> | null = null;

function load(): Record<string, ChatData> {
    if (cache) return cache;
    try {
        cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // 깨진 파일은 덮어쓰지 않게 멈춘다
        cache = {};
    }
    return cache!;
}

// 임시 파일에 쓰고 바꿔치기 (쓰는 중에 꺼져도 기존 파일이 남는다)
function save() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(cache, null, 2));
    fs.renameSync(`${FILE}.tmp`, FILE);
}

export function getChat(chatId: number | string): ChatData {
    const all = load();
    return (all[String(chatId)] ??= { goals: [], morning: '07:30' });
}

export function updateChat(chatId: number | string, change: (c: ChatData) => void) {
    change(getChat(chatId));
    save();
}

export function allChats(): [string, ChatData][] {
    return Object.entries(load());
}
