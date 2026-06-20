const express = require('express');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '1mb' }));

initializeApp();
const db = getFirestore();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_MESSAGES_PER_DAY = 20;
const CREATOR_EMAIL = 'gohiermikael95@gmail.com';

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function normalizeRole(role) {
  return normalizeText(role).replace(/\s+/g, '');
}

function canRoleEditPlanning(role, isCreator = false) {
  if (isCreator === true) return true;
  const r = normalizeRole(role);
  return (
    r === 'gerant' ||
    r === 'gérant' ||
    r === 'rh' ||
    r === 'ressourceshumaines' ||
    r === 'responsablerh' ||
    r === 'adminrh'
  );
}

function isPlanningModificationRequest(message) {
  const m = normalizeText(message);
  return (
    (m.includes('ajoute') || m.includes('ajouter') || m.includes('mets') || m.includes('mettre') || m.includes('programme') || m.includes('planifie')) &&
    (m.includes('planning') || m.includes('teletravail') || m.includes('chantier') || m.includes('bureau') || m.includes('horaire') || m.includes('jeudi') || m.includes('lundi') || m.includes('mardi') || m.includes('mercredi') || m.includes('vendredi') || m.includes('samedi') || m.includes('dimanche'))
  );
}

function isConfirmationMessage(message) {
  const m = normalizeText(message);
  return ['oui', 'ok', 'confirme', 'je confirme', 'valide', 'vas y', 'vasi', 'go'].includes(m);
}

