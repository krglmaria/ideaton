// Главный файл сервера: раздаёт сайт из public/ и API под /api
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./server/db');
const ai = require('./server/ai');
const { seed } = require('./server/seed');
const { ratingFor, availableMonths, monthKey, LESSONS_TARGET } = require('./server/rating');
const { buildNotesDoc, buildLessonReport, buildGradesWorkbook } = require('./server/reports');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Если данных ещё нет, создаём тестовые
if (!fs.existsSync(path.join(db.DATA_DIR, 'users.json'))) seed();

const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ---------- Справочники ----------
app.get('/api/users', (req, res) => res.json(db.read('users')));
app.get('/api/courses', (req, res) => {
  const lessons = db.read('lessons').filter((l) => l.status === 'published');
  res.json(db.read('courses').map((c) => ({ ...c, lessonsCount: lessons.filter((l) => l.courseId === c.id).length })));
});

// Уроки. С ?studentId=... добавляем отметку о прохождении
app.get('/api/lessons', (req, res) => {
  let list = db.read('lessons');
  if (req.query.courseId) list = list.filter((l) => l.courseId === req.query.courseId);
  if (req.query.status) list = list.filter((l) => l.status === req.query.status);
  const attempts = db.read('attempts');
  const gaps = db.read('gaps');
  list = list.map((l) => {
    const mine = req.query.studentId ? attempts.filter((a) => a.lessonId === l.id && a.studentId === req.query.studentId) : [];
    const last = mine.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0];
    const all = attempts.filter((a) => a.lessonId === l.id);
    return {
      ...l,
      done: !!last, myScore: last ? last.score : null,
      passedCount: new Set(all.map((a) => a.studentId)).size,
      avgScore: all.length ? Math.round(all.reduce((s, a) => s + a.score, 0) / all.length) : null,
      gapsCount: gaps.filter((g) => g.lessonId === l.id).length,
    };
  });
  res.json(list);
});

app.get('/api/lessons/:id', (req, res) => {
  const lesson = db.read('lessons').find((l) => l.id === req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Урок не найден' });
  res.json(lesson);
});

// ---------- Генерация и сохранение урока ----------
app.post('/api/lessons/generate', route(async (req, res) => {
  const { topic, goals, level, language, size } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Укажи тему урока' });
  const { data, mode } = await ai.generateLesson({ topic: topic.trim(), goals, level, language: language || 'ru', size });
  res.json({ draft: { ...data, topic: topic.trim(), language: language || 'ru' }, mode });
}));

app.post('/api/lessons', (req, res) => {
  const { title, topic, goals, steps, notes, courseId, language, createdBy } = req.body;
  if (!title || !Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'Некорректный урок' });
  const lessons = db.read('lessons');
  const lesson = {
    id: db.newId('l'), courseId: courseId || 'c1', title, topic: topic || title,
    goals: goals || [], notes: notes || null, language: language || 'ru', status: 'published', createdBy: createdBy || 't1',
    steps: steps.map((s, i) => ({ ...s, id: 's' + (i + 1) })),
  };
  lessons.push(lesson);
  db.write('lessons', lessons);
  res.json(lesson);
});

// ---------- Прохождение урока ----------
app.post('/api/chat', route(async (req, res) => {
  const { lessonId, stepId, studentId, message, action, history, language } = req.body;
  const lesson = db.read('lessons').find((l) => l.id === lessonId);
  if (!lesson) return res.status(404).json({ error: 'Урок не найден' });
  const { data, mode } = await ai.chatWithStudent({ lesson, stepId, history: history || [], message: message || '', action, language: language || lesson.language });
  if (data.gap) {
    const gaps = db.read('gaps');
    gaps.push({ id: db.newId('g'), lessonId, stepId, studentId, type: data.gap.type, note: data.gap.note, date: new Date().toISOString() });
    db.write('gaps', gaps);
  }
  const activity = db.read('activity');
  activity.push({ studentId, date: new Date().toISOString(), action: 'chat_message' });
  db.write('activity', activity);
  res.json({ reply: data.reply, gapSaved: !!data.gap, mode });
}));

app.post('/api/answer', route(async (req, res) => {
  const { lessonId, stepId, answer, language } = req.body;
  const lesson = db.read('lessons').find((l) => l.id === lessonId);
  if (!lesson) return res.status(404).json({ error: 'Урок не найден' });
  const { data, mode } = await ai.checkAnswer({ lesson, stepId, answer: answer || '', language: language || lesson.language });
  res.json({ ...data, mode });
}));

