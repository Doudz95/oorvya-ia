const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { normalizeText } = require('../utils/normalize');

const db = getFirestore();

async function resolveEmployee(companyId, requestedName) {
  const wanted = normalizeText(requestedName);
  if (!wanted || wanted === 'membre a preciser' || wanted.length < 2)
    return { ok: false, reason: "Je n'ai pas compris le nom de la personne.", suggestions: [] };

  const candidates = [];

  function addCandidate(doc, source) {
    const data = doc.data() || {};
    const fullName = (data.name || data.fullName || data.displayName ||
      `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || '').trim();
    if (!fullName) return;
    if (data.excluded === true || data.archived === true || data.deleted === true) return;
    if (normalizeText(data.role || '') === 'blocked' || normalizeText(data.status || '') === 'blocked') return;
    candidates.push({
      source, docId: doc.id, uid: data.uid || data.userId || doc.id,
      name: fullName, normalizedName: normalizeText(fullName),
      email: data.email || '', role: data.role || '', status: data.status || '', job: data.job || data.metier || '',
    });
  }

  try { const s = await db.collection('companies').doc(companyId).collection('teams').limit(200).get(); for (const d of s.docs) addCandidate(d, 'teams'); } catch (_) {}
  try { const s = await db.collection('users').where('companyId', '==', companyId).limit(200).get(); for (const d of s.docs) addCandidate(d, 'users'); } catch (_) {}

  const seen = new Set(); const unique = [];
  for (const c of candidates) { const k = c.uid || `${c.source}:${c.docId}`; if (!seen.has(k)) { seen.add(k); unique.push(c); } }

  let matches = unique.filter(c => c.normalizedName === wanted);
  if (!matches.length) matches = unique.filter(c => c.normalizedName.startsWith(wanted) || wanted.startsWith(c.normalizedName));
  if (!matches.length) matches = unique.filter(c => c.normalizedName.includes(wanted) || wanted.includes(c.normalizedName));
  if (!matches.length) { const words = wanted.split(' ').filter(w => w.length >= 2); matches = unique.filter(c => words.length > 0 && words.every(w => c.normalizedName.includes(w))); }

  if (matches.length === 1) return { ok: true, employee: matches[0] };
  if (matches.length > 1) return { ok: false, reason: `Plusieurs personnes correspondent à "${requestedName}". Précisez le nom complet.`, suggestions: matches.slice(0, 5).map(m => `${m.name}${m.role ? ` (${m.role})` : ''}`) };
  return { ok: false, reason: `Aucun employé nommé "${requestedName}" trouvé.`, suggestions: unique.slice(0, 8).map(m => `${m.name}${m.role ? ` (${m.role})` : ''}`) };
}

async function executeEmployeeUpdate(companyId, uid, action) {
  const resolved = await resolveEmployee(companyId, action.employeeName);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, suggestions: resolved.suggestions };
  const e = resolved.employee;
  await db.collection('companies').doc(companyId).collection('teams').doc(e.docId)
    .set({ ...action.updates, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
  try { await db.collection('users').doc(e.uid).set({ ...action.updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); } catch (_) {}
  return { ok: true, name: e.name };
}

module.exports = { resolveEmployee, executeEmployeeUpdate };
