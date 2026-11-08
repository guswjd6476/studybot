import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, dur, fmt, freeBlocks, parseMinutes, parseSchedule, planText, sumMin, totals, weekStart } from '../src/plan.ts';

const TODAY = '2026-11-08';

test('일정 읽기: 여러 형식', () => {
    const busy = parseSchedule('9-12 수업\n14:00~16:30 알바\n오후 7시부터 8시 저녁 약속\n준비물 챙기기');
    assert.deepEqual(
        busy.map((b) => [fmt(b.start), fmt(b.end), b.label]),
        [
            ['09:00', '12:00', '수업'],
            ['14:00', '16:30', '알바'],
            ['19:00', '20:00', '저녁 약속'],
        ],
    );
    // 오전·오후 없는 1~6시는 오후, '11-1'은 11시~13시
    assert.deepEqual(parseSchedule('2-4 병원').map((b) => [fmt(b.start), fmt(b.end)]), [['14:00', '16:00']]);
    assert.deepEqual(parseSchedule('11-1 점심').map((b) => [fmt(b.start), fmt(b.end)]), [['11:00', '13:00']]);
});

test('빈 시간: 30분 미만은 버리고, 겹치는 일정은 합친다', () => {
    const busy = parseSchedule('8-9 운동\n9:20-12 수업\n10-13 팀플');
    assert.deepEqual(
        freeBlocks(busy).map(([s, e]) => [fmt(s), fmt(e)]),
        [['13:00', '23:00']],
    );
});

test('계획: 50분 공부 10분 쉬기, 시험 가까운 과목이 더 자주, 마지막은 인출 복습', () => {
    const busy = parseSchedule('8-20 학교');
    const plan = buildPlan(busy, [{ subject: '영어' }, { subject: '수학', exam: '2026-11-12' }], TODAY);
    assert.deepEqual(
        plan.map((s) => `${fmt(s.start)} ${s.subject}`),
        ['20:00 수학', '21:00 영어', '22:00 수학'],
    );
    assert.match(plan[0].method, /기출/); // 시험 4일 전
    assert.match(plan[2].method, /백지/);
    assert.equal(plan[0].end - plan[0].start, 50);
});

test('식사 시간(12–13시·18–19시)은 일정과 겹치지 않으면 비워 둔다', () => {
    const starts = buildPlan(parseSchedule('8-11 수업\n13-18 알바'), [], TODAY).map((s) => fmt(s.start));
    assert.deepEqual(starts, ['11:00', '19:00', '20:00', '21:00', '22:00']); // 12시 점심·18시 저녁 빠짐
});

test('목표가 없거나 빈 시간이 없을 때 안내', () => {
    assert.match(planText([], [], TODAY), /\/목표 수학/);
    assert.match(planText(parseSchedule('8-23 근무'), [], TODAY), /빈 시간이 없어요/);
});

test('공부 시간 읽기', () => {
    const cases: [string, number | null][] = [
        ['50', 50], ['50분', 50], ['1시간', 60], ['1시간 30분', 90], ['1.5시간', 90], ['1h30m', 90], ['２시간', 120],
        ['0', null], ['25시간', null], ['수학', null], ['', null], ['1.5', null],
    ];
    for (const [s, want] of cases) assert.equal(parseMinutes(s), want, s);
    assert.equal(dur(50), '50분');
    assert.equal(dur(60), '1시간');
    assert.equal(dur(130), '2시간 10분');
});

test('기록 합계와 이번 주', () => {
    assert.equal(weekStart('2026-11-08'), '2026-11-02'); // 일요일 → 그 주 월요일
    assert.equal(weekStart('2026-11-02'), '2026-11-02');
    const log = [
        { date: '2026-11-01', subject: '수학', min: 100 }, // 지난주
        { date: '2026-11-03', subject: '수학', min: 50 },
        { date: '2026-11-08', subject: '영어', min: 30 },
        { date: '2026-11-08', subject: '수학', min: 60 },
    ];
    assert.deepEqual(totals(log, '2026-11-02', '2026-11-08'), [['수학', 110], ['영어', 30]]);
    assert.equal(sumMin(log, '2026-11-08', '2026-11-08'), 90);
});
