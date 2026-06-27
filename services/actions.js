const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { normalizeText } = require('../utils/normalize');
const { getPlaceType } = require('../utils/sector');

const db = getFirestore();

function detectIntent(message) {
  const m = normalizeText(message);
  if ((m.includes('ajoute') || m.includes('ajouter') || m.includes('mets') || m.includes('programme') ||
       m.includes('planifie') || m.includes('affecte') || m.includes('assigne')) &&
      (m.includes('planning') || m.includes('teletravail') || m.includes('chantier') || m.includes('bureau') ||
       m.includes('site') || m.includes('lundi') || m.includes('mardi') || m.includes('mercredi') ||
       m.includes('jeudi') || m.includes('vendredi') || m.includes('samedi') || m.includes('dimanche')))
    return 'planning_add';
  if ((m.includes('cree') || m.includes('creer') || m.includes('nouveau') || m.includes('nouvelle') || m.includes('ouvre')) &&
      (m.includes('chantier') || m.includes('site') || m.includes('service') || m.includes('caserne') ||
       m.includes('tournee') || m.includes('secteur') || m.includes('depot') || m.includes('entrepot') ||
       m.includes('boutique') || m.includes('etablissement') || m.includes('intervention')))
    return 'site_create';
  if ((m.includes('publie') || m.includes('publier') || m.includes('poste') || m.includes('ecris') ||
       m.includes('annonce') || m.includes('dis a') || m.includes('previens') || m.includes('informe') || m.includes('dire')) &&
      (m.includes('actualite') || m.includes('annonce') || m.includes('information') || m.includes('news') ||
       m.includes('equipe') || m.includes('tout le monde') || m.includes('employe') || m.includes('personnel')))
    return 'news_publish';
  if ((m.includes('envoie') || m.includes('envoyer') || m.includes('dis') || m.includes('previens')) &&
      (m.includes('message') || m.includes('groupe') || m.includes('equipe')))
    return 'message_send';
  if ((m.includes('modifie') || m.includes('change') || m.includes('met a jour') || m.includes('mets a jour')) &&
      (m.includes('employe') || m.includes('membre') || m.includes('agent') || m.includes('role') ||
       m.includes('poste') || m.includes('metier') || m.includes('statut')))
    return 'employee_update';
  const confirmWords = ['oui', 'ok', 'confirme', 'je confirme', 'valide', 'vas y', 'vasi', 'go', 'd accord', 'dacord'];
  if (confirmWords.includes(m)) return 'confirmation';
  return 'question';
}

function extractPendingAction(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const content = String(history[i]?.content || '');
    const match = content.match(/OORVYA_ACTION_JSON:({[\s\S]*?})\s*$/) ||
                  content.match(/ACTION_PLANNING_JSON:({[\s\S]*?})\s*$/);
    if (match) { try { return JSON.parse(match[1]); } catch (_) { return null; } }
  }
  return null;
}

function buildConfirmationMessage(action) {
  const exclude = ['type', 'createdFrom', 'rawMessage'];
  const labels = {
    employeeName:'Personne', locationName:'Lieu', locationType:'Type de lieu',
    startTime:'Début', endTime:'Fin', dates:'Date(s)', name:'Nom', address:'Adresse',
    placeType:'Type', manager:'Responsable', description:'Description',
    title:'Titre', message:'Message', updates:'Modifications',
  };
  let lines = '✅ Action préparée — vérifiez et confirmez :\n\n';
  for (const [k, v] of Object.entries(action)) {
    if (exclude.includes(k) || v === null || v === undefined || v === '' || v === 'Membre à préciser') continue;
    const label = labels[k] || k;
    if (Array.isArray(v)) lines += `${label} : ${v.join(', ')}\n`;
    else if (typeof v === 'object') lines += `${label} : ${Object.entries(v).map(([a,b])=>`${a}=${b}`).join(', ')}\n`;
    else lines += `${label} : ${v}\n`;
  }
  lines += '\nRépondez simplement : OUI\n\nOORVYA_ACTION_JSON:' + JSON.stringify(action);
  return lines;
}

