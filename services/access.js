const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { normalizeRole } = require('../utils/normalize');

const db = getFirestore();
const MAX_MESSAGES_PER_DAY = 20;

async function verifyIaAccess(uid, companyId, isCreator = false) {
  const companySnap = await db.collection('companies').doc(companyId).get();
  if (!companySnap.exists) throw { code: 404, message: 'Entreprise introuvable.' };
  const company = companySnap.data();
  const plan = (company.plan || 'Free').toLowerCase();

  if (isCreator) return { user: { uid, role: 'creator' }, company, plan, isOwner: false };
  if (company.ownerUid === uid) return { user: { uid, role: 'creator' }, company, plan, isOwner: true };

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) throw { code: 404, message: 'Utilisateur introuvable.' };
  const user = userSnap.data();

  if (user.companyId !== companyId) throw { code: 403, message: 'Accès refusé.' };
  if (user.role === 'pending' || user.role === 'blocked') throw { code: 403, message: 'Accès refusé.' };
  if (plan === 'free' || plan === 'gratuit') throw { code: 403, message: "L'IA OORVYA nécessite un forfait Micro ou PME." };

  const iaSnap = await db.collection('companies').doc(companyId).collection('ia_access').doc(uid).get();
  if (!iaSnap.exists || iaSnap.data().enabled !== true)
    throw { code: 403, message: "L'IA n'est pas activée pour votre compte." };

  return { user, company, plan, isOwner: false };
}

async function checkAndIncrementQuota(uid, companyId, isCreator = false, isOwner = false) {
  if (isCreator || isOwner) return { used: 0, limit: -1, remaining: -1 };
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection('companies').doc(companyId).collection('ia_quotas').doc(`${uid}_${today}`);
  const snap = await ref.get();
  const current = snap.exists ? snap.data().count || 0 : 0;
  if (current >= MAX_MESSAGES_PER_DAY)
    throw { code: 429, message: `Limite atteinte : ${MAX_MESSAGES_PER_DAY} messages IA par jour.` };
  await ref.set({ uid, companyId, date: today, count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { used: current + 1, limit: MAX_MESSAGES_PER_DAY, remaining: MAX_MESSAGES_PER_DAY - (current + 1) };
}

async function toggleIaAccess(managerUid, targetUid, companyId, enabled) {
  const managerSnap = await db.collection('users').doc(managerUid).get();
  if (!managerSnap.exists) throw { code: 404, message: 'Gérant introuvable.' };
  const manager = managerSnap.data();
  if (manager.companyId !== companyId) throw { code: 403, message: 'Accès refusé.' };
  const role = normalizeRole(manager.role);
  if (!['gerant', 'rh', 'creator', 'admin'].includes(role))
    throw { code: 403, message: "Seul le gérant peut gérer l'accès IA." };
  const companySnap = await db.collection('companies').doc(companyId).get();
  const plan = (companySnap.data()?.plan || 'Free').toLowerCase();
  if (plan === 'free' || plan === 'gratuit') throw { code: 400, message: 'Forfait Free — IA non disponible.' };
  await db.collection('companies').doc(companyId).collection('ia_access').doc(targetUid).set(
    { uid: targetUid, enabled: enabled === true, enabledBy: managerUid, pricePerMonth: 3, dailyLimit: MAX_MESSAGES_PER_DAY, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { success: true, enabled: enabled === true };
}

module.exports = { verifyIaAccess, checkAndIncrementQuota, toggleIaAccess, MAX_MESSAGES_PER_DAY };