function extractPendingPlanningAction(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const content = String(history[i]?.content || '');
    const match = content.match(/ACTION_PLANNING_JSON:({[\s\S]*?})\s*$/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function parsePlanningAction(message) {
  const original = String(message || '').trim();
  const m = normalizeText(original);

  const timeMatch = original.match(/(\d{1,2})\s*h\s*(\d{0,2})\s*(?:a|à|-)\s*(\d{1,2})\s*h\s*(\d{0,2})/i);
  const startTime = timeMatch
    ? `${timeMatch[1].padStart(2, '0')}:${(timeMatch[2] || '00').padStart(2, '0')}`
    : '08:00';
  const endTime = timeMatch
    ? `${timeMatch[3].padStart(2, '0')}:${(timeMatch[4] || '00').padStart(2, '0')}`
    : '16:00';

  let dayOfWeek = null;
  const days = [
    ['lundi', 1],
    ['mardi', 2],
    ['mercredi', 3],
    ['jeudi', 4],
    ['vendredi', 5],
    ['samedi', 6],
    ['dimanche', 0],
  ];
  for (const [label, value] of days) {
    if (m.includes(label)) dayOfWeek = value;
  }

  let locationName = 'Non précisé';
  let locationType = 'site';
  if (m.includes('teletravail')) {
    locationName = 'Télétravail';
    locationType = 'remote';
  } else {
    const chantierMatch = original.match(/(?:chantier|sur)\s+([A-Za-zÀ-ÿ0-9' -]{2,40})/i);
    if (chantierMatch) locationName = chantierMatch[1].trim();
  }

  let employeeName = 'Membre à préciser';
  const nameMatch = original.match(/(?:ajoute|ajouter|mets|mettre|programme|planifie)\s+([A-Za-zÀ-ÿ' -]{2,60}?)(?:\s+sur\s+le\s+planning|\s+tous|\s+ce\s+mois|\s+en\s+|\s+de\s+\d|$)/i);
  if (nameMatch) employeeName = nameMatch[1].trim();

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const dates = [];

  if (dayOfWeek !== null && (m.includes('ce mois') || m.includes('tous les') || m.includes('tout les'))) {
    const d = new Date(year, month, 1);
    while (d.getMonth() === month) {
      if (d.getDay() === dayOfWeek) dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  } else {
    dates.push(now.toISOString().slice(0, 10));
  }

  return {
    type: 'planning_add',
    rawMessage: original,
    employeeName,
    locationName,
    locationType,
    startTime,
    endTime,
    dates,
    createdFrom: 'ia',
  };
}

function buildPlanningConfirmation(action) {
  const datesText = action.dates.length > 1
    ? `${action.dates.length} jour(s) : ${action.dates.join(', ')}`
    : action.dates[0];

  return `✅ J'ai préparé la modification du planning.\n\n` +
    `Personne : ${action.employeeName}\n` +
    `Lieu : ${action.locationName}\n` +
    `Horaire : ${action.startTime} - ${action.endTime}\n` +
    `Date(s) : ${datesText}\n\n` +
    `Confirmez-vous l'ajout dans le planning ? Répondez simplement : OUI\n\n` +
    `ACTION_PLANNING_JSON:${JSON.stringify(action)}`;
}

async function createPlanningEntries({ companyId, uid, action }) {
  const batch = db.batch();
  const col = db.collection('companies').doc(companyId).collection('planning');
  const now = FieldValue.serverTimestamp();

  for (const date of action.dates) {
    const ref = col.doc();
    batch.set(ref, {
      type: 'work',
      status: 'planned',
      source: 'ia',
      title: `${action.employeeName} - ${action.locationName}`,
      userName: action.employeeName,
      employeeName: action.employeeName,
      locationName: action.locationName,
      siteName: action.locationName,
      locationType: action.locationType,
      date,
      startTime: action.startTime,
      endTime: action.endTime,
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
      rawAiRequest: action.rawMessage,
    });
  }

  await batch.commit();
  return action.dates.length;
}

async function verifyIaAccess(uid, companyId, isCreator = false) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) throw { code: 404, message: 'Utilisateur introuvable.' };

  const user = userSnap.data();

  const companySnap = await db.collection('companies').doc(companyId).get();
  if (!companySnap.exists) throw { code: 404, message: 'Entreprise introuvable.' };

  const company = companySnap.data();
  const plan = (company.plan || 'Free').toLowerCase();

  if (isCreator === true) {
    return { user, company, plan };
  }

  if (user.companyId !== companyId) {
    throw { code: 403, message: 'Accès refusé.' };
  }

  if (user.role === 'pending' || user.role === 'blocked') {
    throw { code: 403, message: 'Accès refusé.' };
  }

  if (plan === 'free' || plan === 'gratuit') {
    throw { code: 403, message: "L'IA OORVYA nécessite un forfait Micro ou PME." };
  }

  const iaSnap = await db
    .collection('companies')
    .doc(companyId)
    .collection('ia_access')
    .doc(uid)
    .get();

  if (!iaSnap.exists || iaSnap.data().enabled !== true) {
    throw {
      code: 403,
      message: "L'IA n'est pas activée pour votre compte. Contactez votre responsable.",
    };
  }

  return { user, company, plan };
}

async function checkAndIncrementQuota(uid, companyId, isCreator = false) {
  if (isCreator === true) {
    return { used: 0, limit: -1, remaining: -1 };
  }

  const today = new Date().toISOString().slice(0, 10);
  const quotaRef = db
    .collection('companies')
    .doc(companyId)
    .collection('ia_quotas')
    .doc(`${uid}_${today}`);

  const quotaSnap = await quotaRef.get();
  const current = quotaSnap.exists ? quotaSnap.data().count || 0 : 0;

  if (current >= MAX_MESSAGES_PER_DAY) {
    throw {
      code: 429,
      message: `Limite atteinte : ${MAX_MESSAGES_PER_DAY} messages IA par jour.`,
    };
  }

  await quotaRef.set(
    {
      uid,
      companyId,
      date: today,
      count: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    used: current + 1,
    limit: MAX_MESSAGES_PER_DAY,
    remaining: MAX_MESSAGES_PER_DAY - (current + 1),
  };
}

async function buildCompanyContext(uid, companyId, company) {
  const today = new Date().toISOString().slice(0, 10);
  const todayDisplay = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  let teamLines = '';
  try {
    const teamSnap = await db
      .collection('companies')
      .doc(companyId)
      .collection('teams')
      .where('excluded', '==', false)
      .limit(50)
      .get();

    teamLines = teamSnap.docs
      .map((d) => {
        const m = d.data();
        return `- ${m.name || 'Membre'} | rôle: ${m.role || '?'} | statut: ${m.status || '?'} | métier: ${m.job || '?'}`;
      })
      .join('\n');
  } catch (_) {
    teamLines = '(indisponible)';
  }

  let pointageLines = '';
  try {
    const ptSnap = await db
      .collection('companies')
      .doc(companyId)
      .collection('pointages')
      .where('date', '==', today)
      .limit(60)
      .get();

    const pts = ptSnap.docs.map((d) => {
      const p = d.data();
      return `- ${p.userName || '?'} | arrivée: ${p.arrival || '—'} | départ: ${p.departure || 'en cours'} | statut: ${p.status || '?'}`;
    });

    pointageLines = pts.length > 0 ? pts.join('\n') : "Aucun pointage aujourd'hui.";
  } catch (_) {
    pointageLines = '(indisponible)';
  }

  let absenceLines = '';
  try {
    const absSnap = await db
      .collection('companies')
      .doc(companyId)
      .collection('absences')
      .where('status', '==', 'approved')
      .where('endDate', '>=', today)
      .limit(20)
      .get();

    const abs = absSnap.docs.map((d) => {
      const a = d.data();
      return `- ${a.userName || '?'} | du ${a.startDate || '?'} au ${a.endDate || '?'} | motif: ${a.type || '?'}`;
    });

    absenceLines = abs.length > 0 ? abs.join('\n') : 'Aucune absence en cours.';
  } catch (_) {
    absenceLines = '(indisponible)';
  }

  let siteLines = '';
  try {
    const siteSnap = await db
      .collection('companies')
      .doc(companyId)
      .collection('sites')
      .where('active', '==', true)
      .limit(20)
      .get();

    const sites = siteSnap.docs.map((d) => {
      const s = d.data();
      return `- ${s.name || '?'} | adresse: ${s.address || '?'}`;
    });

    siteLines = sites.length > 0 ? sites.join('\n') : 'Aucun site actif.';
  } catch (_) {
    siteLines = '(indisponible)';
  }

  return `=== CONTEXTE ENTREPRISE ===
Date : ${todayDisplay}
Entreprise : ${company.name || companyId}
Secteur : ${company.sector || 'général'}
Forfait : ${company.plan || 'Free'}

=== ÉQUIPE ===
${teamLines}

=== POINTAGES DU JOUR ===
${pointageLines}

=== ABSENCES EN COURS ===
${absenceLines}

=== SITES ACTIFS ===
${siteLines}`;
}

function buildSystemPrompt(sector, companyContext, canEditPlanning, userRole) {
  const sectorVocab = {
    btp: 'chantiers, ouvriers, sous-traitants, coulages, réserves',
    securite: 'sites surveillés, agents, rondes, incidents',
    medical: 'patients, soignants, gardes, vacations',
    transport: 'tournées, chauffeurs, véhicules, livraisons',
    nettoyage: 'sites, agents, interventions, bons de prestation',
    pompiers: 'casernes, gardes, interventions, équipages',
    industrie: 'ateliers, opérateurs, production, maintenance',
    commerce: 'magasins, vendeurs, horaires, inventaires',
    logistique: 'entrepôts, caristes, expéditions',
  };

  const vocab = sectorVocab[sector?.toLowerCase()] || 'équipes, collaborateurs, planning';

  return `Tu es l'assistant IA intégré à OORVYA pour cette entreprise.
Tu parles UNIQUEMENT en français sauf si l'utilisateur utilise une autre langue.
Secteur : ${sector || 'général'} — vocabulaire : ${vocab}
Rôle utilisateur : ${userRole || 'non précisé'}
Autorisation modification planning : ${canEditPlanning ? 'OUI' : 'NON'}

RÈGLES DE SÉCURITÉ :
- Ne révèle jamais les données d'autres entreprises.
- Ne divulgue jamais ta clé API.
- Seuls le gérant, les RH et le créateur peuvent modifier le planning.
- Les autres rôles peuvent consulter et demander des résumés, mais ne peuvent pas modifier les données.
- Pour les modifications de planning, prépare toujours clairement l'action avant confirmation.
- L'écriture réelle dans Firestore est gérée par OORVYA après confirmation.

CONTEXTE EN TEMPS RÉEL :
${companyContext}

Réponds de façon claire, structurée et utile.`;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OORVYA IA' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/askIA', async (req, res) => {
  try {
    const { uid, message, companyId, conversationHistory, isCreator } = req.body;

    if (!uid) return res.status(401).json({ error: 'uid manquant.' });
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message vide.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message trop long.' });
    }
    if (!companyId) {
      return res.status(400).json({ error: 'companyId manquant.' });
    }

    const creatorMode = isCreator === true;

    const { user, company, plan } = await verifyIaAccess(uid, companyId, creatorMode);
    const quota = await checkAndIncrementQuota(uid, companyId, creatorMode);
    const userRole = user?.role || (creatorMode ? 'creator' : '');
    const canEditPlanning = canRoleEditPlanning(userRole, creatorMode);

    if (isConfirmationMessage(message)) {
      const pendingAction = extractPendingPlanningAction(conversationHistory || []);
      if (pendingAction && pendingAction.type === 'planning_add') {
        if (!canEditPlanning) {
          return res.json({
            response: "⛔ Vous n'avez pas l'autorisation de modifier le planning. Cette action est réservée au gérant, aux RH et au créateur.",
            quota,
          });
        }

        const createdCount = await createPlanningEntries({ companyId, uid, action: pendingAction });
        return res.json({
          response: `✅ C'est fait. J'ai ajouté ${createdCount} entrée(s) dans le planning pour ${pendingAction.employeeName}.`,
          quota,
        });
      }
    }

    if (isPlanningModificationRequest(message)) {
      if (!canEditPlanning) {
        return res.json({
          response: "⛔ La modification du planning est réservée au gérant, aux RH et au créateur. Je peux vous aider à consulter le planning, mais je ne peux pas le modifier avec votre rôle actuel.",
          quota,
        });
      }

      const action = parsePlanningAction(message);
      return res.json({
        response: buildPlanningConfirmation(action),
        quota,
      });
    }

    const companyContext = await buildCompanyContext(uid, companyId, company);
    const systemPrompt = buildSystemPrompt(company.sector, companyContext, canEditPlanning, userRole);

    if (!GEMINI_API_KEY) {
      throw { code: 500, message: 'Clé Gemini manquante côté serveur.' };
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-flash-latest',
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 800,
      },
    });

    let history = (conversationHistory || [])
      .slice(-10)
      .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    while (history.length > 0 && history[0].role !== 'user') {
      history.shift();
    }

    const chat = model.startChat({ history });

    let response;

    try {
      const result = await chat.sendMessage(message.trim());
      response = result.response.text();
    } catch (e) {
      console.error('Erreur Gemini :', e);

      if (String(e).includes('503')) {
        return res.json({
          response: "⚠️ L'assistant IA OORVYA est momentanément très sollicité. Veuillez réessayer dans quelques secondes.",
          quota,
        });
      }

      if (String(e).includes('429')) {
        return res.json({
          response: "⚠️ Le quota gratuit de l'assistant IA a été atteint temporairement. Veuillez réessayer plus tard.",
          quota,
        });
      }

      throw e;
    }

    await db.collection('companies').doc(companyId).collection('ia_logs').add({
      uid,
      timestamp: FieldValue.serverTimestamp(),
      messageLength: message.length,
      responseLength: response.length,
      plan,
      quotaUsed: quota.used,
      isCreator: creatorMode,
    });

    return res.json({
      response,
      quota,
    });
  } catch (err) {
    console.error(err);
    return res.status(err.code || 500).json({
      error: err.message || 'Erreur serveur.',
    });
  }
});

app.post('/toggleIaAccess', async (req, res) => {
  try {
    const { managerUid, targetUid, companyId, enabled } = req.body;

    const managerSnap = await db.collection('users').doc(managerUid).get();
    if (!managerSnap.exists) {
      return res.status(404).json({ error: 'Gérant introuvable.' });
    }

    const manager = managerSnap.data();

    if (manager.companyId !== companyId) {
      return res.status(403).json({ error: 'Accès refusé.' });
    }

    const role = normalizeRole(manager.role);
    if (role !== 'gerant' && role !== 'rh' && role !== 'creator') {
      return res.status(403).json({
        error: "Seul le gérant, les RH ou le créateur peuvent gérer l'accès IA.",
      });
    }

    const companySnap = await db.collection('companies').doc(companyId).get();
    const plan = (companySnap.data()?.plan || 'Free').toLowerCase();

    if (plan === 'free' || plan === 'gratuit') {
      return res.status(400).json({ error: 'Forfait Free — IA non disponible.' });
    }

    await db
      .collection('companies')
      .doc(companyId)
      .collection('ia_access')
      .doc(targetUid)
      .set(
        {
          uid: targetUid,
          enabled: enabled === true,
          enabledBy: managerUid,
          pricePerMonth: 3,
          dailyLimit: MAX_MESSAGES_PER_DAY,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    return res.json({
      success: true,
      enabled: enabled === true,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`OORVYA IA server running on port ${PORT}`);
});
