require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { connectDB } = require('./src/db');
const Attendance = require('./src/models/Attendance');
const Employee = require('./src/models/Employee');
const { syncOnce, syncStatus } = require('./src/sync');
const { startLogClientServer } = require('./src/logclient');

const port = Number(process.env.PORT || process.env.APP_PORT || 3001);
const intervalMs = Number(process.env.SYNC_INTERVAL_MS || 15000);
const departments = ['Viralstan', 'Vitoxyz', 'Transvera', 'RevnoRCM', 'Elitesbook'];
const employeeRoles = ['Employee', 'Manager', 'Board Member'];
const employeeFields = ['name', 'phone', 'alternatePhone', 'department', 'role', 'employeeCode', 'joiningDate', 'dateOfBirth', 'gender', 'employmentType', 'alias', 'workEmail', 'personalEmail', 'pan', 'maritalStatus', 'bloodGroup', 'fatherName', 'motherName', 'bankAccount', 'ifsc', 'accountType', 'bankName', 'bankBranch', 'accountHolder', 'aadhaar', 'emergencyPhone', 'nationality', 'designation', 'location', 'team', 'shift', 'monthlySalary', 'salaryEffectiveFrom', 'salaryNotes', 'active'];

function employeeUpdate(body) {
  const update = {};
  for (const field of employeeFields) if (body[field] !== undefined) update[field] = body[field];
  if (update.name !== undefined) update.name = String(update.name).trim();
  if (update.department && !departments.includes(update.department)) throw new Error('Invalid department');
  if (update.role && !employeeRoles.includes(update.role)) throw new Error('Invalid employee role');
  return update;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

async function employeeNameMap() {
  const employees = await Employee.find().lean();
  const map = new Map();
  for (const employee of employees) map.set(employee.deviceUserId, employee.name);
  return map;
}

function withNames(records, nameMap) {
  return records.map((record) => ({ ...record, employeeName: nameMap.get(record.deviceUserId) || null }));
}

function normalizeEnrollmentId(value) {
  const text = String(value || '').trim();
  return /^\d{1,8}$/.test(text) ? text.padStart(8, '0') : text;
}

async function resolveEnrollmentId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{1,8}$/.test(text)) return normalizeEnrollmentId(text);
  const needle = text.toLocaleLowerCase('en-IN');
  const employees = await Employee.find({}, { deviceUserId: 1, name: 1 }).lean();
  const exact = employees.find((employee) => employee.name?.trim().toLocaleLowerCase('en-IN') === needle);
  if (exact) return exact.deviceUserId;
  const partial = employees.filter((employee) => employee.name?.trim().toLocaleLowerCase('en-IN').includes(needle));
  return partial.length === 1 ? partial[0].deviceUserId : '__NOT_FOUND__';
}

function buildDailyReport(records, dayEnd) {
  const byUser = new Map();
  for (const record of records) {
    if (!byUser.has(record.deviceUserId)) byUser.set(record.deviceUserId, []);
    byUser.get(record.deviceUserId).push(record);
  }
  return [...byUser.entries()].map(([deviceUserId, punches]) => {
    punches.sort((a, b) => new Date(a.recordTime) - new Date(b.recordTime));
    let insideMs = 0;
    let unmatchedOuts = 0;
    const sessions = [];
    const runs = [];
    for (const punch of punches) {
      if (!['IN', 'OUT'].includes(punch.punchType)) continue;
      const lastRun = runs[runs.length - 1];
      if (!lastRun || lastRun.type !== punch.punchType) runs.push({ type: punch.punchType, punches: [punch] });
      else lastRun.punches.push(punch);
    }
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      if (run.type === 'OUT') {
        if (index === 0 || runs[index - 1].type !== 'IN') unmatchedOuts += run.punches.length;
        continue;
      }
      const outRun = runs[index + 1];
      if (!outRun || outRun.type !== 'OUT') continue;
      const inPunch = run.punches[0];
      // Multiple scans on the OUT machine before the next IN are one exit run;
      // the final OUT is the employee's actual last exit for that session.
      const outPunch = outRun.punches[outRun.punches.length - 1];
      const durationMs = Math.max(0, new Date(outPunch.recordTime) - new Date(inPunch.recordTime));
      insideMs += durationMs;
      sessions.push({ in: inPunch.recordTime, out: outPunch.recordTime, durationMs });
    }
    const openIn = runs[runs.length - 1]?.type === 'IN' ? runs[runs.length - 1].punches[0] : null;
    const firstInPunch = punches.find((p) => p.punchType === 'IN') || null;
    // Never show an OUT that occurred before the employee's IN as "Last Out".
    // Only a successfully matched session may contribute the displayed OUT.
    const lastMatchedSession = sessions[sessions.length - 1] || null;
    const lastPunch = punches[punches.length - 1];
    return {
      deviceUserId,
      employeeName: punches[0].employeeName || null,
      firstIn: firstInPunch?.recordTime || null,
      lastOut: lastMatchedSession?.out || null,
      insideMs,
      isComplete: sessions.length > 0 && !openIn,
      hasIncompletePunch: Boolean(openIn || unmatchedOuts),
      currentStatus: lastPunch.punchType === 'IN' ? 'INSIDE' : 'OUTSIDE',
      punchCount: punches.length,
      sessions,
      punches,
    };
  }).sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }));
}