// Завершение урока: считаем оценку и сохраняем попытку
app.post('/api/attempts', (req, res) => {
  const { lessonId, studentId, answers } = req.body;
  const lesson = db.read('lessons').find((l) => l.id === lessonId);
  if (!lesson) return res.status(404).json({ error: 'Урок не найден' });
  const questions = lesson.steps.filter((s) => s.type === 'question');
  // За каждую лишнюю попытку снимаем 10 баллов
  const scored = questions.map((q) => {
    const a = (answers || []).find((x) => x.stepId === q.id);
    return a ? { stepId: q.id, score: a.score, tries: a.tries || 1, final: Math.max(0, a.score - 10 * ((a.tries || 1) - 1)) } : { stepId: q.id, score: 0, tries: 0, final: 0 };
  });
  const score = questions.length ? Math.round(scored.reduce((s, x) => s + x.final, 0) / questions.length) : 100;
  const attempt = {
    id: db.newId('a'), lessonId, studentId,
    answers: scored.map(({ stepId, score: sc, tries }) => ({ stepId, score: sc, tries })),
    score, completedAt: new Date().toISOString(),
  };
  const attempts = db.read('attempts');
  attempts.push(attempt);
  db.write('attempts', attempts);
  const activity = db.read('activity');
  activity.push({ studentId, date: attempt.completedAt, action: 'lesson_completed' });
  db.write('activity', activity);

  const month = monthKey(new Date());
  const rating = ratingFor(month);
  const me = rating.find((r) => r.userId === studentId);
  res.json({ attempt, rank: me ? me.rank : null, points: me ? me.points : null, total: rating.length });
});

// ---------- Главные страницы ----------
app.get('/api/student/:id/home', (req, res) => {
  const lessons = db.read('lessons').filter((l) => l.status === 'published');
  const courses = db.read('courses');
  const attempts = db.read('attempts').filter((a) => a.studentId === req.params.id);
  const doneIds = new Set(attempts.map((a) => a.lessonId));

  const courseCards = courses.map((c) => {
    const cl = lessons.filter((l) => l.courseId === c.id);
    const done = cl.filter((l) => doneIds.has(l.id)).length;
    return { ...c, lessonsCount: cl.length, doneCount: done, progress: cl.length ? Math.round((done / cl.length) * 100) : 0 };
  });
  const todo = lessons.filter((l) => !doneIds.has(l.id));
  const totalProgress = lessons.length ? Math.round((doneIds.size / lessons.length) * 100) : 0;
  const deadlines = ['today', 'tomorrow', 'week'];
  res.json({
    classesToday: 3,
    tasksDue: todo.length,
    progress: totalProgress,
    courses: courseCards,
    tasks: todo.slice(0, 4).map((l, i) => ({ lessonId: l.id, title: l.title, courseId: l.courseId, due: deadlines[Math.min(i, 2)] })),
  });
});

app.get('/api/teacher/home', (req, res) => {
  const lessons = db.read('lessons');
  const attempts = db.read('attempts');
  const activity = db.read('activity');
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const weeklyActive = new Set(activity.filter((a) => new Date(a.date).getTime() >= weekAgo).map((a) => a.studentId)).size;
  res.json({
    lessonsCreated: lessons.length,
    studentsPassed: new Set(attempts.map((a) => a.studentId)).size,
    avgScore: attempts.length ? Math.round(attempts.reduce((s, a) => s + a.score, 0) / attempts.length) : 0,
    weeklyActive,
    totalStudents: db.read('users').filter((u) => u.role === 'student').length,
    gapsCount: db.read('gaps').length,
  });
});

// ---------- Рейтинг ----------
app.get('/api/rating', (req, res) => {
  const month = req.query.month || monthKey(new Date());
  res.json({ month, months: availableMonths(), target: LESSONS_TARGET, rows: ratingFor(month) });
});

// ---------- Недочёты, отчёты, оценки ----------
app.get('/api/gaps', (req, res) => {
  let gaps = db.read('gaps');
  if (req.query.lessonId) gaps = gaps.filter((g) => g.lessonId === req.query.lessonId);
  res.json(gaps);
});

// Скачать JSON с недочётами урока
app.get('/api/lessons/:id/gaps.json', (req, res) => {
  const gaps = db.read('gaps').filter((g) => g.lessonId === req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="gaps-${req.params.id}.json"`);
  res.json(gaps);
});

app.get('/api/lessons/:id/report.docx', route(async (req, res) => {
  const lesson = db.read('lessons').find((l) => l.id === req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Урок не найден' });
  const lang = req.query.lang === 'kk' ? 'kk' : 'ru';
  const gaps = db.read('gaps').filter((g) => g.lessonId === lesson.id);
  const { data: recommendations } = await ai.recommend({ lesson, gaps, language: lang });
  const buf = await buildLessonReport({ lessonId: lesson.id, lang, recommendations });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="report-${lesson.id}.docx"`);
  res.send(Buffer.from(buf));
}));

app.get('/api/lessons/:id/notes.docx', route(async (req, res) => {
  const lesson = db.read('lessons').find((l) => l.id === req.params.id);
  if (!lesson || !lesson.notes) return res.status(404).json({ error: 'Конспект не найден' });
  const buf = await buildNotesDoc(lesson, req.query.lang === 'kk' ? 'kk' : 'ru');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="notes-${lesson.id}.docx"`);
  res.send(Buffer.from(buf));
}));

app.get('/api/grades.xlsx', route(async (req, res) => {
  const buf = await buildGradesWorkbook({ month: req.query.month, lessonId: req.query.lessonId });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="grades.xlsx"');
  res.send(Buffer.from(buf));
}));

// ---------- Настройки демо ----------
app.get('/api/config', (req, res) => res.json({ mock: ai.isMock(), hasKey: ai.hasKey() }));
app.post('/api/config', (req, res) => { ai.setMock(!!req.body.mock); res.json({ mock: ai.isMock() }); });
app.post('/api/reset', (req, res) => { seed(); res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Платформа запущена: http://localhost:${PORT} (MOCK_AI=${ai.isMock()})`));