function parseSiteAction(message, sector) {
  const original = String(message || '').trim();
  const nameMatch = original.match(/(?:cree|creer|ajoute|nouveau|nouvelle|ouvre)\s+(?:un|une|le|la)?\s*(?:chantier|site|service|caserne|tournee|secteur|depot|entrepot|boutique|etablissement)?\s+([A-Za-zÀ-ÿ0-9''\- ]{2,80}?)(?:\s+a\s+|\s+au\s+|\s+à\s+|\s+adresse|\s+description|$)/i);
  const addrMatch = original.match(/(?:a|à|au|adresse[:\s]+)\s+([A-Za-zÀ-ÿ0-9°''\-,\. ]{5,150}?)(?:\s+manager|\s+responsable|\s+telephone|$)/i);
  const managerMatch = original.match(/(?:responsable|manager)[:\s]+([A-Za-zÀ-ÿ''\- ]{2,60}?)(?:\s|$)/i);
  const descMatch = original.match(/(?:description|details|note)[:\s]+([A-Za-zÀ-ÿ0-9''\-,\. ]{2,200}?)$/i);
  return {
    type: 'site_create', name: nameMatch ? nameMatch[1].trim() : 'Nouveau site',
    address: addrMatch ? addrMatch[1].trim() : '', manager: managerMatch ? managerMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '', placeType: getPlaceType(sector),
    rawMessage: original, createdFrom: 'ia',
  };
}

// ─── parseNewsAction SANS appel Gemini supplémentaire ─────────────────────────
// La reformulation se fait via le system prompt Gemini principal (1 seul appel)
function parseNewsAction(message) {
  const original = String(message || '').trim();

  // Nettoyage intelligent du texte brut
  const clean = original
    .replace(/^(?:tu peux |peux-tu |peut-tu |s'?il te pla[iî]t |stp |svp )?/i, '')
    .replace(/^(?:faire |publier |poster |dire |mettre |ecrire |rédiger )?/i, '')
    .replace(/^(?:une |un )?(?:annonce |actualité |actualite |message |news |communication )?/i, '')
    .replace(/^(?:en disant |pour dire |qui dit |que |: ?)/i, '')
    .trim();

  // Titre = première phrase ou 60 premiers caractères
  const firstSentence = clean.split(/[.!?]/)[0].trim();
  const title = firstSentence.length > 5 && firstSentence.length < 80
    ? firstSentence
    : clean.length < 60 ? clean : clean.substring(0, 57) + '...';

  return {
    type: 'news_publish',
    title,
    message: clean,
    rawMessage: original,
    createdFrom: 'ia',
  };
}

function parseEmployeeUpdate(message) {
  const original = String(message || '').trim();
  const nameMatch   = original.match(/(?:modifie|modifier|change|met a jour|mets a jour)\s+([A-Za-zÀ-ÿ''\- ]{2,50}?)(?:\s+son|\s+role|\s+poste|\s+metier|\s+statut|\s+telephone|:|\s+en\s)/i);
  const roleMatch   = original.match(/(?:role|poste)[:\s]+([A-Za-zÀ-ÿ''\- ]{2,50}?)(?:\s|$)/i);
  const jobMatch    = original.match(/(?:metier|job)[:\s]+([A-Za-zÀ-ÿ''\- ]{2,50}?)(?:\s|$)/i);
  const statusMatch = original.match(/(?:statut|contrat)[:\s]+([A-Za-zÀ-ÿ''\- ]{2,30}?)(?:\s|$)/i);
  const phoneMatch  = original.match(/(?:telephone|phone|tel)[:\s]+([0-9+\s]{6,20}?)(?:\s|$)/i);
  return {
    type: 'employee_update', employeeName: nameMatch ? nameMatch[1].trim() : 'Membre à préciser',
    updates: {
      ...(roleMatch   ? { role:  roleMatch[1].trim()   } : {}),
      ...(jobMatch    ? { job:   jobMatch[1].trim()    } : {}),
      ...(statusMatch ? { status: statusMatch[1].trim(), contractType: statusMatch[1].trim() } : {}),
      ...(phoneMatch  ? { phone: phoneMatch[1].trim()  } : {}),
    },
    rawMessage: original, createdFrom: 'ia',
  };
}

async function executeSiteCreate(companyId, uid, userName, sector, action) {
  const ref = db.collection('companies').doc(companyId).collection('sites').doc();
  await ref.set({
    name: action.name, address: action.address || '', description: action.description || '',
    manager: action.manager || '', phone: '', sector, placeType: action.placeType, type: action.placeType,
    gpsMode: 'disabled', radius: 200, archived: false, deleted: false, gpsReady: true,
    gpsNote: 'Contrôle GPS désactivé', createdBy: uid, createdByName: userName,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), source: 'ia',
  });
  return action.name;
}

async function executeNewsPublish(companyId, uid, userName, sector, action) {
  await db.collection('companies').doc(companyId).collection('news').add({
    title: action.title, message: action.message, createdBy: userName, createdByUid: uid,
    createdAt: FieldValue.serverTimestamp(), sector, source: 'ia', pinned: false,
  });
  return action.title;
}

module.exports = {
  detectIntent, extractPendingAction, buildConfirmationMessage,
  parseSiteAction, parseNewsAction, parseEmployeeUpdate,
  executeSiteCreate, executeNewsPublish,
};