const QUALITY_GREEN_MIN = 480;
const QUALITY_ORANGE_MIN = 465;

function classifyQuality(totalMinutes, punchCount) {
  if (punchCount === 0) return 'absent';
  if (totalMinutes >= QUALITY_GREEN_MIN) return 'green';
  if (totalMinutes >= QUALITY_ORANGE_MIN) return 'orange';
  return 'red';
}

function monthRangeLocal(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const days = new Date(year, month, 0).getDate();
  return { start, end, days, year, month };
}

function localDateKey(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildRangeSummary(records, fromText, toText, selectedEmployee) {
  const groups = new Map();
  for (const record of records) {
    const date = localDateKey(record.recordTime);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(record);
  }
  const now = new Date();
  const result = [...groups.entries()].flatMap(([date, dayRecords]) => {
    const [year, month, day] = date.split('-').map(Number);
    const end = new Date(year, month - 1, day + 1);
    const start = new Date(year, month - 1, day);
    const effectiveEnd = now >= start && now < end ? now : end;
    return buildDailyReport(dayRecords, effectiveEnd).map((entry) => ({ date, ...entry, punches: undefined }));
  });
  if (selectedEmployee) {
    const existing = new Map(result.map((entry) => [entry.date, entry]));
    const [fy, fm, fd] = fromText.split('-').map(Number);
    const [ty, tm, td] = toText.split('-').map(Number);
    for (let cursor = new Date(fy, fm - 1, fd), end = new Date(ty, tm - 1, td); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const date = localDateKey(cursor);
      if (!existing.has(date)) result.push({ date, deviceUserId: selectedEmployee.deviceUserId, employeeName: selectedEmployee.name, absent: true, firstIn: null, lastOut: null, insideMs: 0, punchCount: 0, sessions: [] });
    }
  }
  return result.sort((a, b) => b.date.localeCompare(a.date) || a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }));
}

