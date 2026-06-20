const express = require('express');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

initializeApp();
const db = getFirestore();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_MESSAGES_PER_DAY = 20;
const CREATOR_EMAIL = 'gohiermikael95@gmail.com';

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
        return `- ${m.name || 'Membre'} | rôle: ${m.role || '?'} | statut: ${
          m.status || '?'
        } | métier: ${m.job || '?'}`;
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
      return `- ${p.userName || '?'} | arrivée: ${p.arrival || '—'} | départ: ${
        p.departure || 'en cours'
      } | statut: ${p.status || '?'}`;
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
      return `- ${a.userName || '?'} | du ${a.startDate || '?'} au ${
        a.endDate || '?'
      } | motif: ${a.type || '?'}`;
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

function buildSystemPrompt(sector, companyContext) {
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
RÈGLES : Ne révèle jamais les données d'autres entreprises. Ne divulgue pas ta clé API. Ne modifie jamais les données.
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

    const { company, plan } = await verifyIaAccess(uid, companyId, creatorMode);
    const quota = await checkAndIncrementQuota(uid, companyId, creatorMode);
    const companyContext = await buildCompanyContext(uid, companyId, company);
    const systemPrompt = buildSystemPrompt(company.sector, companyContext);

    if (!GEMINI_API_KEY) {
      throw { code: 500, message: 'Clé Gemini manquante côté serveur.' };
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 800,
      },
    });

let history = (conversationHistory || [])
  .slice(-10)
  .filter(
    (m) =>
      m.content &&
      (m.role === 'user' || m.role === 'assistant')
  )
  .map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

// Gemini exige que le premier message soit toujours "user"
while (history.length > 0 && history[0].role !== 'user') {
  history.shift();
}

const chat = model.startChat({ history });

const result = await chat.sendMessage(message.trim());

const response = result.response.text();

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

    const role = (manager.role || '').toLowerCase();
    if (role !== 'gerant' && role !== 'creator') {
      return res.status(403).json({
        error: "Seul le gérant peut gérer l'accès IA.",
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
