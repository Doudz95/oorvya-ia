const express = require('express');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = express();
app.use(express.json({ limit: '2mb' }));

initializeApp();

// Services
const { verifyIaAccess, checkAndIncrementQuota, toggleIaAccess } = require('./services/access');
const { canRoleEdit, canRoleManage } = require('./utils/normalize');
const { detectIntent, extractPendingAction, buildConfirmationMessage, parseSiteAction, parseNewsAction, parseEmployeeUpdate, executeSiteCreate, executeNewsPublish } = require('./services/actions');
const { parsePlanningAction, preparePlanningAction, executePlanningAdd } = require('./services/planning');
const { executeEmployeeUpdate, resolveEmployee } = require('./services/employee');
const { buildCompanyContext, buildSystemPrompt, saveToHistory, loadTodayHistory } = require('./services/context');
const { callGemini } = require('./services/groq');

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', service: 'OORVYA IA V14' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/askIA', async (req, res) => {
  try {
    const { uid, message, companyId, conversationHistory, isCreator } = req.body;

    if (!uid)                              return res.status(401).json({ error: 'uid manquant.' });
    if (!message || !message.trim())       return res.status(400).json({ error: 'Message vide.' });
    if (message.length > 2000)             return res.status(400).json({ error: 'Message trop long.' });
    if (!companyId)                        return res.status(400).json({ error: 'companyId manquant.' });

    const creatorMode = isCreator === true;
    const { user, company, plan, isOwner } = await verifyIaAccess(uid, companyId, creatorMode);
    const quota      = await checkAndIncrementQuota(uid, companyId, creatorMode, isOwner);
    const userRole   = user?.role || (creatorMode ? 'creator' : '');
    const canEdit    = canRoleEdit(userRole, creatorMode || isOwner);
    const canManage  = canRoleManage(userRole, creatorMode || isOwner);
    const userName   = user?.name || user?.displayName || 'Utilisateur';
    const isPriv     = creatorMode || isOwner;

    await saveToHistory(companyId, uid, 'user', message, isPriv);

    const intent = detectIntent(message);

    // ── CONFIRMATION ──────────────────────────────────────────────────────────
    if (intent === 'confirmation') {
      const pending = extractPendingAction(conversationHistory || []);
      if (pending) {
        if (!canEdit && !canManage)
          return res.json({ response: "⛔ Vous n'avez pas l'autorisation d'effectuer cette action.", quota });

        let response = '';

        if (pending.type === 'planning_add') {
          const resolved = await resolveEmployee(companyId, pending.employeeName);
          if (!resolved.ok) {
            response = `⚠️ ${resolved.reason}${resolved.suggestions?.length ? '\n\nEmployés : ' + resolved.suggestions.join(', ') : ''}`;
          } else {
            pending.employeeUid   = resolved.employee.uid;
            pending.employeeDocId = resolved.employee.docId;
            pending.employeeRole  = resolved.employee.role || '';
            pending.employeeJob   = resolved.employee.job  || '';
            pending.employeeName  = resolved.employee.name;
            const count = await executePlanningAdd(companyId, uid, pending);
            response = `✅ Planning mis à jour ! ${count} entrée(s) ajoutée(s) pour ${pending.employeeName}.`;
          }
        } else if (pending.type === 'site_create') {
          const name = await executeSiteCreate(companyId, uid, userName, company.sector, pending);
          response = `✅ ${pending.placeType} "${name}" créé avec succès !`;
        } else if (pending.type === 'news_publish') {
          await executeNewsPublish(companyId, uid, userName, company.sector, pending);
          response = `✅ Actualité "${pending.title}" publiée pour toute l'entreprise !`;
        } else if (pending.type === 'employee_update') {
          const result = await executeEmployeeUpdate(companyId, uid, pending);
          response = result.ok
            ? `✅ Profil de ${result.name} mis à jour !`
            : `⚠️ ${result.reason}${result.suggestions?.length ? '\n\nEmployés : ' + result.suggestions.join(', ') : ''}`;
        }

        await saveToHistory(companyId, uid, 'assistant', response, isPriv);
        return res.json({ response, quota });
      }
    }

    // ── PLANNING ──────────────────────────────────────────────────────────────
    if (intent === 'planning_add') {
      if (!canEdit) return res.json({ response: '⛔ La modification du planning est réservée au gérant et aux RH.', quota });
      const action = parsePlanningAction(message, company.sector);
      const prepared = await preparePlanningAction(companyId, action);
      let response;
      if (!prepared.ok) {
        response = `⚠️ ${prepared.reason}${prepared.suggestions?.length ? '\n\nEmployés disponibles :\n- ' + prepared.suggestions.join('\n- ') : ''}`;
      } else {
        response = buildConfirmationMessage(prepared.action);
      }
      await saveToHistory(companyId, uid, 'assistant', response, isPriv);
      return res.json({ response, quota });
    }

    // ── SITE ──────────────────────────────────────────────────────────────────
    if (intent === 'site_create') {
      if (!canManage) return res.json({ response: '⛔ La création de sites est réservée au gérant.', quota });
      const action = parseSiteAction(message, company.sector);
      const response = buildConfirmationMessage(action);
      await saveToHistory(companyId, uid, 'assistant', response, isPriv);
      return res.json({ response, quota });
    }

    // ── ACTUALITÉ — reformulation via Groq ────────────────────────────────────
    if (intent === 'news_publish') {
      if (!canManage) return res.json({ response: "⛔ La publication d'actualités est réservée au gérant.", quota });

      let title = '';
      let msgContent = '';

      try {
        const reformulation = await callGemini(
          `Tu es un assistant RH professionnel pour une entreprise du secteur "${company.sector || 'général'}".
Reformule l'idée d'annonce suivante en une communication interne professionnelle, chaleureuse et bien rédigée.
Ne répète jamais mot pour mot ce que l'utilisateur a écrit.
Réponds UNIQUEMENT dans ce format exact, sans rien d'autre :
TITRE: [titre court et accrocheur]
MESSAGE: [message complet bien rédigé en 2-3 phrases]`,
          message,
          []
        );
        const titreMatch = reformulation.match(/TITRE:\s*(.+)/i);
        const msgMatch   = reformulation.match(/MESSAGE:\s*([\s\S]+)/i);
        if (titreMatch) title      = titreMatch[1].trim();
        if (msgMatch)   msgContent = msgMatch[1].trim();
      } catch(_) {}

      // Fallback si Groq échoue
      if (!title || !msgContent) {
        const fallback = parseNewsAction(message);
        title      = fallback.title;
        msgContent = fallback.message;
      }

      const action = { type: 'news_publish', title, message: msgContent, rawMessage: message, createdFrom: 'ia' };
      const response = buildConfirmationMessage(action);
      await saveToHistory(companyId, uid, 'assistant', response, isPriv);
      return res.json({ response, quota });
    }

    // ── MODIFIER EMPLOYÉ ──────────────────────────────────────────────────────
    if (intent === 'employee_update') {
      if (!canManage) return res.json({ response: '⛔ La modification des employés est réservée au gérant.', quota });
      const action = parseEmployeeUpdate(message);
      const resolved = await resolveEmployee(companyId, action.employeeName);
      let response;
      if (!resolved.ok) {
        response = `⚠️ ${resolved.reason}${resolved.suggestions?.length ? '\n\nEmployés disponibles :\n- ' + resolved.suggestions.join('\n- ') : ''}`;
      } else {
        action.employeeName = resolved.employee.name;
        response = buildConfirmationMessage(action);
      }
      await saveToHistory(companyId, uid, 'assistant', response, isPriv);
      return res.json({ response, quota });
    }

    // ── QUESTION GÉNÉRALE → GROQ ──────────────────────────────────────────────
    const [companyContext, todayHistory] = await Promise.all([
      buildCompanyContext(uid, companyId, company),
      loadTodayHistory(companyId, uid),
    ]);
    const systemPrompt = buildSystemPrompt(company.sector, companyContext, canEdit, userRole);

    let history = todayHistory.length > 0
      ? todayHistory.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      : (conversationHistory || []).slice(-10)
          .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    while (history.length > 0 && history[0].role !== 'user') history.shift();

    let response;
    try {
      response = await callGemini(systemPrompt, message, history);
    } catch (e) {
      console.error('Erreur Groq:', e);
      response = "Je rencontre une petite difficulté technique. Votre demande est bien reçue — réessayez dans quelques secondes.";
    }

    await Promise.all([
      saveToHistory(companyId, uid, 'assistant', response, isPriv),
      getFirestore().collection('companies').doc(companyId).collection('ia_logs').add({
        uid, timestamp: FieldValue.serverTimestamp(),
        messageLength: message.length, responseLength: response.length,
        plan, quotaUsed: quota.used, isCreator: isPriv,
      }),
    ]);

    return res.json({ response, quota });
  } catch (err) {
    console.error(err);
    return res.status(err.code || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

app.post('/toggleIaAccess', async (req, res) => {
  try {
    const { managerUid, targetUid, companyId, enabled } = req.body;
    const result = await toggleIaAccess(managerUid, targetUid, companyId, enabled);
    return res.json(result);
  } catch (err) {
    return res.status(err.code || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

app.post('/getHistory', async (req, res) => {
  try {
    const { uid, companyId, isCreator } = req.body;
    if (!uid || !companyId) return res.status(400).json({ error: 'Paramètres manquants.' });
    await verifyIaAccess(uid, companyId, isCreator === true);
    const history = await loadTodayHistory(companyId, uid);
    return res.json({ history });
  } catch (err) {
    return res.status(err.code || 500).json({ error: err.message || 'Erreur.' });
  }
});

// ─── DÉMARRAGE (Render) ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`OORVYA IA V14 – running on port ${PORT}`); });