const server = http.createServer(async (req, res) => {
  const safePath = String(req.url || '/').replace(/^\/{2,}/, '/');
  const url = new URL(safePath, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && ['/', '/overview', '/attendance', '/punches', '/employees', '/profiles', '/salary', '/monthly-attendance'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
    }
    if (req.method === 'GET' && (url.pathname === '/live' || url.pathname === '/live/' || url.pathname.startsWith('/live/'))) {
      const staticMap = { '/live': 'index.html', '/live/': 'index.html', '/live/index.html': 'index.html', '/live/style.css': 'style.css', '/live/app.js': 'app.js' };
      const fileName = staticMap[url.pathname];
      if (!fileName) return json(res, 404, { error: 'Not found' });
      const contentType = fileName.endsWith('.css') ? 'text/css; charset=utf-8' : fileName.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': contentType });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'live', fileName), 'utf8'));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, syncStatus);
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const [totalRecords, inRecords, outRecords, range, attendanceIds, employees, faceRecords, fingerprintRecords, recent, dailyTrend] = await Promise.all([
        Attendance.countDocuments(),
        Attendance.countDocuments({ punchType: 'IN' }),
        Attendance.countDocuments({ punchType: 'OUT' }),
        Attendance.aggregate([{ $group: { _id: null, first: { $min: '$recordTime' }, last: { $max: '$recordTime' } } }]),
        Attendance.distinct('deviceUserId'),
        Employee.find({}, { deviceUserId: 1, name: 1 }).lean(),
        Attendance.countDocuments({ $or: [{ 'raw.mode': { $in: ['15', '30'] } }, { 'raw.verificationMode': { $in: ['15', '30'] } }] }),
        Attendance.countDocuments({ $or: [{ 'raw.mode': '1' }, { 'raw.verificationMode': '1' }] }),
        Attendance.find().sort({ recordTime: -1 }).limit(12).lean(),
        Attendance.aggregate([
          { $group: {
            _id: { $dateToString: { date: '$recordTime', format: '%Y-%m-%d', timezone: '+05:30' } },
            punches: { $sum: 1 },
            employees: { $addToSet: '$deviceUserId' },
            ins: { $sum: { $cond: [{ $eq: ['$punchType', 'IN'] }, 1, 0] } },
            outs: { $sum: { $cond: [{ $eq: ['$punchType', 'OUT'] }, 1, 0] } },
          } },
          { $sort: { _id: -1 } },
          { $limit: 14 },
          { $project: { _id: 0, date: '$_id', punches: 1, employees: { $size: '$employees' }, ins: 1, outs: 1 } },
          { $sort: { date: 1 } },
        ]),
      ]);
      const names = new Map(employees.map((employee) => [employee.deviceUserId, employee.name]));
      const namedEmployees = attendanceIds.filter((id) => names.get(id)?.trim()).length;
      return json(res, 200, {
        totals: {
          records: totalRecords,
          inRecords,
          outRecords,
          employees: attendanceIds.length,
          namedEmployees,
          unnamedEmployees: attendanceIds.length - namedEmployees,
          faceRecords,
          fingerprintRecords,
        },
        range: { first: range[0]?.first || null, last: range[0]?.last || null },
        recent: withNames(recent, names),
        dailyTrend,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/attendance') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
      const [records, nameMap] = await Promise.all([
        Attendance.find().sort({ recordTime: -1 }).limit(limit).lean(),
        employeeNameMap(),
      ]);
      return json(res, 200, { records: withNames(records, nameMap) });
    }
    if (req.method === 'GET' && url.pathname === '/api/employees') {
      const [employees, attendanceIds] = await Promise.all([
        Employee.find().sort({ deviceUserId: 1 }).lean(),
        Attendance.distinct('deviceUserId'),
      ]);
      const namedIds = new Set(employees.filter((employee) => employee.name?.trim()).map((employee) => employee.deviceUserId));
      const unnamedIds = attendanceIds.filter((id) => !namedIds.has(id)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return json(res, 200, { employees, unnamedIds, departments, employeeRoles });
    }
    if (req.method === 'GET' && url.pathname === '/api/monthly-summary') {
      const monthStr = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthStr)) return json(res, 400, { error: 'Invalid month' });
      const { start, end, days, year, month } = monthRangeLocal(monthStr);
      const [records, employees] = await Promise.all([
        Attendance.find({ recordTime: { $gte: start, $lt: end } }).sort({ recordTime: 1 }).lean(),
        Employee.find().sort({ deviceUserId: 1 }).lean(),
      ]);
      const nameMap = new Map(employees.map((employee) => [employee.deviceUserId, employee.name]));
      const named = withNames(records, nameMap);
      const byDate = new Map();
      for (const record of named) {
        const key = localDateKey(record.recordTime);
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(record);
      }
      const now = new Date();
      const todayKey = localDateKey(now);
      const perEmployee = new Map();
      for (const employee of employees) {
        perEmployee.set(employee.deviceUserId, {
          deviceUserId: employee.deviceUserId, name: employee.name, department: employee.department || null,
          designation: employee.designation || null, totalMinutes: 0, presentDays: 0,
          greenDays: 0, orangeDays: 0, redDays: 0, absentDays: 0,
        });
      }
      for (let day = 1; day <= days; day += 1) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (key > todayKey) continue;
        const dayEnd = key === todayKey ? now : new Date(year, month - 1, day + 1);
        const report = buildDailyReport(byDate.get(key) || [], dayEnd);
        const seen = new Set();
        for (const entry of report) {
          const stat = perEmployee.get(entry.deviceUserId);
          if (!stat) continue;
          seen.add(entry.deviceUserId);
          const minutes = Math.round(entry.insideMs / 60000);
          stat.totalMinutes += minutes;
          if (entry.punchCount > 0) stat.presentDays += 1;
          const quality = classifyQuality(minutes, entry.punchCount);
          if (quality === 'green') stat.greenDays += 1;
          else if (quality === 'orange') stat.orangeDays += 1;
          else if (quality === 'red') stat.redDays += 1;
          else stat.absentDays += 1;
        }
        for (const [deviceUserId, stat] of perEmployee) {
          if (!seen.has(deviceUserId)) stat.absentDays += 1;
        }
      }
      const result = [...perEmployee.values()].map((stat) => ({
        ...stat,
        avgMinutes: stat.presentDays ? Math.round(stat.totalMinutes / stat.presentDays) : 0,
        overallQuality: classifyQuality(stat.presentDays ? Math.round(stat.totalMinutes / stat.presentDays) : 0, stat.presentDays),
      }));
      return json(res, 200, { month: monthStr, employees: result });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/monthly-summary/')) {
      const deviceUserId = decodeURIComponent(url.pathname.slice('/api/monthly-summary/'.length));
      const monthStr = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthStr)) return json(res, 400, { error: 'Invalid month' });
      const { start, end, days, year, month } = monthRangeLocal(monthStr);
      const [employee, records] = await Promise.all([
        Employee.findOne({ deviceUserId }).lean(),
        Attendance.find({ deviceUserId, recordTime: { $gte: start, $lt: end } }).sort({ recordTime: 1 }).lean(),
      ]);
      if (!employee) return json(res, 404, { error: 'Employee not found' });
      const byDate = new Map();
      for (const record of records) {
        const key = localDateKey(record.recordTime);
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(record);
      }
      const now = new Date();
      const todayKey = localDateKey(now);
      const dayList = [];
      const summary = { totalMinutes: 0, presentDays: 0, greenDays: 0, orangeDays: 0, redDays: 0, absentDays: 0 };
      for (let day = 1; day <= days; day += 1) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (key > todayKey) { dayList.push({ date: key, status: 'future', firstIn: null, lastOut: null, minutes: 0, sessions: [] }); continue; }
        const dayEnd = key === todayKey ? now : new Date(year, month - 1, day + 1);
        const [entry] = buildDailyReport(byDate.get(key) || [], dayEnd);
        const minutes = entry ? Math.round(entry.insideMs / 60000) : 0;
        const punchCount = entry ? entry.punchCount : 0;
        const status = classifyQuality(minutes, punchCount);
        summary.totalMinutes += minutes;
        if (punchCount > 0) summary.presentDays += 1;
        if (status === 'green') summary.greenDays += 1;
        else if (status === 'orange') summary.orangeDays += 1;
        else if (status === 'red') summary.redDays += 1;
        else summary.absentDays += 1;
        dayList.push({
          date: key, status, minutes, punchCount,
          firstIn: entry?.firstIn || null, lastOut: entry?.lastOut || null,
          sessions: entry?.sessions || [], hasIncompletePunch: entry?.hasIncompletePunch || false,
        });
      }
      summary.avgMinutes = summary.presentDays ? Math.round(summary.totalMinutes / summary.presentDays) : 0;
      return json(res, 200, { employee: { deviceUserId: employee.deviceUserId, name: employee.name, department: employee.department || null, designation: employee.designation || null }, month: monthStr, days: dayList, summary });
    }
    if (req.method === 'POST' && url.pathname === '/api/employees') {
      const body = await readBody(req);
      if (!body.deviceUserId || !body.name) return json(res, 400, { error: 'deviceUserId and name are required' });
      const deviceUserId = normalizeEnrollmentId(body.deviceUserId);
      const fields = employeeUpdate(body);
      const employee = await Employee.findOneAndUpdate(
        { deviceUserId },
        { deviceUserId, ...fields },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return json(res, 200, { employee });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/employees/')) {
      const id = url.pathname.slice('/api/employees/'.length);
      const body = await readBody(req);
      const employee = await Employee.findByIdAndUpdate(id, employeeUpdate(body), { new: true, runValidators: true });
      if (!employee) return json(res, 404, { error: 'Employee not found' });
      return json(res, 200, { employee });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/employees/')) {
      const id = url.pathname.slice('/api/employees/'.length);
      const result = await Employee.findByIdAndDelete(id);
      if (!result) return json(res, 404, { error: 'Employee not found' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/report') {
      const requested = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return json(res, 400, { error: 'Invalid date' });
      const [year, month, day] = requested.split('-').map(Number);
      const start = new Date(year, month - 1, day);
      const end = new Date(year, month - 1, day + 1);
      const now = new Date();
      const effectiveEnd = now >= start && now < end ? now : end;
      const employee = url.searchParams.get('employee');
      const employeeId = await resolveEnrollmentId(employee);
      const reportQuery = { recordTime: { $gte: start, $lt: end } };
      if (employeeId) reportQuery.deviceUserId = employeeId;
      const [records, nameMap] = await Promise.all([
        Attendance.find(reportQuery).sort({ recordTime: 1 }).lean(),
        employeeNameMap(),
      ]);
      const employees = buildDailyReport(withNames(records, nameMap), effectiveEnd);
      return json(res, 200, {
        date: requested,
        employees,
        totals: {
          employees: employees.length,
          insideNow: employees.filter((employee) => employee.currentStatus === 'INSIDE').length,
          outsideNow: employees.filter((employee) => employee.currentStatus === 'OUTSIDE').length,
          punches: records.length,
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const fromText = url.searchParams.get('from');
      const toText = url.searchParams.get('to');
      const employee = url.searchParams.get('employee');
      if (!fromText || !toText || !/^\d{4}-\d{2}-\d{2}$/.test(fromText) || !/^\d{4}-\d{2}-\d{2}$/.test(toText)) {
        return json(res, 400, { error: 'Valid from and to dates are required' });
      }
      const localDate = (text, nextDay = false) => {
        const [year, month, day] = text.split('-').map(Number);
        return new Date(year, month - 1, day + (nextDay ? 1 : 0));
      };
      const employeeId = await resolveEnrollmentId(employee);
      const query = { recordTime: { $gte: localDate(fromText), $lt: localDate(toText, true) } };
      if (employeeId) query.deviceUserId = employeeId;
      const [records, nameMap] = await Promise.all([
        Attendance.find(query).sort({ recordTime: -1 }).limit(100000).lean(),
        employeeNameMap(),
      ]);
      const namedRecords = withNames(records, nameMap);
      const selectedEmployee = employeeId && employeeId !== '__NOT_FOUND__'
        ? { deviceUserId: employeeId, name: nameMap.get(employeeId) || null }
        : null;
      return json(res, 200, {
        from: fromText,
        to: toText,
        count: records.length,
        summaries: buildRangeSummary(namedRecords, fromText, toText, selectedEmployee),
        records: namedRecords,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if ((process.env.DEVICE_MODE || 'push').toLowerCase() !== 'pull') {
        return json(res, 200, { message: 'Push mode active; waiting for device punches' });
      }
      syncOnce().catch((error) => console.error('[sync]', error.message));
      return json(res, 202, { message: 'Sync started' });
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

async function main() {
  await connectDB();
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        error.message = `Port ${port} is already in use. Stop the other server or set APP_PORT to a different port in .env.`;
      }
      reject(error);
    };

    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      console.log(`[app] http://localhost:${port}`);
      resolve();
    });
  });
  startLogClientServer(Number(process.env.HOST_PC_PORT || 5005));
  if ((process.env.DEVICE_MODE || 'push').toLowerCase() === 'pull') {
    syncOnce().catch((error) => console.error('[sync]', error.message));
    setInterval(() => syncOnce().catch((error) => console.error('[sync]', error.message)), intervalMs);
  }
}
main().catch((error) => { console.error('[fatal]', error.message); process.exit(1); });
