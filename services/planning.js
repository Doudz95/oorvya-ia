const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { normalizeText } = require('../utils/normalize');
const { resolveEmployee } = require('./employee');

const db = getFirestore();

function parsePlanningAction(message, sector) {
  const original = String(message || '').trim();
  const m = normalizeText(original);

  const timeMatch = original.match(/(\d{1,2})\s*h\s*(\d{0,2})\s*(?:a|à|-)\s*(\d{1,2})\s*h\s*(\d{0,2})/i);
  const startTime = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${(timeMatch[2] || '00').padStart(2, '0')}` : '08:00';
  const endTime   = timeMatch ? `${timeMatch[3].padStart(2, '0')}:${(timeMatch[4] || '00').padStart(2, '0')}` : '16:00';

  const JOURS = [['dimanche',0],['lundi',1],['mardi',2],['mercredi',3],['jeudi',4],['vendredi',5],['samedi',6]];
  let dayOfWeek = null;
  for (const [label, value] of JOURS) { if (m.includes(label)) { dayOfWeek = value; break; } }

  const dayNumMatch = original.match(/\b([0-9]{1,2})\b(?!\s*h)/i);
  const specificDayNum = dayNumMatch ? parseInt(dayNumMatch[1]) : null;

  let locationName = 'Non précisé', locationType = 'site';
  if (m.includes('teletravail')) { locationName = 'Télétravail'; locationType = 'remote'; }
  else if (m.includes('bureau')) { locationName = 'Bureau'; locationType = 'office'; }
  else {
    const cm = original.match(/(?:chantier|site|service|caserne|tournee|secteur|depot|entrepot|sur)\s+([A-Za-zÀ-ÿ0-9''\- ]{2,50}?)(?:\s+le\s+|\s+lundi|\s+mardi|\s+mercredi|\s+jeudi|\s+vendredi|\s+samedi|\s+dimanche|\s+de\s+\d|$)/i);
    if (cm) locationName = cm[1].trim();
  }

  let employeeName = 'Membre à préciser';
  const nm = original.match(/(?:ajoute|ajouter|mets|mettre|programme|planifie|affecte|assigne)\s+([A-Za-zÀ-ÿ''\- ]{2,50}?)(?:\s+(?:sur|au|en|le|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|chantier|site|bureau|teletravail|télétravail|tous|tout|ce\s+mois|\d))/i);
  if (nm) employeeName = nm[1].trim();

  const now = new Date(); const dates = [];
  const isRecurring = m.includes('tous les') || m.includes('tout les') || m.includes('toutes les') || m.includes('ce mois');

  if (isRecurring && dayOfWeek !== null) {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    while (d.getMonth() === now.getMonth()) {
      if (d.getDay() === dayOfWeek) dates.push(new Date(d).toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  } else if (specificDayNum && specificDayNum >= 1 && specificDayNum <= 31) {
    let target = new Date(now.getFullYear(), now.getMonth(), specificDayNum);
    if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate()))
      target = new Date(now.getFullYear(), now.getMonth() + 1, specificDayNum);
    dates.push(target.toISOString().slice(0, 10));
  } else if (dayOfWeek !== null) {
    const today = now.getDay(); let diff = dayOfWeek - today;
    if (diff <= 0) diff += 7;
    const next = new Date(now); next.setDate(now.getDate() + diff);
    dates.push(next.toISOString().slice(0, 10));
  } else {
    dates.push(now.toISOString().slice(0, 10));
  }

  return { type: 'planning_add', employeeName, locationName, locationType, startTime, endTime, dates, rawMessage: original, createdFrom: 'ia' };
}

async function preparePlanningAction(companyId, action) {
  const resolved = await resolveEmployee(companyId, action.employeeName);
  if (!resolved.ok) return { ok: false, ...resolved };
  const e = resolved.employee;
  return { ok: true, action: { ...action, employeeName: e.name, employeeUid: e.uid, employeeDocId: e.docId, employeeRole: e.role || '', employeeJob: e.job || '' } };
}

async function executePlanningAdd(companyId, uid, action) {
  if (!action.employeeUid) throw { code: 400, message: 'Employé non résolu.' };
  const batch = db.batch();
  const col = db.collection('companies').doc(companyId).collection('planning');
  const now = FieldValue.serverTimestamp();

  for (const date of action.dates) {
    const [sH, sM] = action.startTime.split(':').map(Number);
    const [eH, eM] = action.endTime.split(':').map(Number);
    const [yr, mo, dy] = date.split('-').map(Number);
    const startDate = new Date(yr, mo - 1, dy, sH, sM, 0);
    let endDate = new Date(yr, mo - 1, dy, eH, eM, 0);
    if (endDate <= startDate) endDate = new Date(endDate.getTime() + 86400000);
    const monthKey = `${yr}-${String(mo).padStart(2, '0')}`;
    const dayKey   = `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    batch.set(col.doc(), {
      title: `${action.employeeName} - ${action.locationName}`,
      assignedTo: action.employeeName, location: action.locationName, siteName: action.locationName,
      status: 'Prévu', shiftType: 'Journée', targetMode: 'Personne',
      planningScope: action.locationType === 'remote' ? 'Télétravail' : action.locationType === 'office' ? 'Bureau' : 'Terrain',
      dateTime: Timestamp.fromDate(startDate), endDateTime: Timestamp.fromDate(endDate),
      dayKey, monthKey, type: 'work', source: 'ia', date,
      startTime: action.startTime, endTime: action.endTime,
      userId: action.employeeUid, uid: action.employeeUid, employeeUid: action.employeeUid,
      teamDocId: action.employeeDocId || null, userName: action.employeeName, employeeName: action.employeeName,
      employeeRole: action.employeeRole || '', employeeJob: action.employeeJob || '',
      locationName: action.locationName, locationType: action.locationType,
      createdBy: uid, createdAt: now, updatedAt: now, rawAiRequest: action.rawMessage,
    });
  }
  await batch.commit();
  return action.dates.length;
}

module.exports = { parsePlanningAction, preparePlanningAction, executePlanningAdd };
